/**
 * 重启「IDEA 启动的 Java 服务」。
 *
 * 背景：IDEA 没有对外暴露「重启某个 run configuration」的能力，所以这里走
 * 「命令行快照回放」：从运行中的进程里读出它真实的 classpath / 主类 / 工作目录
 * （jcmd 提供），kill 掉旧进程，再用同一套参数重新拉起一个新进程。
 *
 * 两个必须处理的差异：
 *   1. IDEA 调试启动的参数是 `-agentlib:jdwp=...,suspend=y,server=n` —— JVM 反向
 *      连 IDEA 的监听端口，IDEA 那边一停止监听，原样重放会让新 JVM 卡在
 *      suspend=y 等调试器。所以默认改成 `server=y,suspend=n`（自己开一个端口），
 *      可以在 IDEA 里用 Remote JVM Debug 再挂上去；也可以整体去掉。
 *   2. IDEA 注入的 `-javaagent:...captureAgent/debugger-agent.jar=file://...props`
 *      依赖那一次调试会话的临时文件，必须去掉。
 *
 * 日志：新进程的 stdout/stderr 写到文件（追加），不再受 IDEA 控制台约束。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { getJavaSnapshot } from './java.js';

const isWindows = process.platform === 'win32';

/** 判断某个参数是否是调试相关（需要被剥离/替换） */
function isDebugArg(arg) {
    if (/^-agentlib:jdwp=/.test(arg)) return true;
    if (/^-Xrunjdwp/.test(arg)) return true;
    if (/^-Xdebug/.test(arg)) return true;
    // IDEA 的捕获 agent，file:// 指向上一次调试会话的临时 props
    if (/^-javaagent:.*captureAgent[\\/]debugger-agent\.jar/.test(arg)) return true;
    // IDEA 协程调试相关的 -D，重放无害但没意义，去掉更干净
    if (/^-Dkotlinx\.coroutines\.debug\./.test(arg)) return true;
    if (/^-Ddebugger\.(agent|async)\./.test(arg)) return true;
    return false;
}

/** 从 jdwp 参数里取端口 */
function jdwpPort(arg) {
    const match = /address=([^,\s]*?):(\d+)/.exec(arg);
    return match ? Number(match[2]) : 0;
}

/** 选一个空闲的调试端口（默认避开原端口，+1 试到 +20） */
function pickDebugPort(base) {
    const start = base > 0 ? base : 5005;
    return start;
}

/**
 * 生成重启用的 argv。
 * @param {{javaExe:string, classPath:string, mainClass:string, programArgs:string[], jvmArgs:string[]}} snapshot
 * @param {{debug?:'port'|'none'|'keep', debugPort?:number, extraJvmArgs?:string[]}} options
 */
export function buildRestartArgv(snapshot, options = {}) {
    const mode = options.debug || 'port';
    const kept = [];
    let originalDebugPort = 0;
    for (const arg of snapshot.jvmArgs || []) {
        if (/^-agentlib:jdwp=/.test(arg) || /^-Xrunjdwp/.test(arg)) {
            originalDebugPort = originalDebugPort || jdwpPort(arg);
            continue;
        }
        if (isDebugArg(arg)) continue;
        kept.push(arg);
    }

    const argv = [];
    if (mode === 'port') {
        const port = Number(options.debugPort) || pickDebugPort(originalDebugPort);
        argv.push('-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:' + port);
    } else if (mode === 'keep' && originalDebugPort) {
        // 保留端口但改成等待连接方向，避免 suspend=y 卡死
        argv.push('-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:' + originalDebugPort);
    }
    argv.push(...kept);
    argv.push(...(options.extraJvmArgs || []));
    argv.push('-classpath', snapshot.classPath);
    argv.push(snapshot.mainClass);
    argv.push(...(snapshot.programArgs || []));
    return { argv, debugPort: mode === 'none' ? 0 : Number(options.debugPort) || originalDebugPort };
}

