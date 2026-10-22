/**
 * 本机 Java 服务发现：给侧边栏「运行中的 Java 服务」列表供数。
 *
 * 做法（Windows / macOS / Linux 都走同一套，只是取端口的命令不同）：
 *   1. `jps -l -v` 拿 pid + 主类/jar + JVM 参数（IDEA 启动的服务带 jdwp 调试参数，据此可判定「来自 IDEA」）；
 *   2. 监听端口按 pid 归到进程上：Windows 用 `netstat -ano -p tcp`，
 *      macOS/Linux 用 `lsof -nP -iTCP -sTCP:LISTEN`（没有 lsof 时退回 Linux 的 `netstat -tlnp`）；
 *   3. 从 JVM 参数里抽 server.port / spring.profiles.active / jdwp 地址等关键信息。
 *
 * 不依赖第三方包，只用 node:child_process。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { request as httpRequest } from 'node:http';

/** 执行命令并返回 stdout（超时/失败返回空串，绝不抛） */
function run(file, args, timeoutMs = 8000) {
    return new Promise((resolve) => {
        try {
            execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
                if (error) return resolve('');
                resolve(String(stdout || ''));
            });
        } catch {
            resolve('');
        }
    });
}

/** 找 jps：JAVA_HOME 优先，其次 PATH 上的 jps（Windows 是 jps.exe） */
async function resolveJps() {
    const javaHome = process.env.JAVA_HOME;
    if (javaHome) {
        const candidate = `${javaHome.replace(/[\\/]+$/, '')}${process.platform === 'win32' ? '\\bin\\jps.exe' : '/bin/jps'}`;
        const probe = await run(candidate, ['-l'], 4000);
        if (probe.trim() !== '') return candidate;
    }
    const probe = await run('jps', ['-l'], 4000);
    return probe.trim() === '' ? '' : 'jps';
}

/** 解析 `jps -l -v` 输出 */
function parseJps(stdout) {
    const out = [];
    for (const line of String(stdout).split(/\r?\n/)) {
        const match = /^\s*(\d+)\s+(\S+)\s*(.*)$/.exec(line);
        if (!match) continue;
        const pid = Number(match[1]);
        const mainClass = match[2];
        const rest = match[3] || '';
        out.push({ pid, mainClass, jvmArgs: rest });
    }
    return out;
}

/** 往 Map<pid, number[]> 里塞一条（去重，保持顺序） */
function addPort(map, pid, port) {
    if (!Number.isInteger(pid) || pid <= 0) return;
    if (!Number.isInteger(port) || port <= 0) return;
    const list = map.get(pid) || [];
    if (!list.includes(port)) list.push(port);
    map.set(pid, list);
}

/**
 * 解析 Windows `netstat -ano -p tcp`，返回 Map<pid, number[]>（仅 LISTENING）。
 * 典型行：`  TCP    0.0.0.0:8080    0.0.0.0:0    LISTENING    23088`
 */
function parseNetstat(stdout) {
    const map = new Map();
    for (const line of String(stdout).split(/\r?\n/)) {
        const match = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
        if (!match) continue;
        addPort(map, Number(match[2]), Number(match[1]));
    }
    return map;
}

/**
 * 解析 macOS/Linux 的 `lsof -nP -iTCP -sTCP:LISTEN`，返回 Map<pid, number[]>。
 * 典型行：`java      23088 user    42u  IPv6 0x1234      0t0  TCP *:8080 (LISTEN)`
 *
 * 注意别按「固定第几列」去切：DEVICE 列在 macOS 上可能是 `0x1234abcd`，NAME 也可能是
 * `127.0.0.1:8080`、`[::1]:8080`、`*:8080` 几种形态。这里只认两件事——
 * 第二列是 pid、行尾 `:<端口> (LISTEN)`，其余列一概不管。
 */
function parseLsof(stdout) {
    const map = new Map();
    for (const line of String(stdout).split(/\r?\n/)) {
        if (!/\(LISTEN\)/i.test(line)) continue;
        const fields = line.trim().split(/\s+/);
        if (fields.length < 2) continue;
        const pid = Number(fields[1]);
        const portMatch = /:(\d+)\s+\(LISTEN\)/i.exec(line);
        if (!portMatch) continue;
        addPort(map, pid, Number(portMatch[1]));
    }
    return map;
}

