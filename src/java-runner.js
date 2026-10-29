/**
 * 由插件托管启动的 Java 服务（接管 IDEA 起的进程）。
 *
 * 为什么要有这一层：
 *   IDEA 没有对外提供「重启某个 run configuration」的接口，所以插件能做的只有
 *   「按进程快照原样再起一个」。一旦这么做，进程就不归 IDEA 管了，必须自己记账：
 *   谁起的、pid 多少、端口多少、日志写到哪、原来的 argv 是什么——
 *   否则面板既分不清「哪些是 IDEA 起的、哪些是我起的」，也没法只停自己起的那个。
 *
 * 记录存在 ${DSH_HOME}/api-runner-java.json，按项目分桶，每条 run 以服务名（id）为键，
 * 重启前后是同一个 id，面板上看起来就是「这个服务」而不是一堆历史进程。
 *
 * 日志：每个服务一个固定文件 ${DSH_HOME}/java-logs/<id>.log，追加写；
 * 面板的「详情」直接 tail 这个文件，内容与 IDEA 控制台同源（都是 stdout/stderr）。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
    buildRestartArgv,
    compileModule,
    getJavaSnapshot,
    inferMavenModule,
    isAlive,
    killProcessTree,
    resolveMaven,
    spawnService,
    waitPort,
    waitPortFree,
} from './restart.js';
import { normalizeProjectKey } from './util.js';
import { readFileChunk, readFileTail } from './java.js';

const EMPTY = () => ({ version: 1, runs: {} });

/** 服务名：取主类最后一段去掉 Application 后缀，作为稳定 id */
export function serviceIdOf(mainClass) {
    const last = String(mainClass || '').split('.').pop() || 'service';
    return (last.replace(/Application$/, '') || last).replace(/[^\w.-]+/g, '_');
}

export class JavaRunner {
    constructor(options = {}) {
        this.homeDir = options.homeDir || process.env.DSH_HOME || path.join(process.cwd(), '.dsh');
        /** 可选：插件级设置（数据目录可改到别的盘） */
        this.settings = options.settingsStore || null;
        this.setDataDir(options.dataDir || this._preferredDataDir());
        this._doc = undefined;
        this._mtimeMs = -1;
    }

    _preferredDataDir() {
        try {
            return this.settings ? this.settings.dataDir() : this.homeDir;
        } catch {
            return this.homeDir;
        }
    }

    /** 设置改了数据目录后调用：重新指向新目录（老目录里的记录不迁移，只换读写位置） */
    refreshDataDir() {
        const next = this._preferredDataDir();
        if (next !== this.dataDir) this.setDataDir(next);
        return this.dataDir;
    }

    /**
     * 运行数据目录：状态文件与日志都跟着它走。
     * 用户可以在面板「设置」里改成别的盘，不必都堆在默认的 DSH 目录下。
     */
    setDataDir(dir) {
        this.dataDir = dir || this.homeDir;
        this.file = path.join(this.dataDir, 'api-runner-java.json');
        this.logDir = path.join(this.dataDir, 'java-logs');
        this._doc = undefined;
        this._mtimeMs = -1;
    }

    keyOf(cwd) {
        return normalizeProjectKey(cwd) || 'default';
    }

    /**
     * 编译用的 mvn：设置里显式配的 Maven 主路径优先，
     * 否则交给 resolveMaven 自动探测（MAVEN_HOME → PATH → IDEA 自带）。
     */
    configuredMaven(explicit = '') {
        if (explicit) return explicit;
        try {
            const home = this.settings ? String(this.settings.read().mavenHome || '') : '';
            if (home) {
                const candidate = path.join(home, 'bin', process.platform === 'win32' ? 'mvn.cmd' : 'mvn');
                if (fs.existsSync(candidate)) return candidate;
            }
        } catch {
            /* 设置读不到就走自动探测 */
        }
        return '';
    }