// ---- Maven 探测与编译 ----

/** 从 IDEA 进程路径推断它自带的 Maven（用户环境里常用这套，没装独立 Maven 时唯一选择） */
async function ideaBundledMaven() {
    const ideaPath = await detectIdeaApp();
    if (!ideaPath) return '';
    // 候选安装根：
    //   Windows / Linux 传进来的是 .../bin/idea64.exe 或 .../bin/idea.sh，上两级就是安装根；
    //   macOS 传进来的是 /Applications/IntelliJ IDEA.app，Maven 在 Contents/ 下面。
    const bases = [
        path.resolve(ideaPath, '..'),
        path.resolve(ideaPath, '..', '..'),
        path.join(ideaPath, 'Contents'),
    ];
    for (const base of bases) {
        const candidate = path.join(base, 'plugins', 'maven', 'lib', 'maven3', 'bin', isWindows ? 'mvn.cmd' : 'mvn');
        if (fileExists(candidate)) return candidate;
    }
    return '';
}

/** 找本机 IDEA 的可执行文件路径（各平台分别试） */
async function detectIdeaApp() {
    const commands = isWindows
        ? [['powershell', ['-NoProfile', '-Command', "(Get-Process idea64 -ErrorAction SilentlyContinue | Select-Object -First 1).Path"]]]
        : process.platform === 'darwin'
            ? [
                ['ps', ['-Ao', 'comm']],
                ['mdfind', ['kMDItemCFBundleIdentifier == "com.jetbrains.intellij"']],
            ]
            : [['ps', ['-Ao', 'args']]];
    for (const [cmd, args] of commands) {
        const out = await new Promise((resolve) => {
            execFile(cmd, args, { timeout: 6000, windowsHide: true }, (error, stdout) => resolve(error ? '' : String(stdout || '')));
        });
        const found = pickIdeaPath(out);
        if (found) return found;
    }
    return '';
}

/** 从 ps/mdfind/powershell 的输出里挑出 IDEA 路径 */
function pickIdeaPath(text) {
    const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
        // macOS 的 ps comm 只给可执行文件路径，形如 /Applications/IntelliJ IDEA.app/Contents/MacOS/idea
        const mac = /^(.*?IntelliJ IDEA[^/]*\.app)\/Contents\//.exec(line);
        if (mac) return mac[1];
        // Windows 的 powershell 直接给整行路径（可能含空格），先按整行试
        if (path.isAbsolute(line) && /[\\/]bin[\\/]idea64\.exe$/i.test(line)) return line;
        // Linux 的 ps args 一行里有多个字段：第一个可执行文件就是 idea 启动脚本
        const first = line.split(/\s+/)[0] || '';
        if (path.isAbsolute(first) && /[\\/]bin[\\/](idea|idea\.sh|idea64\.exe)$/i.test(first)) return first;
    }
    return '';
}