/**
 * 解析 Linux `netstat -tlnp`（lsof 缺失时的兜底），返回 Map<pid, number[]>。
 * 典型行：`tcp6  0  0 :::8080  :::*  LISTEN  23088/java`
 */
function parseNetstatLinux(stdout) {
    const map = new Map();
    for (const line of String(stdout).split(/\r?\n/)) {
        const match = /^\s*tcp6?\s+\d+\s+\d+\s+\S+:(\d+)\s+\S+\s+LISTEN\s+(\d+)\//i.exec(line);
        if (!match) continue;
        addPort(map, Number(match[2]), Number(match[1]));
    }
    return map;
}

/**
 * 枚举「监听端口 → pid」。
 *
 * 早期只在 Windows 上跑 netstat，其它平台直接返回空表，导致 macOS 上面板一个端口都没有
 * （服务能列出来但 baseUrl 全是空）。这里按平台分流，拿不到就退化成空表，不影响进程列表。
 */
async function listeningPortsByPid() {
    if (process.platform === 'win32') {
        return parseNetstat(await run('netstat', ['-ano', '-p', 'tcp']));
    }
    const lsof = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], 10_000);
    if (lsof.trim() !== '') return parseLsof(lsof);
    return parseNetstatLinux(await run('netstat', ['-tlnp'], 10_000));
}

/** 从 JVM 参数里抽关键信息 */
function analyzeArgs(jvmArgs) {
    const text = String(jvmArgs || '');
    const pick = (pattern) => {
        const match = pattern.exec(text);
        return match ? match[1] : '';
    };
    const profileText = pick(/-Dspring\.profiles\.active=([^\s]+)/);
    return {
        /** Spring Boot 显式端口 */
        serverPort: Number(pick(/-Dserver\.port=(\d+)/)) || 0,
        /** 激活的 profile（可能是逗号分隔的多个，统一成数组给前端用） */
        profiles: profileText ? profileText.split(',').map((item) => item.trim()).filter(Boolean) : [],
        /** IDEA 调试端口 */
        debugPort: Number(pick(/-agentlib:jdwp=[^\s]*address=[^:\s]*:(\d+)/)) || 0,
        /** IDEA 打开的项目路径（IDEA 自身进程才有） */
        ideaProject: pick(/-Dpreload\.project\.path=([^\s]+)/),
        /** 是否由 IDEA 启动（带 JetBrains debugger agent 或 debug agentlib）。
         * 注意：插件自己拉起的进程也会带 -agentlib:jdwp（为了能被 IDEA 远程挂载调试），
         * 所以带 -DdshApiRunner.runId 标记的一律不算 IDEA 起的。 */
        fromIdea: /-DdshApiRunner\.runId=/.test(text) ? false : /JetBrains[\\/]IntelliJIdea/i.test(text) || /-agentlib:jdwp=/.test(text),
    };
}

/** 归类：IDEA 自身/构建进程、Spring Boot 服务、其它 java 程序 */
function classify(mainClass, analysis) {
    if (/^(jdk\.jcmd|sun\.tools\.jps|org\.jetbrains\.|com\.intellij\.)/.test(mainClass)) return 'tool';
    if (/Application$/.test(mainClass) || analysis.profiles.length > 0) return 'spring';
    return 'app';
}

/** HTTP 探测结果缓存：面板 5 秒轮询一次，端口是否讲 HTTP 不会那么快变，缓存 30 秒 */
const httpProbeCache = new Map();
const HTTP_PROBE_TTL_MS = 30_000;

function probeHttpCached(port) {
    const hit = httpProbeCache.get(port);
    if (hit && Date.now() - hit.at < HTTP_PROBE_TTL_MS) return Promise.resolve(hit);
    return probeHttp(port).then((info) => {
        httpProbeCache.set(port, { ...info, at: Date.now() });
        return info;
    });
}