    _load() {
        let stat;
        try {
            stat = fs.statSync(this.file);
        } catch {
            this._doc = EMPTY();
            this._mtimeMs = -1;
            return this._doc;
        }
        if (this._doc !== undefined && stat.mtimeMs === this._mtimeMs) return this._doc;
        try {
            const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            this._doc = parsed && typeof parsed === 'object' && parsed.runs && typeof parsed.runs === 'object' ? parsed : EMPTY();
        } catch {
            this._doc = EMPTY();
        }
        this._mtimeMs = stat.mtimeMs;
        return this._doc;
    }

    _save(doc) {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
        fs.renameSync(tmp, this.file);
        this._doc = doc;
        this._mtimeMs = fs.statSync(this.file).mtimeMs;
    }

    _slot(cwd, id) {
        return `${this.keyOf(cwd)}|${id}`;
    }

    /**
     * 某个项目的所有托管记录（含 alive 状态，已退出的也保留，便于看历史日志/再次启动）。
     *
     * `alive` 不能只看 pid 是否存在：进程退出后 pid 可能被系统复用，
     * 于是「已死的服务」被误判成还在跑——面板上显示「插件启动」，
     * 点重启却超时（因为真正那个进程早就没了）。用户反馈过这个问题。
     *
     * 所以 alive 判定改成两步：
     *   1. pid 还在（isAlive）
     *   2. 能查到该 pid 的命令行，且主类名和记录一致
     * 查不到命令行时（权限不足等）保守按「存活」处理，避免误删正在跑的服务。
     */
    runs(cwd) {
        const doc = this._load();
        const key = this.keyOf(cwd);
        const out = [];
        for (const [slot, run] of Object.entries(doc.runs)) {
            if (!slot.startsWith(`${key}|`)) continue;
            out.push({ ...run, alive: isAlive(Number(run.pid)) });
        }
        out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
        return out;
    }

    /**
     * 校验一批 run 的 pid 是否真的还是原来那个进程。
     *
     * 用 jps 的 pid→主类名映射判断，不额外起进程查命令行（更快也更稳）：
     * 如果记录的 pid 在 jps 里对应的是别的主类，说明 pid 已被复用，判定为已退出。
     *
     * @param {Array} runs 托管记录
     * @param {Map<number,string>} pidToMainClass 当前 jps 看到的 pid→主类
     * @returns {Map<string, boolean>} run.id → 是否真的还活着
     */
    verifyAlive(runs, pidToMainClass) {
        const result = new Map();
        if (!(pidToMainClass instanceof Map)) return result;
        /**
         * jps 完全没返回任何进程时**不要**改判。
         * 那种情况多半是 jps 本身出问题（没装 JDK、权限不足、输出解析失败），
         * 拿它当「所有服务都死了」的证据会把正在跑的服务全标成已停止。
         * 只有 jps 确实给出了进程清单，才用它判断某个 pid 是否存在。
         */
        const jpsHasData = pidToMainClass.size > 0;
        for (const run of runs) {
            if (!run.alive) continue;
            const pid = Number(run.pid);
            if (!Number.isFinite(pid) || pid <= 0) continue;
            const actualMain = pidToMainClass.get(pid);
            if (actualMain === undefined) {
                // jps 里有别的进程、唯独没有这个 → 它确实退出了
                if (jpsHasData) result.set(run.id, false);
                continue;
            }
            // pid 在，但主类对不上 → pid 被别的进程复用了
            const expected = String(run.mainClass || '').trim();
            if (expected !== '' && actualMain !== expected) {
                result.set(run.id, false);
            }
        }
        return result;
    }

    runById(cwd, id) {
        const doc = this._load();
        return doc.runs[this._slot(cwd, String(id))] || undefined;
    }

    _put(cwd, run) {
        const doc = this._load();
        doc.runs[this._slot(cwd, run.id)] = run;
        this._save(doc);
    }

    _drop(cwd, id) {
        const doc = this._load();
        delete doc.runs[this._slot(cwd, id)];
        this._save(doc);
    }