function fileExists(file) {
    try {
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}

/** 按优先级找 mvn：显式配置 > MAVEN_HOME > M2_HOME > PATH > IDEA 自带 */
export async function resolveMaven(explicit = '') {
    if (explicit) return fileExists(explicit) ? explicit : '';
    for (const key of ['MAVEN_HOME', 'M2_HOME']) {
        const home = process.env[key];
        if (!home) continue;
        const candidate = path.join(home, 'bin', isWindows ? 'mvn.cmd' : 'mvn');
        if (fileExists(candidate)) return candidate;
    }
    const onPath = await new Promise((resolve) => {
        execFile(isWindows ? 'where' : 'which', ['mvn'], { timeout: 5000, windowsHide: true }, (error, stdout) => {
            if (error) return resolve('');
            const first = String(stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];
            resolve(first || '');
        });
    });
    if (onPath && fileExists(onPath)) return onPath;
    return ideaBundledMaven();
}

/**
 * 从 classpath 反推 Maven 模块：第一条 `.../<模块>/target/classes` 就是模块目录；
 * 再向上找含 `<module>` 的 pom 作为 reactor 根。
 */
export function inferMavenModule(classPath) {
    const entries = String(classPath || '').split(isWindows ? ';' : ':').filter(Boolean);
    for (const entry of entries) {
        const normalized = entry.replace(/[\\/]+/g, '/');
        const match = /^(.*)\/target\/(classes|test-classes)(\/|$)/.exec(normalized);
        if (!match) continue;
        const moduleDir = match[1];
        const pomFile = path.join(moduleDir, 'pom.xml');
        if (!fileExists(pomFile)) continue;
        const artifactId = readArtifactId(pomFile) || path.basename(moduleDir);
        // 向上找 reactor 根：要取**最外层**的聚合 pom，不能取第一个带 <module> 的。
        // 反例：classpath 指向 <项目>/<聚合模块>/<子模块> 时，
        // 若停在聚合模块，-pl ... -am 就编不到同级的兄弟模块，
        // 那些模块只能从本地仓库拿旧 jar，于是报「找不到符号」。
        let rootDir = moduleDir;
        let cursor = path.dirname(moduleDir);
        for (let depth = 0; depth < 8; depth += 1) {
            const pom = path.join(cursor, 'pom.xml');
            if (!fileExists(pom)) break;
            const text = readText(pom);
            if (/<module>/.test(text)) rootDir = cursor;
            const parent = path.dirname(cursor);
            if (parent === cursor) break;
            cursor = parent;
        }
        // -pl 的取值：Maven 会把裸字符串当**相对 reactor 根的路径**，所以不能直接给 artifactId。
        // 模块可能嵌在多层聚合里（root → modules → modules-xxx），
        // 必须给「相对根目录的路径」，否则报 Could not find the selected project in the reactor。
        const relative = path.relative(rootDir, moduleDir).split(path.sep).join('/');
        return { moduleDir, artifactId, rootDir, pomFile, selector: relative || artifactId };
    }
    return undefined;
}

function readText(file) {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return '';
    }
}

function readArtifactId(pomFile) {
    const text = readText(pomFile);
    // 只看当前 project 直接子层的 artifactId（parent 里的不取）
    const withoutParent = text.replace(/<parent>[\s\S]*?<\/parent>/, '');
    const match = /<artifactId>([^<]+)<\/artifactId>/.exec(withoutParent);
    return match ? match[1].trim() : '';
}

/**
 * 探测编译该用的 Maven settings 与本地仓库。
 *
 * 背景：企业内部依赖通常只存在于用户自定义的 localRepository（IDEA 里配的那份），
 * 而插件解析到的 mvn——尤其是 IDEA 自带的——不会去读它，于是报
 * 「Could not find artifact xxx」。这里按优先级把 settings.xml / localRepository 找出来，
 * 转成 `-s` / `-Dmaven.repo.local` 传给 mvn：
 *   1. 项目（及 reactor 根上一级）的 .idea/workspace.xml 里 MavenGeneralSettings
 *      的 userSettingsFile / localRepository——IDEA 用哪份，编译就用哪份；
 *   2. mvn 自己的 conf/settings.xml（MAVEN_HOME/conf/settings.xml）。
 */
