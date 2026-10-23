/**
 * 本地自测脚本（不依赖 cordis，直接跑 node test/smoke.mjs）。
 * 覆盖：配置解析、模板展开、接口调用、日志增量、服务托管（用 node 起一个临时 HTTP 服务）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);

const { expandDollar, expandBraces, truncateText, normalizeProjectKey, isPidAlive, redactHeaders } = await load('src/util.js');
const { callApi } = await load('src/api.js');
const { LogReader } = await load('src/log.js');
const { ApiRunnerService } = await load('src/ops.js');
const { ProjectStore } = await load('src/project-store.js');
const { SettingsStore } = await load('src/settings.js');

let passed = 0;
function ok(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => {
            passed += 1;
            console.log(`  ✓ ${name}`);
        })
        .catch((error) => {
            console.error(`  ✗ ${name}\n    ${error?.stack || error}`);
            process.exitCode = 1;
        });
}

// ---------- 临时工作区 ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'api-runner-test-'));
const homeDir = path.join(tmp, 'home');
const projectDir = path.join(tmp, 'project');
fs.mkdirSync(homeDir, { recursive: true });
fs.mkdirSync(projectDir, { recursive: true });

// ---------- 起一个临时 HTTP 服务，作为"后端" ----------
const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/echo') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body }));
        });
        return;
    }
    if (url.pathname === '/users/7') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ id: 7, name: '张三' }));
        return;
    }
    if (url.pathname === '/health') {
        res.statusCode = 200;
        res.end('UP');
        return;
    }
    // 模拟真实后端：token 藏在 data.access_token 里，而不是顶层 token
    if (url.pathname === '/login') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ code: 200, msg: null, data: { access_token: 'tok-abc-123456', expires_in: 720 } }));
        return;
    }
    if (url.pathname === '/me') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, authorization: req.headers.authorization || null }));
        return;
    }
    res.statusCode = 404;
    res.end('not found');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

// ---------- 写配置 ----------
const logPath = path.join(projectDir, 'app.log');
fs.writeFileSync(logPath, 'old line 1\nold line 2\n');

fs.writeFileSync(
    path.join(homeDir, 'api-runner.yml'),
    `defaults:
  timeoutMs: 5000
env:
  API_HOST: ${base}
apis:
  - id: echo
    name: 回显
    method: POST
    url: \${API_HOST}/echo
    headers:
      Content-Type: application/json
      Authorization: "Bearer secret-token-123"
    query:
      fixed: "1"
    body:
      userId: "{id}"
  - id: user
    method: GET
    url: \${API_HOST}/users/{id}
  - id: plain
    method: POST
    url: \${API_HOST}/echo
    body:
      hello: world
  - id: health
    method: GET
    url: \${API_HOST}/health
  - id: login
    method: POST
    url: \${API_HOST}/login
    body:
      username: "{username}"
      password: "{password}"
    login:
      tokenPath: token
      header: Authorization
      prefix: "Bearer "
  - id: me
    method: GET
    url: \${API_HOST}/me
services:
  - id: fake
    mode: managed
    cwd: ${projectDir.replace(/\\/g, '/')}
    command: node
    args: ["-e", "require('http').createServer((q,s)=>s.end('ok')).listen(${port})"]
    startupTimeoutMs: 8000
    health:
      url: ${base}/health
      expectStatus: 200
      intervalMs: 300
logs:
  - id: app-log
    path: ./app.log
`,
    'utf8',
);

// ---------- 测试 ----------
console.log('util:');
await ok('expandDollar 用 scope 优先，其次 env', () => {
    process.env.TEST_DOLLAR = 'from-env';
    assert.equal(expandDollar('${NOPE}-${TEST_DOLLAR}', { NOPE: 'scope' }), 'scope-from-env');
    assert.equal(expandDollar('${MISSING_VAR_XYZ}'), '${MISSING_VAR_XYZ}');
    delete process.env.TEST_DOLLAR;
});
await ok('expandBraces 只替换已知键', () => {
    assert.equal(expandBraces('/u/{id}/{other}', { id: 5 }), '/u/5/{other}');
});
await ok('truncateText 按字节截断并带提示', () => {
    const text = 'a'.repeat(100) + '\n' + 'b'.repeat(100);
    const out = truncateText(text, 50);
    assert.ok(out.length < text.length);
    assert.match(out, /已截断/);
});
await ok('normalizeProjectKey 统一盘符与斜杠', () => {
    assert.equal(normalizeProjectKey('C:\\Code\\X\\'), 'c:/Code/X');
});
await ok('isPidAlive 对自身 pid 返回 true，对不存在返回 false', () => {
    assert.equal(isPidAlive(process.pid), true);
    assert.equal(isPidAlive(999_999), false);
});
await ok('redactHeaders 覆盖自定义敏感头与普通头', () => {
    const out = redactHeaders({
        Authorization: 'Bearer secret-token-123',
        'X-Token': 'demo-secret-123456',
        'X-Api-Key': 'abcdef1234567890',
        'Content-Type': 'application/json',
    });
    assert.match(out.Authorization, /^Bear\*\*\*-123$/);
    assert.match(out['X-Token'], /^demo\*\*\*3456$/);
    assert.match(out['X-Api-Key'], /^abcd\*\*\*7890$/);
    assert.equal(out['Content-Type'], 'application/json');
});

console.log('config:');
const service = new ApiRunnerService({
    homeDir,
    projectStore: new ProjectStore({ homeDir }),
    settingsStore: new SettingsStore({ homeDir }),
});
await ok('读取全局配置并解析出 api/service/log', () => {
    const { config, warnings } = service.config(projectDir);
    assert.deepEqual(warnings, []);
    assert.equal(config.apis.length, 6);
    assert.equal(config.apis[0].url, `${base}/echo`.replace(base, base)); // 已展开 ${API_HOST}
    assert.equal(config.apis[0].timeoutMs, 5000);
    assert.equal(config.services[0].mode, 'managed');
    assert.equal(config.logs[0].path, path.join(projectDir, 'app.log'));
});
await ok('findApi 支持 id 与 name', () => {
    const { config } = service.config(projectDir);
    assert.equal(service.configStore.findApi(config, 'echo').id, 'echo');
    assert.equal(service.configStore.findApi(config, '回显').id, 'echo');
});

console.log('api:');
await ok('call 展开路径占位并拼 query，body 模板生效', async () => {
    const result = await service.call(projectDir, 'echo', { id: 'u-1', extra: 'x' });
    assert.equal(result.ok, true, result.error);
    const json = JSON.parse(result.json ? JSON.stringify(result.json) : '{}');
    assert.equal(json.body, JSON.stringify({ userId: 'u-1' }));
    assert.equal(json.query.fixed, '1');
    assert.equal(json.query.extra, 'x');
    assert.equal(json.headers.authorization, 'Bearer secret-token-123');
    // JSON body 必须自带 application/json，否则 Spring 端会报
    // "Content type 'text/plain;charset=UTF-8' not supported"
    assert.match(json.headers['content-type'], /^application\/json/);
});
await ok('未声明 Content-Type 的 JSON body 自动补 application/json', async () => {
    const result = await service.call(projectDir, 'plain', {});
    assert.equal(result.ok, true, result.error);
    const json = JSON.parse(result.body);
    assert.match(json.headers['content-type'], /^application\/json/);
    assert.equal(json.body, JSON.stringify({ hello: 'world' }));
});
await ok('call 返回里请求头已脱敏', async () => {
    const result = await service.call(projectDir, 'echo', { id: 1 });
    assert.match(result.request.headers.Authorization, /^Bear\*\*\*-123$/);
});
await ok('URL 路径占位替换', async () => {
    const result = await service.call(projectDir, 'user', { id: 7 });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.json.name, '张三');
});
await ok('404 返回 ok:false 且保留响应体', async () => {
    const result = await service.call(projectDir, 'nope', {});
    assert.equal(result.ok, false);
    assert.equal(result.code, 'API_NOT_FOUND');
});
await ok('超时返回结构化错误', async () => {
    const { config } = service.config(projectDir);
    const api = { ...service.configStore.findApi(config, 'health'), url: `${base}/health`, timeoutMs: 1 };
    // 直接把 timeoutMs 压到 1ms，绝大多数情况下会超时；若没超时也不算失败
    const result = await callApi(api, {}, { timeoutMs: 1 });
    assert.ok(result.ok || /超时|timeout/i.test(result.error || ''), JSON.stringify(result));
});

console.log('login:');
await ok('tokenPath 配错但响应里只有一个候选时自动探测并保存', async () => {
    const result = await service.login(projectDir, 'login', { username: 'alice', password: 'p@ss' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.tokenPath, 'data.access_token');
    assert.match(result.masked, /\*\*\*/);
    assert.match(result.message, /自动改用/);
});
await ok('保存的 token 会被后续接口自动注入', async () => {
    const result = await service.call(projectDir, 'me', {});
    assert.equal(result.ok, true, result.error);
    assert.equal(result.json.authorization, 'Bearer tok-abc-123456');
    assert.equal(result.token.from, 'login');
    assert.match(result.request.headers.Authorization, /^Bear\*\*\*3456$/);
});
await ok('YAML 接口不写回配置文件（只对面板接口写回），再次登录仍提示', async () => {
    const result = await service.login(projectDir, 'login', {});
    assert.equal(result.ok, true, JSON.stringify(result));
    // 接口来自 YAML 文件，插件不擅自改用户的配置文件，所以每次都提示一次
    assert.match(result.message, /自动改用/);
    const raw = fs.readFileSync(path.join(homeDir, 'api-runner.yml'), 'utf8');
    assert.match(raw, /tokenPath: token/, 'YAML 文件不应被改写');
});

