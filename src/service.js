/**
 * 本地服务管理：两种模式。
 *
 *  managed —— 由本插件 spawn 子进程（默认 detached，DSH 重启不影响已起服务），
 *             pid 持久化在状态文件里，重启 = 杀进程树 + 重新 spawn + 等健康检查；
 *  observe —— 插件不动进程（进程由 IDEA 起，idea 的 restart 按钮），只能轮询健康
 *             检查/端口判断"是否起来了"，restart 会明确报错让用户去 IDE 里重启。
 *
 * 健康检查三选一（按配置存在与否）：
 *   health.url  —— HTTP 请求，状态码等于 expectStatus（未配置则 2xx/3xx 视为通过）
 *   health.ports—— TCP 端口可连通
 *   都没有      —— managed 模式以"子进程仍存活"为准
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isPlainObject, isPidAlive, readStateNamespace, sleep, writeStateNamespace } from './util.js';

const isWindows = process.platform === 'win32';

/** 打开日志文件用于追加（失败返回 'ignore'） */
function openAppend(logPath) {
    if (!logPath) return 'ignore';
    try {
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        return fs.openSync(logPath, 'a');
    } catch {
        return 'ignore';
    }
}

/** TCP 连通性探测 */
function probePort(host, port, timeoutMs = 1500) {
    return new Promise((resolve) => {
        const socket = net.connect({ host, port: Number(port) });
        let settled = false;
        const finish = (ok) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(ok);
        };
        socket.setTimeout(timeoutMs, () => finish(false));
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
    });
}

/** HTTP 健康探测 */
async function probeHttp(health) {
    if (!health.url) return undefined;
    try {
        const response = await fetch(health.url, {
            method: health.method || 'GET',
            signal: AbortSignal.timeout(health.timeoutMs || 3000),
            redirect: 'manual',
        });
        const expected = Number(health.expectStatus || 0);
        const ok = expected ? response.status === expected : response.status < 400;
        return { ok, detail: `HTTP ${response.status}` };
    } catch (error) {
        return { ok: false, detail: `请求失败：${error?.message || error}` };
    }
}

export class ServiceManager {
    /**
     * @param {{statePath:string, homeDir:string}} options
     */
    constructor(options = {}) {
        this.statePath = options.statePath || '';
        this.children = new Map();
        this._state = null;
    }

    _load() {
        if (this._state) return this._state;
        this._state = readStateNamespace(this.statePath, 'services');
        return this._state;
    }

    _record(serviceId) {
        const state = this._load();
        return isPlainObject(state[serviceId]) ? state[serviceId] : undefined;
    }

    _setRecord(serviceId, record) {
        const state = this._load();
        if (record) state[serviceId] = record;
        else delete state[serviceId];
        this._flush();
    }

    _flush() {
        if (!this.statePath || !this._state) return;
        // 只更新 services 命名空间，保留日志游标
        writeStateNamespace(this.statePath, 'services', this._state);
    }

    /** 当前托管的 pid（内存优先，回退状态文件，并确认存活） */
    pidOf(service) {
        const live = this.children.get(service.id);
        if (live?.pid && isPidAlive(live.pid)) return live.pid;
        const record = this._record(service.id);
        if (record?.pid && isPidAlive(record.pid)) return record.pid;
        return 0;
    }

    /** 健康检查：返回 {ok, checks:[{kind, ok, detail}]} */
    async check(service) {
        const checks = [];
        const pid = this.pidOf(service);
        if (service.mode === 'managed') {
            checks.push({ kind: 'process', ok: pid > 0, detail: pid > 0 ? `pid ${pid} 存活` : '未发现托管进程' });
        }
        const http = await probeHttp(service.health);
        if (http) checks.push({ kind: 'http', ...http, detail: `${service.health.url} → ${http.detail}` });

        for (const port of service.health.ports || []) {
            const ok = await probePort(service.health.host || '127.0.0.1', port, service.health.timeoutMs || 1500);
            checks.push({ kind: 'tcp', ok, detail: `${service.health.host || '127.0.0.1'}:${port} ${ok ? '可连接' : '连接失败'}` });
        }

        if (checks.length === 0) {
            return { ok: pid > 0, checks: [{ kind: 'process', ok: pid > 0, detail: pid > 0 ? `pid ${pid} 存活` : '无健康检查配置且无托管进程' }] };
        }
        // process 检查只作为辅助信息：observe 模式下没有 pid 是正常的
        const effective = checks.filter((item) => item.kind !== 'process');
        const ok = effective.length > 0 ? effective.every((item) => item.ok) : checks.every((item) => item.ok);
        return { ok, checks };
    }

    /** 轮询等到健康；返回 {ok, waitedMs, checks} */
    async waitHealthy(service, timeoutMs = service.startupTimeoutMs || 60_000) {
        const started = Date.now();
        const interval = Math.max(200, service.health.intervalMs || 1000);
        let last = await this.check(service);
        while (!last.ok && Date.now() - started < timeoutMs) {
            await sleep(interval);
            last = await this.check(service);
        }
        return { ok: last.ok, waitedMs: Date.now() - started, checks: last.checks };
    }