    /**
     * 每次启动单独一个日志文件：`<dataDir>/java-logs/<id>/<启动时间>.log`。
     *
     * 以前是一个服务一个文件追加写，结果重启几次以后同一次启动的日志被
     * 后面的启动淹没，翻起来很难受（用户明确反馈过）。分文件之后：
     *   - 面板详情默认打开最新那一段，与 IDEA 控制台「本次运行」对齐；
     *   - 想对比上次启动的报错，切到上一段就行。
     */
    logPathOf(id, at = new Date()) {
        const safeId = String(id).replace(/[^\w.-]+/g, '_');
        const stamp = [
            at.getFullYear(),
            String(at.getMonth() + 1).padStart(2, '0'),
            String(at.getDate()).padStart(2, '0'),
            '-',
            String(at.getHours()).padStart(2, '0'),
            String(at.getMinutes()).padStart(2, '0'),
            String(at.getSeconds()).padStart(2, '0'),
        ].join('');
        return path.join(this.logDir, safeId, `${stamp}.log`);
    }

    /** 某个服务历史上所有的启动日志段，最新的在前 */
    logSegmentsOf(id) {
        const safeId = String(id).replace(/[^\w.-]+/g, '_');
        const dir = path.join(this.logDir, safeId);
        let names;
        try {
            names = fs.readdirSync(dir);
        } catch {
            return [];
        }
        const out = [];
        for (const name of names) {
            if (!/\.log$/i.test(name)) continue;
            const file = path.join(dir, name);
            try {
                const stat = fs.statSync(file);
                if (!stat.isFile()) continue;
                out.push({ name, path: file, size: stat.size, at: stat.mtimeMs, updatedAt: stat.mtime.toISOString() });
            } catch {
                // 正在轮转/被删，跳过
            }
        }
        out.sort((a, b) => b.at - a.at);
        return out;
    }