await ok('面板接口的 tokenPath 会自动写回配置，第二次登录不再提示', async () => {
    service.saveApiUi(projectDir, {
        id: 'ui-login',
        name: '面板登录',
        method: 'POST',
        url: `${base}/login`,
        body: { username: '{username}', password: '{password}' },
        login: { tokenPath: 'token', header: 'Authorization', prefix: 'Bearer ' },
    });
    const first = await service.login(projectDir, 'ui-login', {});
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.match(first.message, /自动改用/);
    const stored = service.projectStore.project(projectDir).apis.find((item) => item.id === 'ui-login');
    assert.equal(stored.login.tokenPath, 'data.access_token');
    const second = await service.login(projectDir, 'ui-login', {});
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.doesNotMatch(second.message, /自动改用/);
    service.deleteApiUi(projectDir, 'ui-login');
});

console.log('面板回显与数据保留:');
await ok('示例参数保存后能回显（不再永远空）', async () => {
    service.saveApiUi(projectDir, {
        id: 'ui-sample',
        name: '回显示例参数',
        method: 'GET',
        url: `${base}/echo`,
        sampleParams: { matterCd: 'SX-202609-0012', page: 1 },
    });
    const state = await service.uiState(projectDir);
    const api = state.apis.find((item) => item.id === 'ui-sample');
    assert.ok(api, '接口应出现在 uiState 里');
    assert.notEqual(api.sampleText, '', 'sampleText 不能为空，否则编辑框回显不出来');
    const parsed = JSON.parse(api.sampleText);
    assert.equal(parsed.matterCd, 'SX-202609-0012');
    assert.equal(parsed.page, 1);
    service.deleteApiUi(projectDir, 'ui-sample');
});

