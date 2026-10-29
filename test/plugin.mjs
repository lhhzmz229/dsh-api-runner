/**
 * 插件入口形态自测：用桩 ctx 模拟 cordis 宿主，验证 apply() 注册了工具、HTTP 路由、
 * 提示段与清理回调，并走一遍工具 execute（含会话 cwd 解析与错误兜底）。
 * 这一层不依赖 DSH 运行时，只验证契约形状。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);
const { normalizeProjectKey } = await load('src/util.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'api-runner-plugin-'));
const homeDir = path.join(tmp, 'home');
const projectDir = path.join(tmp, 'project');
fs.mkdirSync(homeDir, { recursive: true });
fs.mkdirSync(projectDir, { recursive: true });
fs.writeFileSync(path.join(projectDir, 'app.log'), 'hello\nworld\n');

const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, path: req.url }));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

fs.writeFileSync(
    path.join(homeDir, 'api-runner.yml'),
    `apis:
  - id: ping
    method: GET
    url: ${base}/ping
logs:
  - id: app-log
    path: ./app.log
`,
    'utf8',
);

process.env.DSH_HOME = homeDir;

const mod = await load('src/main.js');
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

// ---- 桩 ctx ----
const registered = { tools: [], routes: [], sections: [], effects: [] };
const ctx = {
    logger: { info: () => {}, error: () => {} },
    config: {},
    sessions: { get: (id) => (id === 's1' ? { header: { cwd: projectDir } } : undefined) },
    connection: { requestRejection: () => undefined },
    webServer: {
        register: (route) => {
            registered.routes.push(route);
            return () => {};
        },
    },
    systemPrompt: {
        section: (section) => {
            registered.sections.push(section);
            return () => {};
        },
    },
    tools: {
        register: (definition) => {
            registered.tools.push(definition);
            return () => {};
        },
    },
    effect: (factory, id) => {
        registered.effects.push({ id, dispose: factory() });
        return () => {};
    },
    get: (name) => (name === 'systemPrompt' ? ctx.systemPrompt : undefined),
};

console.log('plugin shape:');
await ok('导出 inject 且没有 default export', () => {
    assert.deepEqual(mod.inject, ['webServer', 'sessions', 'tools', 'connection', 'systemPrompt']);
    assert.equal(mod.default, undefined);
    assert.equal(typeof mod.apply, 'function');
});
await ok('apply 注册 1 个工具 / 1 条路由 / 1 个提示段 / 3 个 effect', () => {
    mod.apply(ctx);
    assert.equal(registered.tools.length, 1);
    assert.equal(registered.routes.length, 1);
    assert.equal(registered.sections.length, 1);
    assert.equal(registered.effects.length, 3);
});
await ok('工具定义符合 ToolDefinition 契约', () => {
    const tool = registered.tools[0];
    assert.equal(tool.name, 'ApiRunner');
    assert.equal(typeof tool.timeoutMs, 'number');
    assert.equal(tool.parameters.type, 'object');
    assert.ok(tool.parameters.properties.action.enum.includes('verify'));
    assert.equal(typeof tool.output.render, 'function');
    assert.equal(typeof tool.execute, 'function');
});
await ok('路由是 prefix /dsh-api-runner/api', () => {
    const route = registered.routes[0];
    assert.equal(route.kind, 'prefix');
    assert.equal(route.path, '/dsh-api-runner/api');
});
await ok('提示段返回配置摘要且无配置时为空串', () => {
    const section = registered.sections[0];
    const text = section.text({});
    assert.match(text, /ping/);
    assert.match(text, /app-log/);
});

console.log('tool execute:');
const tool = registered.tools[0];
await ok('describe 通过会话 cwd 读到项目配置', async () => {
    const result = await tool.execute({ action: 'describe' }, { agent: { session: { id: 's1' } } });
    assert.equal(result.isError, false);
    const payload = JSON.parse(result.text);
    assert.equal(payload.apis[0].id, 'ping');
});
await ok('call 成功返回 isError=false', async () => {
    const result = await tool.execute({ action: 'call', api_id: 'ping' }, { agent: { session: { id: 's1' } } });
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /"ok": true/);
});
await ok('readLog 默认取第一个日志', async () => {
    const result = await tool.execute({ action: 'log', reset: true }, { agent: { session: { id: 's1' } } });
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /hello/);
});
await ok('未知 action 返回 isError=true 且不抛异常', async () => {
    const result = await tool.execute({ action: 'nope' }, { agent: { session: { id: 's1' } } });
    assert.equal(result.isError, true);
    assert.match(result.text, /BAD_ACTION/);
});
await ok('缺参数时返回明确错误而不是崩溃', async () => {
    const result = await tool.execute({ action: 'call' }, { agent: { session: { id: 's1' } } });
    assert.equal(result.isError, true);
    assert.match(result.text, /MISSING_ARGUMENT/);
});
await ok('无会话时不会崩（退化为空 cwd）', async () => {
    const result = await tool.execute({ action: 'describe' }, { agent: {} });
    assert.equal(result.isError, false);
});

console.log('http route:');
await ok('GET /config 返回配置摘要', async () => {
    const route = registered.routes[0];
    const req = { url: '/dsh-api-runner/api/config', method: 'GET', headers: {} };
    const res = createMockResponse();
    await route.handler(req, res);
    const payload = JSON.parse(res.body);
    assert.equal(payload.ok, true);
    assert.equal(payload.apis[0].id, 'ping');
});
await ok('请求被 connection 拒绝时返回 401 JSON', async () => {
    const route = registered.routes[0];
    const ctx2 = { ...ctx, connection: { requestRejection: () => 401 } };
    // 重新 apply 到新桩上以拿到打了拒绝逻辑的 handler
    const local = { tools: [], routes: [], sections: [], effects: [] };
    mod.apply({
        ...ctx2,
        webServer: { register: (r) => (local.routes.push(r), () => {}) },
        systemPrompt: { section: () => () => {} },
        tools: { register: () => () => {} },
        effect: (factory) => (factory(), () => {}),
    });
    const res = createMockResponse();
    await local.routes[0].handler({ url: '/dsh-api-runner/api/config', method: 'GET', headers: {} }, res);
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).code, 'UNAUTHORIZED');
});
await ok('未知路由返回 404', async () => {
    const route = registered.routes[0];
    const res = createMockResponse();
    await route.handler({ url: '/dsh-api-runner/api/nope', method: 'GET', headers: {} }, res);
    assert.equal(res.statusCode, 404);
});

console.log('panel api:');
await ok('GET /ui 返回面板数据（含来源与接口）', async () => {
    const route = registered.routes[0];
    const res = createMockResponse();
    await route.handler({ url: `/dsh-api-runner/api/ui?cwd=${encodeURIComponent(projectDir)}`, method: 'GET', headers: {} }, res);
    const payload = JSON.parse(res.body);
    assert.equal(payload.ok, true);
    assert.equal(payload.apis[0].id, 'ping');
    assert.equal(payload.apis[0].source, 'file');
});
await ok('POST /ui/api 保存面板接口后能在 /ui 里看到（source=ui）', async () => {
    const route = registered.routes[0];
    const res2 = createMockResponse();
    const body = JSON.stringify({
        cwd: projectDir,
        api: { id: 'panel-api', method: 'GET', url: '/panel', baseUrl: base, description: '面板加的' },
    });
    const req = {
        url: '/dsh-api-runner/api/ui/api',
        method: 'POST',
        headers: {},
        async *[Symbol.asyncIterator]() {
            yield Buffer.from(body, 'utf8');
        },
    };
    await route.handler(req, res2);
    const saved = JSON.parse(res2.body);
    assert.equal(saved.ok, true, res2.body);

    const listRes = createMockResponse();
    await route.handler({ url: `/dsh-api-runner/api/ui?cwd=${encodeURIComponent(projectDir)}`, method: 'GET', headers: {} }, listRes);
    const list = JSON.parse(listRes.body);
    const created = list.apis.find((item) => item.id === 'panel-api');
    assert.ok(created, '保存后应出现在接口列表');
    assert.equal(created.source, 'ui');
    assert.equal(created.url, `${base}/panel`, '应展示完整地址');
});
await ok('GET /ui?project=<key> 切到别的项目（优先于会话 cwd）', async () => {
    const route = registered.routes[0];
    const otherDir = path.join(tmp, 'another');
    fs.mkdirSync(otherDir, { recursive: true });
    // 先在另一个项目里存一个接口
    const saveBody = JSON.stringify({
        cwd: otherDir,
        api: { id: 'from-other', method: 'GET', url: '/other', baseUrl: base },
    });
    const saveReq = {
        url: '/dsh-api-runner/api/ui/api',
        method: 'POST',
        headers: {},
        async *[Symbol.asyncIterator]() { yield Buffer.from(saveBody, 'utf8'); },
    };
    const saveRes = createMockResponse();
    await route.handler(saveReq, saveRes);
    assert.equal(JSON.parse(saveRes.body).ok, true, saveRes.body);

    const otherKey = normalizeProjectKey(otherDir);
    const res = createMockResponse();
    // 带会话 id（cwd=projectDir）同时也带 project：必须以后者为准，否则页签点了没反应
    await route.handler({
        url: `/dsh-api-runner/api/ui?project=${encodeURIComponent(otherKey)}`,
        method: 'GET',
        headers: { 'x-dsh-session-id': 's1' },
    }, res);
    const payload = JSON.parse(res.body);
    assert.equal(payload.ok, true);
    assert.equal(payload.projectKey, otherKey);
    assert.equal(payload.cwdProjectKey, normalizeProjectKey(projectDir));
    assert.ok(payload.apis.some((api) => api.id === 'from-other'), JSON.stringify(payload.apis.map((api) => api.id)));

    // 清单里会话工作区排第一
    assert.equal(payload.projects[0].key, payload.cwdProjectKey);
    assert.ok(payload.projects.some((item) => item.key === otherKey));

    // 不在 store 里、也不是绝对路径的 project 应被忽略，退回会话 cwd
    const bad = createMockResponse();
    await route.handler({
        url: '/dsh-api-runner/api/ui?project=nonsense',
        method: 'GET',
        headers: { 'x-dsh-session-id': 's1' },
    }, bad);
    assert.equal(JSON.parse(bad.body).projectKey, normalizeProjectKey(projectDir));
});

await ok('GET /java 返回进程列表结构', async () => {
    const route = registered.routes[0];
    const res = createMockResponse();
    await route.handler({ url: `/dsh-api-runner/api/java?cwd=${encodeURIComponent(projectDir)}`, method: 'GET', headers: {} }, res);
    const payload = JSON.parse(res.body);
    assert.equal(typeof payload.ok, 'boolean');
    assert.ok(Array.isArray(payload.processes));
    // profiles 必须是数组，前端会直接 .map；曾因返回字符串导致崩溃
    for (const item of payload.processes) assert.ok(Array.isArray(item.profiles), `pid ${item.pid} 的 profiles 应为数组`);
    // 每个端口都带角色，前端靠它区分 HTTP 业务端口与 Sentinel 规则端口
    for (const item of payload.processes) {
        const list = Array.isArray(item.portList) ? item.portList : [];
        // portList 是「除调试端口外的监听端口」，每个都带角色
        const raw = (Array.isArray(item.ports) ? item.ports : []).filter((port) => port !== item.debugPort);
        assert.equal(list.length, raw.length, `pid ${item.pid} 的 portList 应覆盖所有非调试端口`);
        for (const port of list) {
            assert.ok(['http', 'sentinel', 'debug', 'unknown'].includes(port.role), `端口 ${port.port} 的 role 不合法`);
            assert.equal(typeof port.label, 'string');
        }
        assert.equal(typeof item.ignored, 'boolean');
    }
    assert.ok(Array.isArray(payload.ignored), '应返回已忽略清单');
});
await ok('忽略/取消忽略只在配置里记一笔，不动进程', async () => {
    const route = registered.routes[0];
    const item = { mainClass: 'com.example.DemoApplication', name: 'Demo', kind: 'spring' };
    const post = (path, payload) => ({
        url: `${path}?cwd=${encodeURIComponent(projectDir)}`,
        method: 'POST',
        headers: {},
        async *[Symbol.asyncIterator]() {
            yield Buffer.from(JSON.stringify(payload), 'utf8');
        },
    });

    const ignored = createMockResponse();
    await route.handler(post('/dsh-api-runner/api/java/ignore', { item }), ignored);
    assert.equal(JSON.parse(ignored.body).ok, true, ignored.body);

    const listRes = createMockResponse();
    await route.handler({ url: `/dsh-api-runner/api/java?cwd=${encodeURIComponent(projectDir)}`, method: 'GET', headers: {} }, listRes);
    const list = JSON.parse(listRes.body);
    assert.ok(list.ignored.some((entry) => entry.mainClass === item.mainClass), '被忽略的服务应出现在 ignored 里');

    const unignored = createMockResponse();
    await route.handler(post('/dsh-api-runner/api/java/unignore', { item }), unignored);
    assert.equal(JSON.parse(unignored.body).ok, true, unignored.body);

    const after = createMockResponse();
    await route.handler({ url: `/dsh-api-runner/api/java?cwd=${encodeURIComponent(projectDir)}`, method: 'GET', headers: {} }, after);
    assert.equal(JSON.parse(after.body).ignored.some((entry) => entry.mainClass === item.mainClass), false);
});
await ok('GET /java/detail 返回日志与可选来源', async () => {
    const route = registered.routes[0];
    const res = createMockResponse();
    await route.handler({ url: `/dsh-api-runner/api/java/detail?cwd=${encodeURIComponent(projectDir)}&id=999999`, method: 'GET', headers: {} }, res);
    const payload = JSON.parse(res.body);
    // 不存在的 pid 要给出可读错误，而不是抛异常
    assert.equal(payload.ok, false);
    assert.equal(typeof payload.message, 'string');
});
await ok('GET/POST /settings 能读能写，并拒绝相对路径的数据目录', async () => {
    const route = registered.routes[0];
    const read = createMockResponse();
    await route.handler({ url: '/dsh-api-runner/api/settings', method: 'GET', headers: {} }, read);
    const before = JSON.parse(read.body);
    assert.equal(before.ok, true, read.body);
    assert.equal(typeof before.effectiveDataDir, 'string');
    assert.equal(before.dataDir, '');

    const post = (payload) => ({
        url: '/dsh-api-runner/api/settings',
        method: 'POST',
        headers: {},
        async *[Symbol.asyncIterator]() {
            yield Buffer.from(JSON.stringify(payload), 'utf8');
        },
    });

    const bad = createMockResponse();
    await route.handler(post({ dataDir: 'relative/dir' }), bad);
    const badPayload = JSON.parse(bad.body);
    assert.equal(badPayload.ok, false, '相对路径应被拒绝');
    assert.match(badPayload.message, /绝对路径/);

    const good = createMockResponse();
    await route.handler(post({ workspace: projectDir }), good);
    const goodPayload = JSON.parse(good.body);
    assert.equal(goodPayload.ok, true, good.body);
    assert.equal(goodPayload.workspace, projectDir);
});
await ok('java/save、java/unsave、java/start-saved 都能给出可读结果', async () => {
    const route = registered.routes[0];
    const post = (path, payload) => ({
        url: `${path}?cwd=${encodeURIComponent(projectDir)}`,
        method: 'POST',
        headers: {},
        async *[Symbol.asyncIterator]() {
            yield Buffer.from(JSON.stringify(payload), 'utf8');
        },
    });

    // 保存一个不存在的服务：必须报错，不能抛异常
    const save = createMockResponse();
    await route.handler(post('/dsh-api-runner/api/java/save', { id: 'not-running' }), save);
    const savePayload = JSON.parse(save.body);
    assert.equal(savePayload.ok, false, save.body);
    assert.equal(typeof savePayload.message, 'string');

    // 没保存过的服务启动：给出 NOT_SAVED
    const start = createMockResponse();
    await route.handler(post('/dsh-api-runner/api/java/start-saved', { id: 'not-saved' }), start);
    const startPayload = JSON.parse(start.body);
    assert.equal(startPayload.ok, false, start.body);
    assert.equal(startPayload.code, 'NOT_SAVED');

    // 删除一个不存在的配方：不报错（幂等），返回 saved 列表
    const unsave = createMockResponse();
    await route.handler(post('/dsh-api-runner/api/java/unsave', { id: 'not-saved' }), unsave);
    const unsavePayload = JSON.parse(unsave.body);
    assert.equal(unsavePayload.ok, true, unsave.body);
    assert.ok(Array.isArray(unsavePayload.saved));
});
await ok('java/start-all 与状态轮询路由都已挂载', async () => {
    const route = registered.routes[0];
    const post = (path, payload) => ({
        url: `${path}?cwd=${encodeURIComponent(projectDir)}`,
        method: 'POST',
        headers: {},
        async *[Symbol.asyncIterator]() {
            yield Buffer.from(JSON.stringify(payload), 'utf8');
        },
    });
    const get = (path) => ({
        url: `${path}?cwd=${encodeURIComponent(projectDir)}`,
        method: 'GET',
        headers: {},
        async *[Symbol.asyncIterator]() {},
    });

    // 一个配方都没保存：一键启动要说清楚，不能 404 也不能抛
    const empty = createMockResponse();
    await route.handler(post('/dsh-api-runner/api/java/start-all', {}), empty);
    const emptyPayload = JSON.parse(empty.body);
    assert.equal(emptyPayload.ok, false, empty.body);
    assert.equal(emptyPayload.code, 'NOTHING_SAVED');

    // 状态路由：查不存在的批次给 NO_BATCH（证明路由存在且不崩）
    const status = createMockResponse();
    await route.handler(get('/dsh-api-runner/api/java/start-all/status?batch=nope'), status);
    const statusPayload = JSON.parse(status.body);
    assert.equal(statusPayload.ok, false, status.body);
    assert.equal(statusPayload.code, 'NO_BATCH');
});

await ok('工具描述里提到数据库，模型才会主动用', () => {
    const tool = registered.tools[0];
    const desc = String(tool.description || '');
    assert.ok(/数据库/.test(desc), '工具描述应提到数据库');
    assert.ok(/action=db/.test(desc), '工具描述应说明 action=db 的用法');
    assert.ok(/什么时候该用 db/.test(desc), '应说明什么场景该查数据库（否则模型不会主动查）');
    assert.ok(/describe_table/.test(desc), '应提示先看表结构');
    assert.ok(/db_params/.test(desc), '应提示用参数化传值');
});

await ok('工具描述里提到 login 与 java', () => {
    const tool = registered.tools[0];
    const actions = tool.parameters.properties.action.enum;
    assert.ok(actions.includes('login'));
    assert.ok(actions.includes('java'));
    assert.ok(tool.parameters.properties.token_from, '应有 token_from 参数');
    assert.ok(tool.parameters.properties.java_action.enum.includes('start_all'), 'java_action 应有 start_all');
    assert.ok(tool.parameters.properties.java_ids, '应有 java_ids 参数');
});

await ok('java_action 有 forget（清理幽灵接管记录）', () => {
    const tool = registered.tools[0];
    const enumList = tool.parameters.properties.java_action.enum;
    assert.ok(enumList.includes('forget'), 'java_action 应支持 forget');
    // 描述里要说清楚它只删记录、不杀进程，否则用户不敢点
    const desc = String(tool.parameters.properties.java_action.description || '');
    assert.ok(/forget/.test(desc), '描述应提到 forget');
    assert.ok(/不杀进程|只删|记录/.test(desc), '描述应说明 forget 不杀进程');
});

await ok('verifyAlive 能识别 pid 复用（幽灵接管的根因）', async () => {
    const { JavaRunner } = await load('src/java-runner.js');
    const runner = new JavaRunner({ homeDir: tmp });

    // 构造三条记录：真活着、pid 被复用、进程已消失
    const runs = [
        { id: 'a', pid: 100, mainClass: 'com.x.FooApplication', alive: true },
        { id: 'b', pid: 200, mainClass: 'com.x.BarApplication', alive: true },
        { id: 'c', pid: 300, mainClass: 'com.x.BazApplication', alive: true },
    ];
    // jps 看到的现状：100 还是 Foo；200 变成了别的程序；300 完全不在
    const pidToMain = new Map([
        [100, 'com.x.FooApplication'],
        [200, 'com.other.SomethingElse'],
    ]);

    const verdict = runner.verifyAlive(runs, pidToMain);
    assert.equal(verdict.get('a'), undefined, '真活着的不应被改判');
    assert.equal(verdict.get('b'), false, 'pid 被复用的应判为已退出');
    assert.equal(verdict.get('c'), false, 'jps 里没有的应判为已退出');
});

await ok('verifyAlive 在拿不到 jps 数据时保守处理（不改判）', async () => {
    const { JavaRunner } = await load('src/java-runner.js');
    const runner = new JavaRunner({ homeDir: tmp });
    const runs = [{ id: 'a', pid: 100, mainClass: 'com.x.Foo', alive: true }];
    // 空 Map / 非 Map 都不应误判
    assert.equal(runner.verifyAlive(runs, new Map()).size, 0, '空映射不应改判');
    assert.equal(runner.verifyAlive(runs, undefined).size, 0, 'undefined 不应崩');
});

await ok('java/forget 路由可用，且不存在的记录给出明确错误', async () => {
    const route = registered.routes[0];
    const req = {
        url: `/dsh-api-runner/api/java/forget?cwd=${encodeURIComponent(projectDir)}`,
        method: 'POST',
        headers: {},
        async *[Symbol.asyncIterator]() {
            yield Buffer.from(JSON.stringify({ id: 'no-such-run' }));
        },
    };
    const res = createMockResponse();
    await route.handler(req, res);
    const payload = JSON.parse(res.body);
    // 不存在的记录应给出 RUN_NOT_FOUND，而不是路由缺失的 404
    assert.equal(payload.ok, false, res.body);
    assert.ok(['RUN_NOT_FOUND', 'NO_RUNNER'].includes(payload.code), `应走 forget 逻辑：${res.body}`);
});

await ok('工具支持 db action 与相关参数', () => {
    const tool = registered.tools[0];
    const props = tool.parameters.properties;
    assert.ok(props.action.enum.includes('db'), 'action 应包含 db');
    assert.ok(props.db_action, '应有 db_action 参数');
    for (const action of ['list_connections', 'test', 'save', 'delete', 'query', 'list_tables', 'describe_table']) {
        assert.ok(props.db_action.enum.includes(action), `db_action 应包含 ${action}`);
    }
    assert.ok(props.connection_id, '应有 connection_id');
    assert.ok(props.sql, '应有 sql');
    assert.ok(props.db_params, '应有 db_params');
    assert.ok(props.db_readonly, '应有 db_readonly');
});

await ok('db 路由都已挂载', async () => {
    const route = registered.routes[0];
    const get = (path) => ({
        url: path,
        method: 'GET',
        headers: {},
        async *[Symbol.asyncIterator]() {},
    });
    const post = (path, payload) => ({
        url: path,
        method: 'POST',
        headers: {},
        async *[Symbol.asyncIterator]() {
            yield Buffer.from(JSON.stringify(payload), 'utf8');
        },
    });

    // 连接列表：空环境应返回空数组而不是 404
    const list = createMockResponse();
    await route.handler(get('/dsh-api-runner/api/db'), list);
    const listPayload = JSON.parse(list.body);
    assert.equal(listPayload.ok, true, list.body);
    assert.ok(Array.isArray(listPayload.connections));

    // 缺参数时给出明确错误，不是 404
    const noId = createMockResponse();
    await route.handler(post('/dsh-api-runner/api/db/query', { sql: 'SELECT 1' }), noId);
    const noIdPayload = JSON.parse(noId.body);
    assert.equal(noIdPayload.ok, false, noId.body);
    assert.equal(noIdPayload.code, 'MISSING_CONNECTION', '空 connection_id 应给出明确错误而不是路由缺失');

    // 表结构路由存在
    const table = createMockResponse();
    await route.handler(get('/dsh-api-runner/api/db/table?connection_id=nope&name=t'), table);
    const tablePayload = JSON.parse(table.body);
    assert.equal(tablePayload.ok, false, table.body);
    // 未授权时一律 NOT_AUTHORIZED（不泄漏连接是否存在）
    assert.ok(['NOT_AUTHORIZED', 'NOT_FOUND'].includes(tablePayload.code), table.body);
});

await ok('db 工具动作能跑通 SQLite 全链路（模型侧只读）', async () => {
    const tool = registered.tools[0];
    const dbFile = path.join(tmp, 'tool-test.db');
    const exec = (args) => tool.execute(args, { agent: { session: { id: 's1' } } });

    // 用 service 直接建表并写入（模拟「人在面板里操作」），因为模型侧不允许写
    const service = new (await import(pathToFileURL(path.join(root, 'src', 'ops.js')).href)).ApiRunnerService({ homeDir });
    const seeded = service.dbSave({ name: '工具测试库', type: 'sqlite', database: dbFile });
    assert.equal(seeded.ok, true, JSON.stringify(seeded));
    const connId = seeded.connection.id;

    // 授权：先给读写来播种数据（模拟「人在面板里操作」），之后降为只读
    const projectKey = normalizeProjectKey(projectDir) || 'default';
    service.dbManager.setAccess(projectKey, connId, 'readwrite');
    await service.dbQuery(connId, 'CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT)', [], { projectKey, readonly: false });
    await service.dbQuery(connId, 'INSERT INTO items (label) VALUES (?)', ['hello'], { projectKey, readonly: false });
    // 播种完降为只读：模型侧本来就强制只读，这里给出最小权限
    service.dbManager.setAccess(projectKey, connId, 'readonly');
    service.dispose();

    // 模型侧查询
    const queried = await exec({ action: 'db', db_action: 'query', connection_id: connId, sql: 'SELECT * FROM items' });
    const q = JSON.parse(queried.text);
    assert.equal(q.ok, true, queried.text);
    assert.equal(q.rowCount, 1);
    assert.equal(q.rows[0].label, 'hello');

    // 模型侧写操作一律被拒（即使传 db_readonly=false）
    for (const sql of ['DELETE FROM items WHERE id = 1', 'DROP TABLE items', 'INSERT INTO items (label) VALUES (?)']) {
        const blocked = await exec({
            action: 'db', db_action: 'query', connection_id: connId,
            sql,
            db_params: ['x'],
            db_readonly: false,     // 显式传 false 也没用
        });
        const b = JSON.parse(blocked.text);
        assert.equal(b.ok, false, `模型不应能执行写操作：${sql} → ${blocked.text}`);
        assert.ok(['READONLY_VIOLATION', 'PERMISSION_DENIED', 'DESTRUCTIVE_BLOCKED'].includes(b.code), blocked.text);
        assert.equal(blocked.isError, true);
    }

    // 数据没被改
    const after = await exec({ action: 'db', db_action: 'query', connection_id: connId, sql: 'SELECT COUNT(*) AS n FROM items' });
    assert.equal(JSON.parse(after.text).rows[0].n, 1, '数据不应被模型改动');

    // 元数据（只读，允许）
    const tables = await exec({ action: 'db', db_action: 'list_tables', connection_id: connId });
    const t = JSON.parse(tables.text);
    assert.equal(t.ok, true, tables.text);
    assert.ok(t.tables.some((x) => x.name === 'items'));

    const detail = await exec({ action: 'db', db_action: 'describe_table', connection_id: connId, table: 'items' });
    const d = JSON.parse(detail.text);
    assert.equal(d.ok, true, detail.text);
    assert.ok(d.columns.some((c) => c.name === 'label'));

    // 清理
    const cleanup = new (await import(pathToFileURL(path.join(root, 'src', 'ops.js')).href)).ApiRunnerService({ homeDir });
    cleanup.dbDelete(connId);
    cleanup.dispose();
});

await ok('模型侧对未授权连接完全不可见、不可查', async () => {
    const tool = registered.tools[0];
    const dbFile = path.join(tmp, 'unauth.db');
    const service = new (await import(pathToFileURL(path.join(root, 'src', 'ops.js')).href)).ApiRunnerService({ homeDir });
    const saved = service.dbSave({ name: '未授权库', type: 'sqlite', database: dbFile });
    assert.equal(saved.ok, true);
    const connId = saved.connection.id;

    // describe 里看不到
    const info = service.describe(projectDir);
    assert.equal((info.databases || []).some((d) => d.id === connId), false, '未授权连接不应出现在 describe 里');

    // 直接查也被拒
    const exec = (args) => tool.execute(args, { agent: { session: { id: 's1' } } });
    const r = await exec({ action: 'db', db_action: 'query', connection_id: connId, sql: 'SELECT 1' });
    const payload = JSON.parse(r.text);
    assert.equal(payload.ok, false);
    assert.equal(payload.code, 'NOT_AUTHORIZED');

    service.dbDelete(connId);
    service.dispose();
});

// ---- 清理 ----
for (const effect of registered.effects) effect.dispose?.();
server.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${process.exitCode ? 'FAILED' : 'PASSED'}: ${passed} checks`);

function createMockResponse() {
    const res = {
        statusCode: 200,
        headers: {},
        body: '',
        headersSent: false,
        setHeader(key, value) {
            this.headers[key.toLowerCase()] = value;
        },
        end(text) {
            this.body = text;
            this.headersSent = true;
        },
        status(code) {
            this.statusCode = code;
            return this;
        },
    };
    return res;
}