/**
 * 探测某个端口上是不是「能当接口地址」的 HTTP 服务。
 *
 * 为什么不能只看 netstat：一个服务常同时监听好几个端口
 * （业务端口、Sentinel 规则端口、管理/actuator 端口，甚至注册中心之类的私有协议端口）。
 * Sentinel 的 command server 是典型例子：它对 `/getRules` 回 200，
 * 但对任意其它路径回 `400 Invalid command`（没有 content-type）。
 * 直接拿它当 baseUrl，所有业务接口都会 400，所以必须识别并排除。
 *
 * 所以打分而不是只看「有没有响应」：
 *   - 2xx/3xx               → 就是它
 *   - 401/403               → 需要鉴权的接口端，也是它
 *   - 404/405 且带 content-type（Spring 的 JSON 错误页）→ 也是它
 *   - 400 且 body 是 `Invalid command`、没有 content-type → 判为私有协议端口（多为 Sentinel），跳过
 */
function probeHttp(port, timeoutMs = 800) {
    return new Promise((resolve) => {
        if (!port) return resolve({ http: false, status: 0, reason: 'no-port' });
        let settled = false;
        const done = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
        try {
            const req = httpRequest({ host: '127.0.0.1', port, path: '/', method: 'GET', timeout: timeoutMs }, (res) => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => {
                    if (body.length < 400) body += chunk;
                });
                res.on('end', () => {
                    const status = res.statusCode || 0;
                    const contentType = String(res.headers['content-type'] || '');
                    const looksPrivate =
                        status === 400
                        && contentType === ''
                        && /invalid\s+command/i.test(body);
                    done({
                        http: !looksPrivate,
                        status,
                        contentType,
                        reason: looksPrivate ? 'not-http-protocol' : 'ok',
                    });
                });
                res.on('error', () => done({ http: false, status: 0, reason: 'read-error' }));
                // 注意：这里不能提前 req.destroy()，否则 res 还没读完就断开，
                // body 为空会导致下面的 looksPrivate 判断永远不成立（踩过）。
            });
            req.on('timeout', () => {
                req.destroy();
                done({ http: false, status: 0, reason: 'timeout' });
            });
            req.on('error', () => done({ http: false, status: 0, reason: 'connect-error' }));
            req.end();
        } catch {
            done({ http: false, status: 0, reason: 'exception' });
        }
    });
}

/**
 * 列出本机所有 Java 进程。
 * @returns {Promise<{ok:boolean, jps:string, processes:Array, note?:string}>}
 */