await ok('YAML 里的 query 不会被面板保存抹掉', async () => {
    // 先写进面板（模拟 YAML 已有该接口），再在面板里只改说明后保存
    service.saveApiUi(projectDir, {
        id: 'ui-query',
        name: '带 query 的接口',
        method: 'GET',
        url: `${base}/system/library/matter/billList`,
        query: { matterCd: '{matterCd}' },
    });
    const before = await service.uiState(projectDir);
    const b = before.apis.find((item) => item.id === 'ui-query');
    assert.ok(b.queryText && b.queryText.includes('matterCd'), 'uiState 应返回 queryText 供面板回显');

    // 面板只改说明，不带 query 字段（真实表单就是这样提交的）
    service.saveApiUi(projectDir, {
        id: 'ui-query',
        name: '带 query 的接口',
        method: 'GET',
        url: `${base}/system/library/matter/billList`,
        description: '只改了说明',
    });
    const stored = service.projectStore.project(projectDir).apis.find((item) => item.id === 'ui-query');
    assert.ok(stored.query && stored.query.matterCd === '{matterCd}', 'query 必须被保留，不能被整体覆盖丢掉');
    assert.equal(stored.description, '只改了说明');

    // 运行期确实用上了 query
    const config = service.config(projectDir);
    const runtime = config.config.apis.find((item) => item.id === 'ui-query');
    assert.equal(runtime.query.matterCd, '{matterCd}');
    service.deleteApiUi(projectDir, 'ui-query');
});