export function detectMavenSettings(rootDir, mvn = '') {
    const result = { settingsFile: '', localRepository: '', mavenHome: '', source: '' };
    // IDEA 项目可能开在任意一层（开在仓库根，也可能开在某个子目录）；
    // reactor 可能深 4-5 层，往上找 6 层，与 inferMavenModule 找 reactor 根的深度一致
    const ideaFiles = [];
    let cursor = rootDir;
    for (let depth = 0; depth < 6 && cursor; depth += 1) {
        ideaFiles.push(path.join(cursor, '.idea', 'workspace.xml'));
        const parent = path.dirname(cursor);
        if (parent === cursor) break;
        cursor = parent;
    }
    for (const file of ideaFiles) {
        if (!fileExists(file)) continue;
        const text = readText(file);
        const pick = (name) => {
            const match = new RegExp(`<option name="${name}"\\s+value="([^"]+)"`).exec(text);
            return match ? match[1].trim() : '';
        };
        const settings = pick('userSettingsFile');
        const repo = pick('localRepository');
        const mavenHome = pick('customMavenHome');
        if (!settings && !repo && !mavenHome) continue;
        if (!/<MavenGeneralSettings>/.test(text)) continue;
        result.settingsFile = settings && fileExists(settings) ? settings : '';
        result.localRepository = repo;
        // IDEA 配了 customMavenHome 时，用它来编译——这就是 IDE 里 Build 用的那份 mvn
        if (mavenHome) {
            const bin = path.join(mavenHome, 'bin', isWindows ? 'mvn.cmd' : 'mvn');
            if (fileExists(bin)) result.mavenHome = mavenHome;
        }
        result.source = file;
        break;
    }
    // settings.xml 里通常也写了 <localRepository>（IDEA 只填 userSettingsFile 时兜底）
    if (result.settingsFile && !result.localRepository) {
        // 去掉 XML 注释再匹配，避免吃到文档里的示例 `<localRepository>/path/to/local/repo</localRepository>`
        const text = readText(result.settingsFile).replace(/<!--[\s\S]*?-->/g, '');
        const match = /<localRepository>([^<]+)<\/localRepository>/.exec(text);
        if (match) result.localRepository = match[1].trim();
    }
    if (!result.settingsFile && mvn) {
        // mvn 安装目录的 conf/settings.xml：<mvn home>/bin/mvn.cmd → <mvn home>/conf/settings.xml
        const conf = path.resolve(path.dirname(path.dirname(mvn)), 'conf', 'settings.xml');
        if (fileExists(conf)) {
            result.settingsFile = conf;
            result.source = conf;
        }
    }
    return result;
}

/** 把探测结果转成 mvn 命令行参数 */
export function mavenSettingsArgs(detect) {
    const args = [];
    if (detect.settingsFile) args.push('-s', detect.settingsFile);
    if (detect.localRepository) args.push(`-Dmaven.repo.local=${detect.localRepository}`);
    return args;
}

/**
 * 解码子进程输出。
 * Maven 在中文 Windows 上按 GBK（平台默认编码）输出，Node 默认按 UTF-8 解码会变成乱码，
 * 于是「找不到符号」这类关键信息全是问号。先按 UTF-8 严格解码，失败再退 GBK。
 */
function decodeOutput(buffer) {
    if (!buffer) return '';
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer), 'utf8');
    if (buf.length === 0) return '';
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
        try {
            return new TextDecoder('gbk').decode(buf);
        } catch {
            return buf.toString('utf8');
        }
    }
}