export async function listJavaProcesses() {
    const jps = await resolveJps();
    if (!jps) {
        return { ok: false, jps: '', processes: [], note: '找不到 jps（设置 JAVA_HOME 或把 JDK/bin 加入 PATH），已无法枚举 Java 进程' };
    }
    const [jpsOut, portsByPid] = await Promise.all([
        run(jps, ['-l', '-v']),
        listeningPortsByPid(),
    ]);
    const processes = parseJps(jpsOut)
        .map((item) => {
            const analysis = analyzeArgs(item.jvmArgs);
            const ports = portsByPid.get(item.pid) || [];
            return {
                pid: item.pid,
                mainClass: item.mainClass,
                /** 服务名：取主类最后一段，去掉 Application 后缀更好读 */
                name: (item.mainClass.split('.').pop() || item.mainClass).replace(/Application$/, ''),
                kind: classify(item.mainClass, analysis),
                fromIdea: analysis.fromIdea,
                profiles: analysis.profiles,
                debugPort: analysis.debugPort,
                ideaProject: analysis.ideaProject,
                serverPort: analysis.serverPort,
                ports,
                /** 先按「显式 server.port > 第一个非调试端口」给个初值，下面再用 HTTP 探测修正 */
                primaryPort: analysis.serverPort || ports.find((port) => port !== analysis.debugPort) || 0,
                /** 只保留可读的 -D 参数，避免把整条命令行糊到界面上 */
                systemProperties: extractProperties(item.jvmArgs),
            };
        })
        .filter((item) => item.kind !== 'tool');

    // 并发探测每个进程的候选端口，挑第一个真正讲业务 HTTP 的作为 primaryPort，
    // 同时给每个端口标上角色：一个服务往往同时听业务端口和 Sentinel 规则端口，
    // 只报一个数字用户看不懂「为什么两个」。
    await Promise.all(processes.map(async (item) => {
        const candidates = item.ports.filter((port) => port !== item.debugPort);
        item.portProbed = true;
        const probes = new Map();
        for (const port of candidates) {
            if (item.serverPort === port) {
                probes.set(port, { http: true, status: 0, reason: 'server-port' });
                continue;
            }
            // eslint-disable-next-line no-await-in-loop
            const info = await probeHttpCached(port);
            probes.set(port, info);
            if (info.http && !item.httpPort) item.httpPort = port;
        }
        if (item.serverPort > 0 && !item.httpPort) item.httpPort = item.serverPort;
        if (item.httpPort) item.primaryPort = item.httpPort;
        item.probe = item.httpPort
            ? { ...(probes.get(item.httpPort) || { http: true, status: 0, reason: 'server-port' }), port: item.httpPort }
            : { http: false, status: 0, reason: 'no-listen' };
        item.sentinelPort = 0;
        item.portList = candidates.map((port) => {
            const probe = probes.get(port) || {};
            let role = 'unknown';
            if (port === item.httpPort) role = 'http';
            else if (probe.reason === 'not-http-protocol') role = 'sentinel';
            if (role === 'sentinel' && !item.sentinelPort) item.sentinelPort = port;
            return {
                port,
                role,
                label: PORT_ROLE_LABEL[role] || PORT_ROLE_LABEL.unknown,
                status: probe.status || 0,
                reason: probe.reason || '',
            };
        });
    }));

    return { ok: true, jps, processes, total: processes.length };
}

/** 端口角色 → 给人看的说明 */
const PORT_ROLE_LABEL = {
    http: 'HTTP 业务端口',
    debug: '调试端口（jdwp）',
    sentinel: '私有协议端口（Sentinel 等）',
    unknown: '未识别端口',
};

// ---- 应用日志文件发现 ----
//
// IDEA 起的进程，stdout 只在 IDEA 控制台里，没有文件可读；但它自己的 logback 会把
// 业务日志写到 `<user.dir>/logs/<服务名>/info.log`。所以「查询详情」对这类进程
// 只能读应用日志——这正是用户要的「跟 IDEA 一样的日志信息」。

/** 进程工作目录缓存：取 user.dir 要跑一次 jcmd（约 200ms），5 分钟内不重复取 */
const userDirCache = new Map();
const USER_DIR_TTL_MS = 5 * 60_000;

async function userDirOf(pid) {
    const target = Number(pid);
    if (!Number.isInteger(target) || target <= 0) return '';
    const hit = userDirCache.get(target);
    if (hit && Date.now() - hit.at < USER_DIR_TTL_MS) return hit.value;
    const jcmd = await resolveJcmd();
    if (!jcmd) return '';
    const result = await runCapture(jcmd, [String(target), 'VM.system_properties'], 6000);
    let value = '';
    if (result.ok) {
        const props = parseSystemProperties(result.stdout);
        value = props['user.dir'] || '';
    }
    userDirCache.set(target, { value, at: Date.now() });
    return value;
}