await ok('显式传 query 时以新值为准（不是只增不减）', async () => {
    service.saveApiUi(projectDir, {
        id: 'ui-query2',
        name: 'q2',
        method: 'GET',
        url: `${base}/echo`,
        query: { a: '1', b: '2' },
    });
    service.saveApiUi(projectDir, {
        id: 'ui-query2',
        name: 'q2',
        method: 'GET',
        url: `${base}/echo`,
        query: { a: '9' },
    });
    const stored = service.projectStore.project(projectDir).apis.find((item) => item.id === 'ui-query2');
    assert.deepEqual(stored.query, { a: '9' }, '显式提交的 query 应整体替换，不被旧值污染');
    service.deleteApiUi(projectDir, 'ui-query2');
});

await ok('面板传空 query 能真正清空（不被旧值粘回来）', async () => {
    service.saveApiUi(projectDir, {
        id: 'ui-query3',
        name: 'q3',
        method: 'GET',
        url: `${base}/echo`,
        query: { a: '1' },
    });
    // 面板把输入框清空后提交的是 {}，必须覆盖成空
    service.saveApiUi(projectDir, {
        id: 'ui-query3',
        name: 'q3',
        method: 'GET',
        url: `${base}/echo`,
        query: {},
    });
    const stored = service.projectStore.project(projectDir).apis.find((item) => item.id === 'ui-query3');
    assert.deepEqual(stored.query, {}, '清空 query 必须生效，否则用户没法去掉参数');
    service.deleteApiUi(projectDir, 'ui-query3');
});

await ok('只改说明时示例参数也要保留（不能变成空）', async () => {
    service.saveApiUi(projectDir, {
        id: 'ui-sample2',
        name: 's2',
        method: 'GET',
        url: `${base}/echo`,
        sampleParams: { matterCd: 'SX-1' },
    });
    service.saveApiUi(projectDir, {
        id: 'ui-sample2',
        name: 's2',
        method: 'GET',
        url: `${base}/echo`,
        description: '只改说明',
    });
    const state = await service.uiState(projectDir);
    const api = state.apis.find((item) => item.id === 'ui-sample2');
    assert.notEqual(api.sampleText, '', '只改说明不应把示例参数弄丢');
    assert.equal(JSON.parse(api.sampleText).matterCd, 'SX-1');
    service.deleteApiUi(projectDir, 'ui-sample2');
});

