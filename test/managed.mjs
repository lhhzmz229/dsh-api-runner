/**
 * managed 模式真实进程自测：起一个 detached 的 node HTTP 服务，验证
 * 启动 → 健康检查 → 日志文件落盘 → 重启（pid 变化）→ 停止（进程消失）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);
const { ServiceManager } = await load('src/service.js');
const { isPidAlive } = await load('src/util.js');

let passed = 0;
async function ok(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log(`  ✓ ${name}`);
    } catch (error) {
        console.error(`  ✗ ${name}\n    ${error?.stack || error}`);
        process.exitCode = 1;
    }
}

async function freePort() {
    const server = net.createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    await new Promise((r) => server.close(r));
    return port;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'api-runner-svc-'));
const statePath = path.join(tmp, 'state.json');
const logPath = path.join(tmp, 'svc.log');
const scriptPath = path.join(tmp, 'server.cjs');
const port = await freePort();

fs.writeFileSync(
    scriptPath,
    `const http = require('http');
const port = Number(process.argv[2]);
http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ pid: process.pid }));
}).listen(port, '127.0.0.1', () => {
  console.log('listening on ' + port);
  setInterval(() => {}, 1000);
});
process.on('SIGTERM', () => { console.log('got SIGTERM'); process.exit(0); });
`,
    'utf8',
);

const service = {
    id: 'demo',
    name: '演示服务',
    mode: 'managed',
    cwd: tmp,
    command: process.execPath,
    args: [scriptPath, String(port)],
    env: {},
    startupTimeoutMs: 20_000,
    stopTimeoutMs: 8_000,
    killTree: true,
    logPath,
    health: { url: `http://127.0.0.1:${port}/`, method: 'GET', expectStatus: 200, timeoutMs: 2000, intervalMs: 300, ports: [port], host: '127.0.0.1' },
};

const manager = new ServiceManager({ statePath });

console.log('managed service:');
let firstPid = 0;
await ok('check 在未启动时报告不健康', async () => {
    const health = await manager.check(service);
    assert.equal(health.ok, false);
});
await ok('start 能拉起进程并通过健康检查', async () => {
    const result = await manager.start(service, {});
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(typeof result.pid, 'number');
    assert.ok(isPidAlive(result.pid));
    firstPid = result.pid;
});
await ok('子进程 stdout 写入配置的 logPath', async () => {
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(fs.existsSync(logPath), '日志文件应存在');
    assert.match(fs.readFileSync(logPath, 'utf8'), /listening on \d+/);
});
await ok('重复 start 幂等（不重复拉起）', async () => {
    const result = await manager.start(service, {});
    assert.equal(result.reason, 'ALREADY_RUNNING');
    assert.equal(result.pid, firstPid);
});
await ok('restart 后 pid 变化且旧进程退出', async () => {
    const result = await manager.restart(service, {});
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.notEqual(result.start.pid, firstPid, 'restart 应产生新 pid');
    assert.equal(isPidAlive(firstPid), false, '旧进程应已退出');
    firstPid = result.start.pid;
});
await ok('stop 后进程退出且健康检查失败', async () => {
    const result = await manager.stop(service);
    assert.equal(result.ok, true, JSON.stringify(result));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(isPidAlive(firstPid), false);
    const health = await manager.check(service);
    assert.equal(health.ok, false);
});
await ok('restart 能在停止状态下直接拉起（自恢复）', async () => {
    const result = await manager.restart(service, {});
    assert.equal(result.ok, true, JSON.stringify(result));
    firstPid = result.start.pid;
});
await ok('状态文件记录 pid，dispose 不会杀进程', async () => {
    manager.dispose();
    assert.ok(fs.existsSync(statePath));
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(state.services.demo.pid, firstPid);
    assert.equal(isPidAlive(firstPid), true, 'dispose 后进程应继续存活');
});
await ok('新实例能从状态文件接管并停止旧进程', async () => {
    const manager2 = new ServiceManager({ statePath });
    const status = await manager2.statusAll([service]);
    assert.equal(status[0].pid, firstPid);
    const result = await manager2.stop(service);
    assert.equal(result.ok, true, JSON.stringify(result));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(isPidAlive(firstPid), false);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${process.exitCode ? 'FAILED' : 'PASSED'}: ${passed} checks`);