/** 归一化名字用于匹配：UserService / user-service / user_service 都变成 userservice */
function normalizeName(text) {
    return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * 找某个 Java 进程对应的应用日志文件。
 * 规则：从 user.dir 起找 logs/<与进程名同构的子目录>/，优先 info.log，其次 error.log，
 * 最后取最近修改的 *.log。找不到就返回空数组（前端会提示只能看进程信息）。
 */
export async function discoverLogs(pid, name) {
    const cwd = await userDirOf(pid);
    if (!cwd) return { ok: false, cwd: '', files: [], note: '读不到进程工作目录（jcmd 不可用）' };
    const wanted = normalizeName(name);
    const roots = [path.join(cwd, 'logs'), path.join(cwd, '..', 'logs')];
    const files = [];
    for (const root of roots) {
        let entries;
        try {
            entries = fs.readdirSync(root, { withFileTypes: true });
        } catch {
            continue;
        }
        const dirs = entries.filter((entry) => entry.isDirectory());
        // 先精确匹配，匹配不到再退化成「互相包含」，避免多服务时抓错
        const exact = dirs.filter((entry) => normalizeName(entry.name) === wanted);
        const loose = exact.length > 0 ? exact : dirs.filter((entry) => {
            const key = normalizeName(entry.name);
            return key !== '' && (key.includes(wanted) || wanted.includes(key));
        });
        for (const dir of loose) {
            const dirPath = path.join(root, dir.name);
            files.push(...pickLogFiles(dirPath, dir.name));
        }
        if (files.length > 0) break;
    }
    return {
        ok: true,
        cwd,
        files,
        note: files.length === 0 ? `在 ${cwd}\\logs 下没找到与「${name}」匹配的日志目录` : '',
    };
}

/** 从一个日志目录里挑出要展示的文件：当前在写的排前面，按天滚动的归入历史 */
function pickLogFiles(dirPath, label) {
    let names;
    try {
        names = fs.readdirSync(dirPath);
    } catch {
        return [];
    }
    const stats = [];
    for (const name of names) {
        if (!/\.log$/i.test(name)) continue;
        const file = path.join(dirPath, name);
        try {
            const stat = fs.statSync(file);
            if (!stat.isFile()) continue;
            stats.push({ label, name, path: file, size: stat.size, updatedAt: stat.mtime.toISOString(), at: stat.mtimeMs });
        } catch {
            // 文件刚被轮转删掉，跳过
        }
    }
    // 「当前文件」= 正好叫 info.log / error.log 的（logback 正在往里写），
    // 其余按天滚动的是历史。历史文件绝不能排到前面——否则点开详情看到的是几天前的日志。
    const isCurrent = (item) => /^(info|error)\.log$/i.test(item.name);
    const rank = (item) => {
        if (/^info\.log$/i.test(item.name)) return 0;
        if (/^error\.log$/i.test(item.name)) return 1;
        return 2;
    };
    stats.sort((a, b) => rank(a) - rank(b) || b.at - a.at);
    return stats.slice(0, 6).map(({ at, ...rest }) => ({ ...rest, current: isCurrent(rest) }));
}

/**
 * 按行读文件末尾：默认只取最后 N 行，返回的 fromOffset 精确落在这一段的起点，
 * 之后拿它做增量（follow）不会重复也不会漏。
 */
export function readFileTail(file, options = {}) {
    const wantedLines = Math.max(1, Math.min(5000, Number(options.lines) || 200));
    let stat;
    try {
        stat = fs.statSync(file);
    } catch {
        return { ok: false, code: 'NOT_FOUND', logPath: file, size: 0, fromOffset: 0, nextOffset: 0, text: '', lines: 0, note: '日志文件不存在' };
    }
    // 读末尾一段再把多出来的行切掉，避免整读几百 MB 的历史日志
    const window = Math.min(stat.size, Math.max(256 * 1024, wantedLines * 512));
    let from = Math.max(0, stat.size - window);
    let text = '';
    if (window > 0) {
        const buffer = Buffer.alloc(window);
        const fd = fs.openSync(file, 'r');
        try {
            fs.readSync(fd, buffer, 0, window, from);
        } finally {
            fs.closeSync(fd);
        }
        text = buffer.toString('utf8');
    }
    const parts = text.split(/\r?\n/);
    // 结尾换行会产生一个空元素，先去掉；正文里的空行要保留
    if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
    let taken = parts;
    let cutBytes = 0;
    if (parts.length > wantedLines) {
        const dropped = parts.slice(0, parts.length - wantedLines);
        cutBytes = Buffer.byteLength(dropped.join('\n'), 'utf8') + 1;
        taken = parts.slice(parts.length - wantedLines);
    }
    // 头部可能被截断到半个字符，去掉第一行残缺内容（只在真的从文件中间开始时）
    if (from > 0 && cutBytes === 0) {
        const firstBreak = taken[0] === undefined ? -1 : 0;
        if (firstBreak === 0) taken = taken.slice(1);
    }
    const body = taken.join('\n');
    const startOffset = from + cutBytes;
    return {
        ok: true,
        logPath: file,
        size: stat.size,
        fromOffset: startOffset,
        nextOffset: stat.size,
        remainingBytes: 0,
        updatedAt: stat.mtime.toISOString(),
        text: body,
        lines: taken.length,
    };
}


/**
 * 按字节偏移读任意文件的末尾/增量（面板详情页对应用日志也用这个）。
 * 偏移超出文件大小（轮转/截断）时自动从头读。
 */
export function readFileChunk(file, options = {}) {
    const maxBytes = Math.max(1024, Number(options.maxBytes) || 64 * 1024);
    let stat;
    try {
        stat = fs.statSync(file);
    } catch {
        return { ok: false, code: 'NOT_FOUND', logPath: file, size: 0, fromOffset: 0, nextOffset: 0, text: '', note: '日志文件不存在' };
    }
    let from = Number(options.fromOffset);
    if (!Number.isFinite(from) || from < 0 || from > stat.size) from = Math.max(0, stat.size - maxBytes);
    const length = Math.min(Math.max(0, stat.size - from), maxBytes);
    let text = '';
    if (length > 0) {
        const buffer = Buffer.alloc(length);
        const fd = fs.openSync(file, 'r');
        try {
            fs.readSync(fd, buffer, 0, length, from);
        } finally {
            fs.closeSync(fd);
        }
        text = buffer.toString('utf8');
    }
    return {
        ok: true,
        logPath: file,
        size: stat.size,
        fromOffset: from,
        nextOffset: from + length,
        remainingBytes: Math.max(0, stat.size - (from + length)),
        updatedAt: stat.mtime.toISOString(),
        text,
    };
}

// ---- 重启服务用的进程快照 ----

/** 执行命令并按结果返回 stdout/stderr（与 run 不同，这里需要知道失败原因） */
function runCapture(file, args, timeoutMs = 8000) {
    return new Promise((resolve) => {
        try {
            execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
                resolve({ ok: !error, stdout: String(stdout || ''), stderr: String(stderr || '') });
            });
        } catch (error) {
            resolve({ ok: false, stdout: '', stderr: String(error?.message || error) });
        }
    });
}