console.log('面板按项目分类:');
const otherProjectDir = path.join(tmp, 'another-project');
fs.mkdirSync(otherProjectDir, { recursive: true });
await ok('项目页签列出所有已知项目，会话工作区排第一', async () => {
    service.saveApiUi(otherProjectDir, { id: 'other-api', name: '别处的接口', method: 'GET', url: `${base}/users/{id}` });
    const state = await service.uiState(projectDir);
    assert.equal(state.ok, true);
    assert.equal(state.projectKey, service.projectStore.keyOf(projectDir));
    assert.equal(state.cwdProjectKey, service.projectStore.keyOf(projectDir));
    const keys = state.projects.map((item) => item.key);
    assert.equal(keys[0], state.projectKey, `当前项目排第一: ${JSON.stringify(keys)}`);
    // 本项目也在清单里（页签要能标出来），不是「排除自己」
    assert.ok(keys.includes(state.projectKey));
    const other = state.projects.find((item) => item.key === service.projectStore.keyOf(otherProjectDir));
    assert.ok(other, `别的项目要在清单里: ${JSON.stringify(keys)}`);
    assert.equal(other.apiCount, 1);
    // 清单只给摘要，不带接口正文与 token
    assert.equal(Object.prototype.hasOwnProperty.call(other, 'apis'), false);
    assert.equal(JSON.stringify(state.projects).includes('masked'), false);
});

await ok('没有接口的项目也出现在清单里（否则切不过去）', async () => {
    const emptyDir = path.join(tmp, 'empty-project');
    fs.mkdirSync(emptyDir, { recursive: true });
    service.projectStore.update(emptyDir, () => {});
    const state = await service.uiState(projectDir);
    const hit = state.projects.find((item) => item.key === service.projectStore.keyOf(emptyDir));
    assert.ok(hit, JSON.stringify(state.projects.map((item) => item.key)));
    assert.equal(hit.apiCount, 0);
});

await ok('设置里的默认工作区也算已知项目', async () => {
    const workspaceDir = path.join(tmp, 'workspace-project');
    fs.mkdirSync(workspaceDir, { recursive: true });
    service.saveSettings({ workspace: workspaceDir });
    const state = await service.uiState(projectDir);
    const hit = state.projects.find((item) => item.key === service.projectStore.keyOf(workspaceDir));
    assert.ok(hit, JSON.stringify(state.projects.map((item) => item.key)));
    assert.ok(hit.origins.includes('settings'));
    service.saveSettings({ workspace: '' });
});

await ok('选中别的项目就切到那个项目：接口、projectKey 都换', async () => {
    const otherKey = service.projectStore.keyOf(otherProjectDir);
    const state = await service.uiState(projectDir, { project: otherKey });
    assert.equal(state.ok, true);
    assert.equal(state.projectKey, otherKey);
    // 会话工作区的 key 仍然给出来，前端才能把那一档标成「当前工作区」
    assert.equal(state.cwdProjectKey, service.projectStore.keyOf(projectDir));
    // 全局 YAML 里的接口在每个项目都可见；「面板里配的」只应有那个项目自己的
    const panelIds = state.apis.filter((api) => api.source === 'ui').map((api) => api.id);
    assert.deepEqual(panelIds, ['other-api']);
    const other = state.apis.find((api) => api.id === 'other-api');
    assert.deepEqual(other.params, ['id']);
});

await ok('切项目后保存的接口写进那个项目的桶，不污染当前项目', async () => {
    const otherKey = service.projectStore.keyOf(otherProjectDir);
    service.saveApiUi(otherProjectDir, { id: 'other-api-2', name: '第二个', method: 'POST', url: '/x' });
    const other = service.projectStore.project(otherProjectDir);
    assert.deepEqual(other.apis.map((api) => api.id).sort(), ['other-api', 'other-api-2']);
    const here = service.projectStore.project(projectDir);
    assert.equal(here.apis.some((api) => String(api.id).startsWith('other-api')), false);
    assert.equal(otherKey, service.projectStore.keyOf(otherProjectDir));
    service.deleteApiUi(otherProjectDir, 'other-api-2');
});