/** 执行 Maven 增量编译 */
export async function compileModule({ mvn, rootDir, artifactId, selector = '', timeoutMs = 300_000, extraArgs = [], javaHome = '' }) {
    if (!mvn) return { ok: false, code: 'MVN_NOT_FOUND', message: '找不到 mvn，请在面板里指定 Maven 路径（或设置 MAVEN_HOME）' };
    if (!rootDir || !artifactId) return { ok: false, code: 'MODULE_UNKNOWN', message: '无法从 classpath 推断 Maven 模块，请手动指定' };
    // settings 先探测再拼参数：私有依赖只在用户自定义仓库里时，不传这个 mvn 必失败
    const settings = detectMavenSettings(rootDir, mvn);
    const settingsArgs = mavenSettingsArgs(settings);
    // -pl 优先用相对 reactor 根的路径（模块嵌在多层聚合里时，裸 artifactId 会找不到）
    const args = ['-B', '-q', '-pl', selector || artifactId, '-am', 'compile', '-DskipTests', ...settingsArgs, ...extraArgs];
    const startedAt = Date.now();
    // 编译 JDK 跟着运行进程走，避免「编译用 17、运行用 11」这类错配
    const env = { ...process.env };
    if (javaHome) env.JAVA_HOME = javaHome;
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            child.kill();
            resolve({ ok: false, code: 'COMPILE_TIMEOUT', message: `编译超时（>${timeoutMs}ms）`, durationMs: Date.now() - startedAt });
        }, timeoutMs);
        // Windows 上 .cmd 不是可执行文件，只能交给 cmd.exe。两条硬约束凑在一起很别扭：
        //   1) 开 shell:true 会触发 Node 的 DEP0190 警告，且 mvn 路径含空格会被截断；
        //   2) execFile 默认会给每个参数加引号，cmd /c 又会自己剥一层，结果引号翻倍。
        // 所以整条命令行自己拼好，配 windowsVerbatimArguments 让 Node 原样传给 cmd.exe。
        // 双引号包裹是 cmd /c 的固定要求：cmd /c ""C:\a b\x.cmd" -B ..."
        const quote = (value) => (/[\s"]/.test(value) ? `"${value}"` : value);
        const cmdLine = `""${mvn}" ${args.map(quote).join(' ')}"`;
        const [file, fileArgs, verbatim] = isWindows && /\.cmd$/i.test(mvn)
            ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', cmdLine], true]
            : [mvn, args, false];
        const child = execFile(
            file,
            fileArgs,
            { cwd: rootDir, env, timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, windowsVerbatimArguments: verbatim, encoding: 'buffer' },
            (error, stdout, stderr) => {
                clearTimeout(timer);
                const output = `${decodeOutput(stdout)}${decodeOutput(stderr)}`.trim();
                if (error) {
                    const tail = output.split(/\r?\n/).filter(Boolean).slice(-12).join('\n');
                    resolve({
                        ok: false,
                        code: 'COMPILE_FAILED',
                        message: `编译失败：${tail || error.message}`,
                        command: `${mvn} ${args.join(' ')}`,
                        cwd: rootDir,
                        settings,
                        durationMs: Date.now() - startedAt,
                    });
                    return;
                }
                resolve({ ok: true, command: `${mvn} ${args.join(' ')}`, cwd: rootDir, durationMs: Date.now() - startedAt, output: output.slice(-2000), settings });
            },
        );
        void child;
    });
}

// ---- 进程控制 ----

/** 判断 pid 还活着 */
function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error?.code === 'EPERM';
    }
}

/** 杀掉进程树（Windows 用 taskkill /T /F，其它平台杀进程组） */
export async function killProcessTree(pid, { timeoutMs = 15_000 } = {}) {
    const target = Number(pid);
    if (!Number.isInteger(target) || target <= 0) return { ok: false, message: 'pid 非法' };
    if (!pidAlive(target)) return { ok: true, alreadyStopped: true, message: `pid ${target} 已不在运行` };

    if (isWindows) {
        const result = await new Promise((resolve) => {
            execFile('taskkill', ['/PID', String(target), '/T', '/F'], { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) =>
                resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') }),
            );
        });
        // taskkill 对已退出的进程会报「没有找到」，不算失败
        if (result.error && !/not found|没有找到|不存在/i.test(`${result.stdout}${result.stderr}`)) {
            try {
                process.kill(target, 'SIGKILL');
            } catch {
                /* 已经没了 */
            }
        }
    } else {
        try {
            process.kill(-target, 'SIGKILL');
        } catch {
            try {
                process.kill(target, 'SIGKILL');
            } catch {
                /* 已经没了 */
            }
        }
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!pidAlive(target)) return { ok: true, message: `已结束 pid ${target}` };
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return { ok: false, message: `等待 pid ${target} 退出超时（${timeoutMs}ms）` };
}