/** 找 jcmd：JAVA_HOME 优先，其次 PATH（jps 与 jcmd 同目录，复用同一套解析） */
async function resolveJcmd() {
    const javaHome = process.env.JAVA_HOME;
    if (javaHome) {
        const candidate = `${javaHome.replace(/[\\/]+$/, '')}${process.platform === 'win32' ? '\\bin\\jcmd.exe' : '/bin/jcmd'}`;
        const probe = await runCapture(candidate, ['-l'], 4000);
        if (probe.ok && probe.stdout.trim() !== '') return candidate;
    }
    const probe = await runCapture('jcmd', ['-l'], 4000);
    return probe.ok && probe.stdout.trim() !== '' ? 'jcmd' : '';
}

/** 解 jcmd 系统属性里的转义：`C\:\\Java\\jdk` → `C:\Java\jdk` */
function unescapeProperty(value) {
    let out = '';
    for (let i = 0; i < value.length; i += 1) {
        if (value[i] === '\\' && i + 1 < value.length) {
            out += value[i + 1];
            i += 1;
        } else {
            out += value[i];
        }
    }
    return out;
}

/** 解析 `jcmd <pid> VM.command_line` 的分段输出 */
function parseCommandLine(stdout) {
    const out = { jvmArgsText: '', javaCommand: '', classPath: '' };
    for (const line of String(stdout).split(/\r?\n/)) {
        if (line.startsWith('jvm_args:')) out.jvmArgsText = line.slice('jvm_args:'.length).trim();
        else if (line.startsWith('java_command:')) out.javaCommand = line.slice('java_command:'.length).trim();
        else if (line.startsWith('java_class_path (initial):')) out.classPath = line.slice('java_class_path (initial):'.length).trim();
    }
    return out;
}