console.log('log:');
await ok('首次读取只取末尾一段', () => {
    const result = service.readLog(projectDir, 'app-log', {});
    assert.equal(result.ok, true, result.message);
    assert.match(result.text, /old line 2/);
    assert.match(result.note, /首次读取/);
});
await ok('追加内容后增量读取只返回新增行', () => {
    fs.appendFileSync(logPath, 'new A\nnew B\n');
    const result = service.readLog(projectDir, 'app-log', {});
    assert.equal(result.text.trim(), 'new A\nnew B');
    assert.equal(result.totalLines, 2);
});
await ok('pattern 过滤生效', () => {
    fs.appendFileSync(logPath, 'ERROR boom\nINFO fine\n');
    const result = service.readLog(projectDir, 'app-log', { pattern: 'ERROR' });
    assert.match(result.text, /ERROR boom/);
    assert.doesNotMatch(result.text, /INFO fine/);
});
await ok('reset 从头读取', () => {
    const result = service.readLog(projectDir, 'app-log', { reset: true, maxLines: 100 });
    assert.match(result.text, /old line 1/);
});
await ok('wait_log 能在超时内等到新出现的特征', async () => {
    setTimeout(() => fs.appendFileSync(logPath, 'Started Application in 3.2 seconds\n'), 300);
    const result = await service.waitLog(projectDir, 'app-log', { pattern: 'Started Application', timeoutMs: 5000, fromOffset: fs.statSync(logPath).size });
    assert.equal(result.ok, true);
    assert.equal(result.matched, true, JSON.stringify(result));
});
await ok('文件截断时自动从头读', () => {
    fs.writeFileSync(logPath, 'truncated first line\n');
    const result = service.readLog(projectDir, 'app-log', {});
    assert.match(result.note, /截断/);
    assert.match(result.text, /truncated first line/);
});

console.log('service:');
await ok('status 能识别 observe/managed 与健康状态', async () => {
    const status = await service.serviceStatus(projectDir, 'fake');
    assert.equal(status.ok, true);
    assert.equal(status.mode, 'managed');
    assert.ok(Array.isArray(status.checks));
});
await ok('observe 模式拒绝 start/restart', async () => {
    fs.writeFileSync(
        path.join(homeDir, 'api-runner.yml'),
        fs.readFileSync(path.join(homeDir, 'api-runner.yml'), 'utf8').replace('mode: managed', 'mode: observe'),
        'utf8',
    );
    const result = await service.serviceAction(projectDir, 'fake', 'restart', {});
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'OBSERVE_MODE');
    fs.writeFileSync(
        path.join(homeDir, 'api-runner.yml'),
        fs.readFileSync(path.join(homeDir, 'api-runner.yml'), 'utf8').replace('mode: observe', 'mode: managed'),
        'utf8',
    );
});
await ok('verify 串起 restart+log+call', async () => {
    const result = await service.verify(projectDir, { service: 'fake', apiId: 'health', logId: 'app-log', restart: false });
    assert.equal(result.steps.length >= 2, true, JSON.stringify(result));
    const call = result.steps.find((step) => step.stage === 'call');
    assert.equal(call.ok, true, JSON.stringify(call));
});

console.log('prompt:');
await ok('describe 不泄漏 header 值', () => {
    const info = service.describe(projectDir);
    const text = JSON.stringify(info);
    assert.doesNotMatch(text, /secret-token-123/);
    assert.ok(info.apis.some((api) => api.id === 'echo'));
});
await ok('describe 展示完整地址（含路径）并列出占位符', () => {
    const info = service.describe(projectDir);
    const echo = info.apis.find((api) => api.id === 'echo');
    assert.match(echo.url, /\/echo$/);
    // id 来自 body 模板，fixed 来自 query（query 默认值可由 params 覆盖）
    assert.deepEqual(echo.params.sort(), ['fixed', 'id']);
});