/**
 * 用快照参数拉起新进程。
 * @returns {{ok:boolean, pid?:number, logPath:string, message?:string}}
 */
export function spawnService({ javaExe, argv, cwd, logPath }) {
    const exe = javaExe || (isWindows ? 'java.exe' : 'java');
    if (logPath) {
        try {
            fs.mkdirSync(path.dirname(logPath), { recursive: true });
        } catch {
            /* 建不了目录就让 spawn 报错 */
        }
    }
    let out;
    try {
        out = logPath ? fs.openSync(logPath, 'a') : 'ignore';
    } catch {
        out = 'ignore';
    }

    const closeOut = () => {
        if (typeof out === 'number') {
            try {
                fs.closeSync(out);
            } catch {
                /* 已交给子进程 */
            }
        }
    };

    /**
     * 返回 Promise：等到 'spawn' 或 'error' 再决定成败。
     *
     * 为什么不能直接返回 `{ok:true}`：可执行文件不存在时 spawn **不抛异常**，
     * 而是异步发 'error'；没有监听器时 Node 把它当未捕获异常，会把 DSH 整个进程崩掉。
     * 一键启动要连续拉起多个服务，其中一个 javaExe 配错（换机器、JDK 路径变了）
     * 就足以让宿主挂掉，所以这里必须挂监听器，并且如实报告失败原因。
     */
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(exe, argv, {
                cwd: cwd || undefined,
                detached: true,
                stdio: ['ignore', out, out],
                windowsHide: true,
            });
        } catch (error) {
            closeOut();
            resolve({ ok: false, message: `拉起进程失败：${error?.message || error}`, logPath: logPath || '' });
            return;
        }

        let settled = false;
        const settle = (value) => {
            if (settled) return;
            settled = true;
            closeOut();
            resolve(value);
        };

        child.once('error', (error) => {
            settle({ ok: false, message: `拉起进程失败：${error?.message || error}`, logPath: logPath || '' });
        });
        child.once('spawn', () => {
            child.unref();
            settle({ ok: true, pid: child.pid, logPath: logPath || '' });
        });
    });
}

/** 等端口开始 LISTENING（用 TCP 连接探测，不依赖 netstat） */
export async function waitPort(host, port, { timeoutMs = 120_000, intervalMs = 500 } = {}) {
    const net = await import('node:net');
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    const probe = () =>
        new Promise((resolve) => {
            const socket = net.connect({ host: host || '127.0.0.1', port: Number(port) });
            let settled = false;
            const finish = (ok) => {
                if (settled) return;
                settled = true;
                socket.destroy();
                resolve(ok);
            };
            socket.setTimeout(1500, () => finish(false));
            socket.once('connect', () => finish(true));
            socket.once('error', () => finish(false));
        });
    while (Date.now() < deadline) {
        if (await probe()) return { ok: true, waitedMs: Date.now() - startedAt };
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return { ok: false, waitedMs: Date.now() - startedAt };
}

/** 等端口释放（重启前必须先确认旧进程真的放掉了端口，否则会误判「新进程已就绪」） */
export async function waitPortFree(host, port, { timeoutMs = 20_000, intervalMs = 200 } = {}) {
    const net = await import('node:net');
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    const probe = () =>
        new Promise((resolve) => {
            const socket = net.connect({ host: host || '127.0.0.1', port: Number(port) });
            let settled = false;
            const finish = (connected) => {
                if (settled) return;
                settled = true;
                socket.destroy();
                resolve(connected);
            };
            socket.setTimeout(1200, () => finish(false));
            socket.once('connect', () => finish(true));
            socket.once('error', () => finish(false));
        });
    while (Date.now() < deadline) {
        if (!(await probe())) return { ok: true, waitedMs: Date.now() - startedAt };
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return { ok: false, waitedMs: Date.now() - startedAt };
}

/** 进程是否还在 */
export function isAlive(pid) {
    return pidAlive(pid);
}

export { getJavaSnapshot };