    /** 启动（managed）；已健康则直接返回 */
    async start(service, options = {}) {
        if (service.mode !== 'managed') {
            return {
                ok: false,
                reason: 'OBSERVE_MODE',
                message: `服务 ${service.id} 是 observe 模式，插件不托管进程；请在 IDEA 里启动后调用 wait/status 等待就绪。`,
            };
        }
        const existing = await this.check(service);
        if (existing.ok && !options.force) {
            return { ok: true, alreadyRunning: true, reason: 'ALREADY_RUNNING', pid: this.pidOf(service), checks: existing.checks };
        }
        if (this.pidOf(service) > 0) {
            // 进程在但不健康：先杀掉再起，避免端口冲突
            await this.stop(service);
        }
        if (!service.command) {
            return { ok: false, reason: 'NO_COMMAND', message: `服务 ${service.id} 未配置 command` };
        }

        const logFd = openAppend(service.logPath);
        const [file, ...args] = [service.command, ...service.args];
        let child;
        try {
            child = spawn(file, args, {
                cwd: service.cwd || process.cwd(),
                env: { ...process.env, ...service.env },
                detached: true,
                stdio: ['ignore', logFd, logFd],
                shell: isWindows && /\.(cmd|bat)$/i.test(file),
                windowsHide: true,
            });
        } catch (error) {
            if (typeof logFd === 'number') {
                try {
                    fs.closeSync(logFd);
                } catch {
                    // 关闭失败无影响
                }
            }
            return { ok: false, reason: 'SPAWN_FAILED', message: `启动失败：${error.message}` };
        }
        // 子进程已继承该 fd，父进程必须关掉自己那份，否则文件句柄泄漏、日志文件被占用
        if (typeof logFd === 'number') {
            try {
                fs.closeSync(logFd);
            } catch {
                // 关闭失败无影响
            }
        }
        child.unref?.();
        this.children.set(service.id, child);

        let exitInfo;
        child.once('exit', (code, signal) => {
            exitInfo = { code, signal };
            if (this.children.get(service.id) === child) this.children.delete(service.id);
        });
        this._setRecord(service.id, {
            pid: child.pid,
            startedAt: new Date().toISOString(),
            command: [service.command, ...service.args].join(' '),
            cwd: service.cwd,
        });

        const health = await this.waitHealthy(service, options.timeoutMs || service.startupTimeoutMs);
        if (health.ok) {
            return { ok: true, pid: child.pid, waitedMs: health.waitedMs, checks: health.checks };
        }
        return {
            ok: false,
            reason: 'START_TIMEOUT',
            pid: child.pid,
            waitedMs: health.waitedMs,
            checks: health.checks,
            exited: exitInfo,
            message: exitInfo
                ? `进程启动后立即退出（code=${exitInfo.code}, signal=${exitInfo.signal}），检查 command/cwd 与日志`
                : `启动后 ${health.waitedMs}ms 内健康检查未通过`,
        };
    }

    /** 停止（managed）：Windows 用 taskkill /T /F 杀进程树，其它平台杀进程组 */
    async stop(service) {
        if (service.mode !== 'managed') {
            return { ok: false, reason: 'OBSERVE_MODE', message: `服务 ${service.id} 是 observe 模式，请到 IDEA 里停止。` };
        }
        const pid = this.pidOf(service);
        if (pid === 0) {
            this._setRecord(service.id, undefined);
            return { ok: true, alreadyStopped: true };
        }
        const killed = await this._killTree(pid, service.killTree !== false);
        this.children.delete(service.id);
        const deadline = Date.now() + (service.stopTimeoutMs || 10_000);
        while (Date.now() < deadline && isPidAlive(pid)) await sleep(120);
        const stillAlive = isPidAlive(pid);
        if (!stillAlive) this._setRecord(service.id, undefined);
        return {
            ok: !stillAlive,
            pid,
            killedBy: killed,
            stillAlive,
            message: stillAlive ? `pid ${pid} 在 ${service.stopTimeoutMs}ms 内未退出` : `已停止 pid ${pid}`,
        };
    }

    _killTree(pid, tree) {
        return new Promise((resolve) => {
            if (isWindows) {
                const args = ['/PID', String(pid), '/T', '/F'];
                const killer = spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' });
                killer.once('exit', (code) => {
                    if (code === 0) {
                        resolve('taskkill');
                        return;
                    }
                    try {
                        process.kill(pid);
                        resolve('kill');
                    } catch {
                        resolve('none');
                    }
                });
                killer.once('error', () => {
                    try {
                        process.kill(pid);
                        resolve('kill');
                    } catch {
                        resolve('none');
                    }
                });
                return;
            }
            try {
                // detached 启动 => 子进程是进程组 leader
                process.kill(tree ? -pid : pid, 'SIGTERM');
                resolve('SIGTERM');
            } catch {
                resolve('none');
            }
        });
    }

    /** 重启（managed）：stop + start，返回带耗时与阶段的结果 */
    async restart(service, options = {}) {
        if (service.mode !== 'managed') {
            // observe 模式：不能替用户重启，但可以等待用户手动重启后恢复
            return {
                ok: false,
                reason: 'OBSERVE_MODE',
                message: `服务 ${service.id} 是 observe 模式，插件不托管进程。请在 IDEA 里重启，然后调用 action=wait 等待健康检查通过。`,
            };
        }
        const stopped = await this.stop(service);
        if (!stopped.ok) return { ok: false, stage: 'stop', ...stopped };
        const started = await this.start(service, { ...options, force: true });
        return { ok: started.ok, stage: started.ok ? 'done' : 'start', stop: stopped, start: started };
    }

    /** 概览：所有配置服务的实时状态 */
    async statusAll(services) {
        const out = [];
        for (const service of services) {
            const pid = this.pidOf(service);
            const health = await this.check(service);
            out.push({
                id: service.id,
                name: service.name,
                mode: service.mode,
                pid: pid || undefined,
                healthy: health.ok,
                checks: health.checks,
            });
        }
        return out;
    }

    /** 插件卸载：只保存状态，不杀进程（服务应在 DSH 重启后继续可用） */
    dispose() {
        this._flush();
    }
}