/** 解析 `jcmd <pid> VM.system_properties` 的 key=value 行 */
function parseSystemProperties(stdout) {
    const out = {};
    for (const line of String(stdout).split(/\r?\n/)) {
        const at = line.indexOf('=');
        if (at <= 0) continue;
        out[line.slice(0, at)] = unescapeProperty(line.slice(at + 1));
    }
    return out;
}

/** 按空白切分 JVM 参数（classpath 单独给出，这里不会出现带空格的参数） */
function splitArgs(text) {
    return String(text || '')
        .split(/\s+/)
        .map((item) => item.trim())
        .filter(Boolean);
}

/**
 * 读取某个 Java 进程的「重启所需快照」：java 路径、工作目录、classpath、主类、JVM 参数。
 * 用的是 JVM 自带的 jcmd，不依赖 WMI，跨平台一致。
 * @param {number} pid
 */
export async function getJavaSnapshot(pid) {
    const target = Number(pid);
    if (!Number.isInteger(target) || target <= 0) return { ok: false, message: 'pid 非法' };
    const jcmd = await resolveJcmd();
    if (!jcmd) return { ok: false, message: '找不到 jcmd（设置 JAVA_HOME 或把 JDK/bin 加入 PATH）' };

    const [cmdResult, propResult] = await Promise.all([
        runCapture(jcmd, [String(target), 'VM.command_line'], 10_000),
        runCapture(jcmd, [String(target), 'VM.system_properties'], 10_000),
    ]);
    if (!cmdResult.ok) {
        const reason = (cmdResult.stderr || cmdResult.stdout || '').trim() || 'jcmd 无输出';
        return { ok: false, message: `读取进程 ${target} 的启动参数失败：${reason}` };
    }

    const parsed = parseCommandLine(cmdResult.stdout);
    const props = propResult.ok ? parseSystemProperties(propResult.stdout) : {};
    const javaHome = props['java.home'] || '';
    const javaExe = javaHome
        ? `${javaHome.replace(/[\\/]+$/, '')}${process.platform === 'win32' ? '\\bin\\java.exe' : '/bin/java'}`
        : '';
    if (!parsed.classPath) return { ok: false, message: `进程 ${target} 没有 -classpath（可能不是通过标准启动器起的），无法原样还原` };
    if (!parsed.javaCommand) return { ok: false, message: `进程 ${target} 读不到主类，无法还原` };

    // 坑：`jcmd VM.command_line` 的 classpath 会被截断（实测 21335 字符只给出 1998 字符，
    // 218 条依赖只剩前 19 条），拿它重启必然缺 jar。`VM.system_properties` 里的
    // java.class.path 是完整值，所以优先用它，并取两者中更完整的那个兜底。
    const propClassPath = props['java.class.path'] || '';
    const classPath = propClassPath.length >= parsed.classPath.length ? propClassPath : parsed.classPath;

    // java_command 可能是「主类 + 程序参数」，第一段是主类
    const commandParts = splitArgs(parsed.javaCommand);
    return {
        ok: true,
        pid: target,
        javaExe,
        javaHome,
        cwd: props['user.dir'] || '',
        classPath,
        mainClass: commandParts[0] || '',
        programArgs: commandParts.slice(1),
        jvmArgs: splitArgs(parsed.jvmArgsText),
        systemProperties: {
            'file.encoding': props['file.encoding'] || '',
            'spring.profiles.active': props['spring.profiles.active'] || '',
        },
    };
}

/**
 * 只挑几个对排查有用的 -D 系统属性。
 * `dshApiRunner.runId` 是本插件拉起进程时打的标记：即使状态文件丢了（换机器/清过 DSH_HOME），
 * 也能从 jps 参数上认出「这个进程是我起的」。
 */
function extractProperties(jvmArgs) {
    const wanted = ['server.port', 'spring.profiles.active', 'spring.application.name', 'file.encoding', 'spring.output.ansi.enabled', 'dshApiRunner.runId'];
    const out = {};
    for (const match of String(jvmArgs || '').matchAll(/-D([A-Za-z0-9_.-]+)=([^\s]*)/g)) {
        if (wanted.includes(match[1])) out[match[1]] = match[2];
    }
    return out;
}