    // ---------------------------------------------------------------- 启动
    /**
     * 接管启动：按 pid 的进程快照，先编译，再杀掉原进程，最后由插件拉起新进程。
     * 顺序是刻意的：编译失败时绝不动原进程，避免「代码没编过、服务也停了」。
     *
     * @param {{pid:number, id?:string, port?:number, compile?:boolean, debug?:'port'|'none'|'keep',
     *          mvn?:string, timeoutMs?:number}} options
     */
    async start(cwd, options = {}) {
        const sourcePid = Number(options.pid);
        if (!Number.isInteger(sourcePid) || sourcePid <= 0) {
            return { ok: false, code: 'MISSING_PID', message: '需要提供要接管的 Java 进程 pid（面板里「关闭并接管」会自动带上）' };
        }
        const snapshot = await getJavaSnapshot(sourcePid);
        if (!snapshot.ok) return { ok: false, code: 'SNAPSHOT_FAILED', message: snapshot.message };

        const id = String(options.id || serviceIdOf(snapshot.mainClass));
        const module = inferMavenModule(snapshot.classPath);
        const port = Number(options.port) || Number(snapshot.systemProperties?.['server.port']) || 0;
        const logPath = this.logPathOf(id);
        // 1) 编译（默认开启）：改完代码直接接管，才叫「写完代码就能重启」
        let compile;
        if (options.compile === false) {
            compile = { ok: true, skipped: true };
        } else if (!module) {
            compile = { ok: true, skipped: true, note: 'classpath 里没有 target/classes，无法推断 Maven 模块，跳过编译' };
        } else {
            const mvn = await resolveMaven(this.configuredMaven(String(options.mvn || '')));
            compile = await compileModule({
                mvn,
                rootDir: module.rootDir,
                artifactId: module.artifactId,
                selector: module.selector,
                javaHome: snapshot.javaHome,
                timeoutMs: Number(options.compileTimeoutMs) || 300_000,
            });
            compile.module = module;
            if (!compile.ok) {
                return {
                    ok: false,
                    code: compile.code || 'COMPILE_FAILED',
                    message: `编译失败，未动原进程：${compile.message}`,
                    compile,
                };
            }
        }

        // 2) 结束原进程并等端口释放（端口没放就开始拉新进程，会误判「新进程已就绪」）
        const killed = await killProcessTree(sourcePid);
        if (!killed.ok) return { ok: false, code: 'KILL_FAILED', message: killed.message, compile };
        const freed = port > 0 ? await waitPortFree('127.0.0.1', port, { timeoutMs: 20_000 }) : { ok: true, waitedMs: 0 };

        // 3) 用快照参数拉起新进程，打上来源标记，便于下次扫描区分是谁起的
        const built = buildRestartArgv(snapshot, {
            debug: options.debug || 'port',
            debugPort: Number(options.debugPort) || 0,
            extraJvmArgs: [`-DdshApiRunner.runId=${id}`],
        });
        this._ensureLogHeader(logPath, `接管 pid ${sourcePid}（${id}）`);
        const spawned = await spawnService({ javaExe: snapshot.javaExe, argv: built.argv, cwd: snapshot.cwd, logPath });
        if (!spawned.ok) return { ok: false, code: 'SPAWN_FAILED', message: spawned.message, compile };

        const record = {
            id,
            name: id,
            pid: spawned.pid,
            port,
            debugPort: built.debugPort || 0,
            mainClass: snapshot.mainClass,
            programArgs: snapshot.programArgs,
            jvmArgs: snapshot.jvmArgs,
            argv: built.argv,
            javaExe: snapshot.javaExe,
            javaHome: snapshot.javaHome,
            cwd: snapshot.cwd,
            logPath,
            sourcePid,
            projectKey: this.keyOf(cwd),
            module: module || null,
            startedAt: new Date().toISOString(),
            lastError: '',
        };
        this._put(cwd, record);

        // 4) 等端口就绪；起来了才算成功，起不来把日志尾巴带回去
        const health = await this._awaitReady(record, Number(options.timeoutMs) || 120_000, cwd);
        return {
            ok: health.ok,
            code: health.ok ? undefined : 'START_TIMEOUT',
            id,
            pid: spawned.pid,
            port: record.port || port,
            ports: record.ports || [],
            logPath,
            health,
            compile,
            portFreed: freed,
            note: health.ok
                ? `已由插件启动 ${id}（pid ${spawned.pid}${record.port || port ? `，端口 ${record.port || port}` : ''}），日志：${logPath}`
                : `进程已拉起（pid ${spawned.pid}）但 ${health.waitedMs}ms 内端口没就绪，看日志：${logPath}`,
        };
    }

    _ensureLogHeader(logPath, reason) {
        try {
            fs.mkdirSync(path.dirname(logPath), { recursive: true });
            fs.appendFileSync(logPath, `\n==== ${new Date().toISOString()} ${reason} ====\n`, 'utf8');
        } catch {
            /* 目录建不了就让 spawn 去报错 */
        }
    }

    /**
     * 等端口就绪。
     * 配了端口就等 TCP 监听；没配（端口常写在配置中心或外部配置文件里，
     * 进程参数里读不到）就只确认进程活着，同时补探一次真实监听端口，
     * 否则接管后 run 记录里 ports/httpPort 是空的，面板上这个服务看起来像没起来。
     */
    async _awaitReady(record, timeoutMs, cwd) {
        const port = Number(record.port) || 0;
        if (port > 0) {
            const waited = await waitPort('127.0.0.1', port, { timeoutMs });
            return { ok: waited.ok, waitedMs: waited.waitedMs, checks: [{ kind: 'tcp', ok: waited.ok, detail: `127.0.0.1:${port}` }] };
        }
        const startedAt = Date.now();
        while (Date.now() - startedAt < Math.min(timeoutMs, 15_000)) {
            if (!isAlive(Number(record.pid))) break;
            await new Promise((resolve) => setTimeout(resolve, 300));
        }
        const alive = isAlive(Number(record.pid));
        // 启动成功就先把回填挂到后台：Spring 业务端口通常在进程起来后十几秒才监听，
        // 此刻同步探一次多半只有 debug 端口，不能就此认定「没有端口」。
        if (alive) {
            await this._backfillPorts(record, cwd);
            this._scheduleBackfill(record.pid, cwd);
        }
        return { ok: alive, waitedMs: Date.now() - startedAt, checks: [{ kind: 'process', ok: alive, detail: `pid ${record.pid}` }] };
    }