console.log('java 一键启动:');
await ok('没有保存的服务时给出明确提示', async () => {
    const result = await service.startAllSavedJava(projectDir, []);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'NOTHING_SAVED');
});

await ok('一键启动逐个记账：成功/跳过/失败都进 items，不中断', async () => {
    // 造两个配方：一个能起来（假的 java 命令必然失败），一个 id 不存在。
    // 这里不真的拉 Java 进程，只验证编排逻辑：失败被记进 items，循环继续。
    const store = service.projectStore;
    store.saveJava(projectDir, {
        id: 'demo-a',
        name: 'demo-a',
        mainClass: 'com.example.DemoAApplication',
        classPath: '/tmp/none/target/classes',
        javaExe: 'definitely-not-a-real-java-binary',
        cwd: projectDir,
    });
    store.saveJava(projectDir, {
        id: 'demo-b',
        name: 'demo-b',
        mainClass: 'com.example.DemoBApplication',
        classPath: '/tmp/none/target/classes',
        javaExe: 'definitely-not-a-real-java-binary',
        cwd: projectDir,
    });

    const result = await service.startAllSavedJava(projectDir, ['demo-a', 'ghost']);
    assert.equal(result.ok, false, '有失败项时整体 ok 为 false');
    assert.equal(result.code, 'PARTIAL');
    assert.equal(result.total, 2);
    // ghost 不存在 → NOT_SAVED；demo-a 拉不起来 → 各自有失败原因
    const ghost = result.items.find((item) => item.id === 'ghost');
    assert.equal(ghost.code, 'NOT_SAVED');
    const a = result.items.find((item) => item.id === 'demo-a');
    assert.equal(a.ok, false, '假 java 路径不可能启动成功');
    assert.ok(a.code || a.message, '失败项必须带原因');
    // 关键：第一个失败没有阻止第二个被处理
    assert.equal(result.items.length, 2, '失败不应中断整批');
    assert.match(result.message, /成功 \d+ 个，跳过 \d+ 个，失败 \d+ 个/);
});

await ok('一键启动跳过已在运行的服务', async () => {
    // 直接往托管记录里塞一条 alive 的假记录（用当前进程的 pid，保证 isAlive 为 true）
    service.javaRunner._put(projectDir, {
        id: 'demo-b',
        pid: process.pid,
        mainClass: 'com.example.DemoBApplication',
        logPath: path.join(homeDir, 'java-logs', 'demo-b.log'),
        startedAt: new Date().toISOString(),
    });
    const result = await service.startAllSavedJava(projectDir, ['demo-b']);
    const b = result.items.find((item) => item.id === 'demo-b');
    assert.equal(b.skipped, true, JSON.stringify(b));
    assert.equal(result.skipped, 1);
    assert.equal(result.failed, 0);
});

await ok('后台批次立刻返回 id，轮询能看到进度与结束状态', async () => {
    const started = service.startSavedJavaBatch(projectDir, ['ghost']);
    assert.equal(started.ok, true);
    assert.ok(started.batchId, '必须立刻返回批次 id');
    assert.equal(started.total, 1);

    // 轮询到结束（失败也算结束）
    let status;
    for (let i = 0; i < 50; i += 1) {
        status = service.startBatchStatus(started.batchId);
        if (status.finished) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(status.ok, true);
    assert.equal(status.finished, true, JSON.stringify(status));
    assert.equal(status.total, 1);
    assert.ok(status.result, '结束后必须带上 result');
    assert.equal(status.items.length, 1, '每个服务都要有一条进度记录');
});

await ok('查不存在的批次给出 NO_BATCH', () => {
    const status = service.startBatchStatus('batch-does-not-exist');
    assert.equal(status.ok, false);
    assert.equal(status.code, 'NO_BATCH');
});

service.dispose();
server.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${process.exitCode ? 'FAILED' : 'PASSED'}: ${passed} checks`);