    /**
     * 启动后在后台继续补探端口，直到探到 HTTP 端口或超时。
     * 面板每 5 秒拉一次 java 列表，回填写进托管记录后下一次拉取就能看到端口。
     * 不阻塞 restart/start 的返回（编译+启动已经够慢了）。
     */
    _scheduleBackfill(pid, cwd, options = {}) {
        const target = Number(pid);
        if (!Number.isInteger(target) || target <= 0) return;
        const deadline = Date.now() + (Number(options.timeoutMs) || 90_000);
        const tick = async () => {
            if (Date.now() > deadline || !isAlive(target)) return;
            const record = Object.values(this._load().runs).find((run) => Number(run.pid) === target);
            if (!record) return;
            if (Number(record.httpPort) > 0) return;
            await this._backfillPorts(record, cwd);
            const fresh = Object.values(this._load().runs).find((run) => Number(run.pid) === target);
            if (fresh && Number(fresh.httpPort) > 0) return;
            const timer = setTimeout(tick, 3_000);
            if (typeof timer.unref === 'function') timer.unref();
        };
        const first = setTimeout(tick, 8_000);
        if (typeof first.unref === 'function') first.unref();
    }

    /**
     * 从真实监听端口里认出业务端口，写回 run 记录。
     * 复用 java.js 的扫描逻辑（netstat/lsof → probeHttp 判哪个讲 HTTP），
     * 只补 record 上缺的字段，失败就当没探到——不影响「启动成功」这个结论。
     *
     * 注意：桶要用**项目 cwd**（调用方传进来），不能用 record.cwd ——
     * record.cwd 是进程的工作目录，可能只是项目里的某个子模块，与项目根不同，
     * 拿它算 projectKey 会把回填写进另一个桶，面板上依然看不到端口。
     */
    async _backfillPorts(record, cwd) {
        try {
            const { listJavaProcesses } = await import('./java.js');
            const all = await listJavaProcesses();
            const item = (all.processes || []).find((p) => Number(p.pid) === Number(record.pid));
            if (!item) return;
            const httpPort = Number(item.httpPort) || 0;
            const ports = Array.isArray(item.ports) ? item.ports : [];
            if (!httpPort && ports.length === 0) return;
            const next = {
                ...record,
                port: httpPort || Number(record.port) || 0,
                ports,
                httpPort,
                primaryPort: Number(item.primaryPort) || httpPort || 0,
                sentinelPort: Number(item.sentinelPort) || 0,
            };
            this._put(cwd || record.projectKey || '', next);
            // 调用方拿的是同一个对象引用，回填后返回体里也能看到端口
            Object.assign(record, next);
        } catch {
            /* 探测失败不影响启动结论 */
        }
    }

    // ---------------------------------------------------------------- 停止 / 重启
    /** 只允许停插件自己起的进程 */
    /**
     * 忘掉一条接管记录（不杀进程，只删记账）。
     *
     * 为什么需要：`stop()` 会保留记录（alive=false），这样面板上还能看历史日志、
     * 也能再启动。但如果用户已经在 IDEA 里把进程关掉了，面板上仍留着一条
     * 「已停止」的幽灵条目，点它什么也做不了——用户反馈过这个困扰。
     *
     * 安全约束：**进程还活着时拒绝**，否则会删掉记账、进程却还在跑，
     * 变成真正的失控状态。要先 stop 再 forget。
     */
    async forget(cwd, idOrPid) {
        const key = String(idOrPid || '');
        const doc = this._load();
        const slotKey = doc.runs[this._slot(cwd, key)] ? this._slot(cwd, key) : undefined;
        const found = slotKey
            ? { slot: slotKey, run: doc.runs[slotKey] }
            : Object.entries(doc.runs)
                .filter(([slot]) => slot.startsWith(`${this.keyOf(cwd)}|`))
                .map(([slot, run]) => ({ slot, run }))
                .find((item) => String(item.run.pid) === key || item.run.id === key);
        if (!found) return { ok: false, code: 'RUN_NOT_FOUND', message: `没有由插件启动的 ${key}` };

        // 进程还活着就拒绝，避免「记录没了、进程还在跑」的失控状态
        if (isAlive(Number(found.run.pid))) {
            return {
                ok: false,
                code: 'STILL_RUNNING',
                message: `${found.run.id}（pid ${found.run.pid}）还在运行，请先停止再移除记录`,
            };
        }

        delete doc.runs[found.slot];
        this._save(doc);
        return {
            ok: true,
            id: found.run.id,
            pid: found.run.pid,
            message: `已移除 ${found.run.id} 的接管记录`,
        };
    }

    async stop(cwd, idOrPid) {
        const key = String(idOrPid || '');
        const doc = this._load();
        const slotKey = doc.runs[this._slot(cwd, key)] ? this._slot(cwd, key) : undefined;
        const entry = slotKey
            ? doc.runs[slotKey]
            : Object.entries(doc.runs).find(([slot, run]) => slot.startsWith(`${this.keyOf(cwd)}|`) && String(run.pid) === key)?.[1];
        if (!entry) return { ok: false, code: 'RUN_NOT_FOUND', message: `没有由插件启动的 ${key}；IDEA 起的进程请在 IDEA 里停止（或先接管）` };

        const killed = await killProcessTree(Number(entry.pid));
        if (killed.ok) {
            // 保留记录（alive 会变 false），面板上还能看历史日志、再次启动
            this._put(cwd, { ...entry, stoppedAt: new Date().toISOString() });
        }
        return {
            ok: killed.ok,
            code: killed.ok ? undefined : 'KILL_FAILED',
            id: entry.id,
            pid: entry.pid,
            message: killed.ok ? `已停止 ${entry.id}（pid ${entry.pid}）` : killed.message,
        };
    }

    /** 重启插件自己起的进程：用记录里的 argv 原样再起（重新编译一遍） */
    async restart(cwd, idOrPid, options = {}) {
        const key = String(idOrPid || '');
        const entry = this.runById(cwd, key)
            || Object.values(this._load().runs).find((run) => String(run.pid) === key && this.keyOf(cwd) === run.projectKey);
        if (!entry) return { ok: false, code: 'RUN_NOT_FOUND', message: `没有由插件启动的 ${key}` };

        let compile = { ok: true, skipped: true };
        if (options.compile !== false && entry.module) {
            const mvn = await resolveMaven(this.configuredMaven(String(options.mvn || '')));
            /**
             * 编译超时默认 3 分钟（原 5 分钟）。
             * 单模块增量编译通常 10–40 秒；给 5 分钟会让用户以为卡死。
             * 需要更久时显式传 compileTimeoutMs。
             */
            compile = await compileModule({
                mvn,
                rootDir: entry.module.rootDir,
                artifactId: entry.module.artifactId,
                selector: entry.module.selector,
                javaHome: entry.javaHome,
                timeoutMs: Number(options.compileTimeoutMs) || 180_000,
            });
            if (!compile.ok) return { ok: false, code: compile.code || 'COMPILE_FAILED', message: `编译失败，未重启：${compile.message}`, compile };
        }

        if (isAlive(Number(entry.pid))) {
            const killed = await killProcessTree(Number(entry.pid));
            if (!killed.ok) return { ok: false, code: 'KILL_FAILED', message: killed.message, compile };
            /**
             * 等端口释放，但**别等满 20 秒**：
             * 端口通常 1–3 秒就释放；真被别的进程占着时，等再久也没用，
             * 应该尽快返回并告诉用户「端口还被占用」，而不是静默超时。
             */
            if (entry.port) {
                const freed = await waitPortFree('127.0.0.1', Number(entry.port), { timeoutMs: 8_000 });
                if (!freed || freed.ok === false) {
                    return {
                        ok: false,
                        code: 'PORT_BUSY',
                        id: entry.id,
                        message: `端口 ${entry.port} 在 8 秒内没有释放，可能被别的进程占用了（原服务已停止）。`,
                        compile,
                    };
                }
            }
        }

        // 每次重启开一个新日志段，历史启动记录不被覆盖
        const logPath = this.logPathOf(entry.id);
        const spawned = await spawnService({ javaExe: entry.javaExe, argv: entry.argv, cwd: entry.cwd, logPath });
        if (!spawned.ok) return { ok: false, code: 'SPAWN_FAILED', message: spawned.message, compile };

        const record = { ...entry, pid: spawned.pid, logPath, argv: entry.argv, startedAt: new Date().toISOString(), stoppedAt: '' };
        this._put(cwd, record);
        const health = await this._awaitReady(record, Number(options.timeoutMs) || 120_000, cwd);
        return { ok: health.ok, code: health.ok ? undefined : 'START_TIMEOUT', id: entry.id, pid: spawned.pid, port: record.port || 0, ports: record.ports || [], health, compile, logPath };
    }

    // ---------------------------------------------------------------- 从保存的配置启动
    /**
     * 不依赖 IDEA 进程启动：用面板里保存的服务定义（主类 / classpath / JVM 参数）直接拉起。
     *
     * 场景：用户不想每次都先在 IDEA 里点 Run 才能接管，于是把一次接管的快照存下来（「保存服务」），
     * 以后插件可以自己起。要求保存时 classpath 完整（从 getJavaSnapshot 拿到的那份）。
     */
    async startSaved(cwd, saved, options = {}) {
        const id = String(saved.id || serviceIdOf(saved.mainClass));
        if (!saved.mainClass || !saved.classPath) {
            return { ok: false, code: 'SAVED_INCOMPLETE', message: `保存的 ${id} 缺少主类或 classpath，无法独立启动（请重新接管一次并保存）` };
        }
        // 老配方里存的 module 可能来自旧版本推断（reactor 根取错、没有 selector），
        // 所以优先用 classpath 重新推断——classpath 一直在，推断逻辑是当前版本的。
        // 推断不出来（例如 classpath 里没有 target/classes）才退回配方里存的。
        const module = inferMavenModule(saved.classPath)
            || (saved.module && saved.module.artifactId
                ? { rootDir: saved.module.rootDir, artifactId: saved.module.artifactId, selector: saved.module.selector }
                : undefined);
        const port = Number(options.port) || Number(saved.port) || 0;

        let compile = { ok: true, skipped: true };
        if (options.compile !== false && module) {
            const mvn = await resolveMaven(this.configuredMaven(String(options.mvn || '')));
            compile = await compileModule({
                mvn,
                rootDir: module.rootDir,
                artifactId: module.artifactId,
                selector: module.selector,
                javaHome: saved.javaHome,
                timeoutMs: Number(options.compileTimeoutMs) || 300_000,
            });
            compile.module = module;
            if (!compile.ok) return { ok: false, code: compile.code || 'COMPILE_FAILED', message: `编译失败，未启动：${compile.message}`, compile };
        }

        // 端口被占（比如 IDEA 里那个还开着）就先说清楚，别拉起来又撞端口
        if (port > 0) {
            const busy = await waitPort('127.0.0.1', port, { timeoutMs: 300 });
            if (busy.ok) {
                return {
                    ok: false,
                    code: 'PORT_IN_USE',
                    message: `端口 ${port} 已被占用（可能 IDEA 里的 ${id} 还在跑）。先在 IDEA 里停掉，或直接对它点「接管启动」。`,
                    compile,
                };
            }
        }

        const built = buildRestartArgv({
            javaExe: saved.javaExe,
            classPath: saved.classPath,
            mainClass: saved.mainClass,
            jvmArgs: saved.jvmArgs,
            programArgs: saved.programArgs,
        }, {
            debug: options.debug || 'port',
            debugPort: Number(options.debugPort) || 0,
            extraJvmArgs: [`-DdshApiRunner.runId=${id}`],
        });
        const logPath = this.logPathOf(id);
        this._ensureLogHeader(logPath, `按保存的配置启动 ${id}`);
        const spawned = await spawnService({ javaExe: saved.javaExe, argv: built.argv, cwd: saved.cwd, logPath });
        if (!spawned.ok) return { ok: false, code: 'SPAWN_FAILED', message: spawned.message, compile };

        const record = {
            id,
            name: id,
            pid: spawned.pid,
            port,
            debugPort: built.debugPort || 0,
            mainClass: saved.mainClass,
            programArgs: saved.programArgs || [],
            jvmArgs: saved.jvmArgs || [],
            argv: built.argv,
            javaExe: saved.javaExe,
            javaHome: saved.javaHome || '',
            cwd: saved.cwd,
            logPath,
            sourcePid: 0,
            savedStart: true,
            projectKey: this.keyOf(cwd),
            module: module || null,
            startedAt: new Date().toISOString(),
            lastError: '',
        };
        this._put(cwd, record);
        const health = await this._awaitReady(record, Number(options.timeoutMs) || 120_000, cwd);
        return {
            ok: health.ok,
            code: health.ok ? undefined : 'START_TIMEOUT',
            id,
            pid: spawned.pid,
            port: record.port || port,
            ports: record.ports || [],
            logPath,
            health,
            compile,
            note: health.ok
                ? `已按保存的配置启动 ${id}（pid ${spawned.pid}${record.port || port ? `，端口 ${record.port || port}` : ''}）`
                : `进程已拉起（pid ${spawned.pid}）但 ${health.waitedMs}ms 内端口没就绪，看日志：${logPath}`,
        };
    }

    // ---------------------------------------------------------------- 日志
    /**
     * 读托管服务的日志（面板「详情」用）。
     * 与 LogReader 的区别：这里不存游标，每次都按传入偏移取增量，
     * 因为同一个文件可能同时被面板轮询和模型读取。
     *
     * 首屏（没给 fromOffset）默认只取最后 N 行——与 IDEA 控制台一致：
     * 打开就看到最新的几行，而不是从头翻几百 KB。
     */
    logs(cwd, id, options = {}) {
        const key = String(id || '');
        const entry = this.runById(cwd, key);
        const segments = this.logSegmentsOf(entry?.id || key);

        // 选了历史某一段就用它，否则用当前记录指向的那一段
        let logPath = entry?.logPath || '';
        const wanted = String(options.source || '');
        if (wanted) {
            const hit = segments.find((item) => item.path === wanted || item.name === wanted);
            if (hit) logPath = hit.path;
        }
        if (!logPath) logPath = segments[0]?.path || this.logPathOf(entry?.id || key);

        const lines = Number(options.lines) || 200;
        const hasFrom = Number.isFinite(Number(options.fromOffset)) && Number(options.fromOffset) >= 0;
        const chunk = hasFrom
            ? readFileChunk(logPath, { fromOffset: Number(options.fromOffset), maxBytes: options.maxBytes })
            : readFileTail(logPath, { lines });

        const alive = entry ? isAlive(Number(entry.pid)) : false;
        return {
            ...chunk,
            id: entry?.id || key,
            segments: segments.map((item) => ({
                key: item.path,
                label: item.name.replace(/\.log$/i, ''),
                path: item.path,
                size: item.size,
                updatedAt: item.updatedAt,
                current: item.path === entry?.logPath,
            })),
            source: logPath,
            alive,
            pid: entry?.pid || 0,
            port: entry?.port || 0,
            note: chunk.ok ? '' : `日志文件还不存在（服务没启动过，或日志还没写）：${logPath}`,
        };
    }
}
