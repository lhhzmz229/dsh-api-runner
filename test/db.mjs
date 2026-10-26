/**
 * 数据库功能的集成测试（node test/db.mjs）。
 *
 * 用 Node 内置的 node:sqlite 做真实数据库，不需要装任何原生模块：
 * 建表、插入、参数化查询、元数据、只读模式、多语句拦截、结果截断、
 * 密码加密存储与脱敏，全部在这里断言。
 *
 * 不依赖 cordis，纯 node 可跑。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);

const { DbManager, splitStatements, isReadOnlySql, encryptSecret, decryptSecret } = await load('src/db.js');
const { ApiRunnerService } = await load('src/ops.js');

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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'api-runner-db-'));
const homeDir = path.join(tmp, 'home');
fs.mkdirSync(homeDir, { recursive: true });
const dbFile = path.join(tmp, 'test.db');

const manager = new DbManager({ homeDir });

/**
 * 授权辅助：默认拒绝是核心安全设计，所以几乎每个用例都要先显式授权。
 * 测试里统一用 'default' 项目 + readonly，写操作用 readwrite。
 */
const PROJECT = 'default';
function grant(connectionId, level = 'readonly') {
    const r = manager.setAccess(PROJECT, connectionId, level);
    assert.equal(r.ok, true, JSON.stringify(r));
    return connectionId;
}

console.log('SQL 解析:');
await ok('单条语句不误判', () => {
    assert.deepEqual(splitStatements('SELECT 1'), ['SELECT 1']);
    assert.deepEqual(splitStatements('SELECT 1;'), ['SELECT 1'], '末尾分号不算多语句');
});

await ok('字符串字面量里的分号不算分隔符', () => {
    const sql = "SELECT * FROM t WHERE note = 'a;b'";
    assert.deepEqual(splitStatements(sql), [sql], '引号内的分号不应拆开');
});

await ok('真正的多语句会被识别', () => {
    assert.equal(splitStatements('SELECT 1; SELECT 2').length, 2);
    assert.equal(splitStatements("SELECT 1; DELETE FROM t").length, 2);
});

await ok('注释里的分号不算分隔符', () => {
    assert.deepEqual(splitStatements('-- a; b\nSELECT 1'), ['-- a; b\nSELECT 1']);
    assert.deepEqual(splitStatements('/* x; y */ SELECT 1'), ['/* x; y */ SELECT 1']);
});

await ok('只读判定：SELECT/WITH/PRAGMA 算读，写操作不算', () => {
    assert.equal(isReadOnlySql('SELECT * FROM t'), true);
    assert.equal(isReadOnlySql('  select 1'), true);
    assert.equal(isReadOnlySql('WITH x AS (SELECT 1) SELECT * FROM x'), true);
    assert.equal(isReadOnlySql('PRAGMA table_info(t)'), true);
    assert.equal(isReadOnlySql('INSERT INTO t VALUES (1)'), false);
    assert.equal(isReadOnlySql('UPDATE t SET a = 1'), false);
    assert.equal(isReadOnlySql('DELETE FROM t'), false);
    assert.equal(isReadOnlySql('DROP TABLE t'), false);
    assert.equal(isReadOnlySql('-- 注释\nSELECT 1'), true, '前置行注释不影响判定');
});

console.log('密码加密:');
await ok('加密后不是明文，且能解回原值', () => {
    const cipher = encryptSecret('p@ssw0rd');
    assert.notEqual(cipher, 'p@ssw0rd');
    assert.ok(cipher.startsWith('v1:'));
    assert.equal(decryptSecret(cipher), 'p@ssw0rd');
});

await ok('空密码保持空串', () => {
    assert.equal(encryptSecret(''), '');
    assert.equal(decryptSecret(''), '');
});

await ok('损坏的密文不抛异常，返回空串', () => {
    assert.equal(decryptSecret('v1:not-a-valid-base64!!!'), '');
});

console.log('连接管理:');
let connId = '';
await ok('保存 SQLite 连接，密码不落明文', () => {
    const saved = manager.saveConnection({
        name: '本地测试库',
        type: 'sqlite',
        database: dbFile,
        username: 'root',
        password: 'secret-pw',
    });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    connId = saved.connection.id;
    assert.ok(connId, '应生成连接 id');

    // 返回给外部的视图不含明文密码
    assert.equal(saved.connection.hasPassword, true);
    assert.equal(JSON.stringify(saved.connection).includes('secret-pw'), false, '视图里不能出现明文密码');

    // 落盘文件里也不能有明文
    const raw = fs.readFileSync(path.join(homeDir, 'db-connections.json'), 'utf8');
    assert.equal(raw.includes('secret-pw'), false, '落盘文件里不能有明文密码');
});

await ok('列表返回脱敏视图', () => {
    const list = manager.listConnections();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, '本地测试库');
    assert.equal(JSON.stringify(list).includes('secret-pw'), false);
});

await ok('更新连接时不传密码则保留原密码', () => {
    manager.saveConnection({ id: connId, name: '改了名字', type: 'sqlite', database: dbFile });
    const full = manager._fullConfig(connId);
    assert.equal(full.password, 'secret-pw', '编辑时不传密码不应清空');
    assert.equal(manager.listConnections()[0].name, '改了名字');
});

await ok('缺少必填项时给出明确错误', () => {
    const noName = manager.saveConnection({ type: 'sqlite', database: dbFile });
    assert.equal(noName.ok, false);
    assert.equal(noName.code, 'MISSING_NAME');

    const noDb = manager.saveConnection({ name: 'x', type: 'sqlite' });
    assert.equal(noDb.ok, false);
    assert.equal(noDb.code, 'MISSING_DATABASE');

    const noHost = manager.saveConnection({ name: 'y', type: 'mysql' });
    assert.equal(noHost.ok, false);
    assert.equal(noHost.code, 'MISSING_HOST');

    const badType = manager.saveConnection({ name: 'z', type: 'mongodb' });
    assert.equal(badType.ok, false);
    assert.equal(badType.code, 'BAD_TYPE');
});

await ok('支持达梦（dm）类型，默认端口 5236', () => {
    const saved = manager.saveConnection({
        name: '达梦测试',
        type: 'dm',
        host: '127.0.0.1',
        username: 'SYSDBA',
        password: 'pw',
    });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(saved.connection.type, 'dm');
    assert.equal(saved.connection.port, 5236, '达梦默认端口应是 5236');
    manager.deleteConnection(saved.connection.id);
});

await ok('URL 模式：可以不填 host，回显打码', () => {
    const saved = manager.saveConnection({
        name: 'URL 模式',
        type: 'dm',
        connectString: 'dm://FUND:secret123@192.168.0.144:8185?loginEncrypt=false&schema=FTPDB',
    });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(saved.connection.urlMode, true);
    assert.equal(saved.connection.host, '', 'URL 模式不应强制 host');
    assert.equal(saved.connection.connectString.includes('secret123'), false, 'URL 回显不能含明文密码');
    assert.ok(saved.connection.connectString.includes('***'), 'URL 回显应含掩码');
    assert.ok(saved.connection.connectString.includes('192.168.0.144:8185'), '其余部分应保留');
    manager.deleteConnection(saved.connection.id);
});

await ok('分字段模式仍要求 host，错误提示指引 URL 模式', () => {
    const noHost = manager.saveConnection({ name: 'a', type: 'mysql', username: 'u' });
    assert.equal(noHost.ok, false);
    assert.equal(noHost.code, 'MISSING_HOST');
    assert.match(noHost.message, /URL 模式/);
});

await ok('草稿试连不落盘，不污染连接列表', async () => {
    const before = manager.listConnections().length;
    const result = await manager.testConnection({ type: 'sqlite', database: dbFile });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(manager.listConnections().length, before, '试连不应新增记录');
});

await ok('试连用独立临时 id，不会和已保存连接撞池别名', async () => {
    // 先保存一条真实连接
    const saved = manager.saveConnection({ name: '别名冲突测试', type: 'dm', host: '127.0.0.1', port: 59997, username: 'u', password: 'p' });
    assert.equal(saved.ok, true, JSON.stringify(saved));

    // 编辑时用该连接 id 试连：草稿 id 必须被换成 probe-*，否则 dmdb 会报「连接池别名已存在」
    const r1 = await manager.testConnection({ id: saved.connection.id, type: 'dm', host: '127.0.0.1', port: 59997, username: 'u' }, { timeoutMs: 2000 });
    assert.equal(r1.ok, false, '这个端口没人监听，应失败');
    // 关键：错误不能是「别名已存在」这种配置级错误
    assert.equal(/别名已存在/.test(String(r1.message)), false, `不应撞池别名：${r1.message}`);

    // 连续试两次也不能撞
    const r2 = await manager.testConnection({ id: saved.connection.id, type: 'dm', host: '127.0.0.1', port: 59997, username: 'u' }, { timeoutMs: 2000 });
    assert.equal(/别名已存在/.test(String(r2.message)), false, `第二次仍不应撞池别名：${r2.message}`);

    manager.deleteConnection(saved.connection.id);
});

await ok('试连有超时上限，不会让前端无限等待', async () => {
    const started = Date.now();
    // 指向一个不可达地址，超时设 2 秒
    const result = await manager.testConnection(
        { type: 'dm', host: '10.255.255.1', port: 5236, username: 'u', password: 'p' },
        { timeoutMs: 2000 },
    );
    const elapsed = Date.now() - started;
    assert.equal(result.ok, false);
    assert.ok(elapsed < 8000, `试连应在超时附近返回，实际等了 ${elapsed}ms`);
    assert.ok(['CONNECT_FAILED', 'PROBE_TIMEOUT', 'DB_ERROR'].includes(result.code), JSON.stringify(result));
});

await ok('草稿缺必填项时给出明确错误，不崩', async () => {
    const result = await manager.testConnection({ type: 'sqlite' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'MISSING_DATABASE');
});

await ok('多个达梦连接有各自独立的池别名', () => {
    const a = manager.saveConnection({ name: 'dm-a', type: 'dm', host: '127.0.0.1', port: 5236, username: 'u1', password: 'p' });
    const b = manager.saveConnection({ name: 'dm-b', type: 'dm', host: '127.0.0.2', port: 5236, username: 'u2', password: 'p' });
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.equal(b.ok, true, JSON.stringify(b));
    assert.notEqual(a.connection.id, b.connection.id, '两条连接应有不同 id');
    manager.deleteConnection(a.connection.id);
    manager.deleteConnection(b.connection.id);
});

await ok('URL 里的密码不会出现在错误信息里', async () => {
    const saved = manager.saveConnection({
        name: '错误脱敏',
        type: 'dm',
        connectString: 'dm://u:verysecretpw@127.0.0.1:59998',
    });
    assert.equal(saved.ok, true);
    const result = await manager.query(saved.connection.id, 'SELECT 1', [], { timeoutMs: 1500, projectKey: PROJECT });
    if (result.ok === false) {
        assert.equal(String(result.message).includes('verysecretpw'), false, '错误信息不应泄漏密码');
    }
    manager.deleteConnection(saved.connection.id);
});

await ok('DB_TYPES 包含 dm 与 oracle', async () => {
    const { DB_TYPES } = await load('src/db.js');
    assert.ok(DB_TYPES.includes('dm'), '应支持达梦');
    assert.ok(DB_TYPES.includes('oracle'));
    assert.ok(DB_TYPES.includes('sqlite'));
    assert.ok(DB_TYPES.includes('mysql'));
    assert.ok(DB_TYPES.includes('postgres'));
});

await ok('dmdb 导出结构能被识别（兼容 default/dmdb/模块本身）', async () => {
    let dmdbMod;
    try {
        dmdbMod = await import('dmdb');
    } catch {
        // 没装 dmdb 的机器跳过，不算失败
        return;
    }
    // 复刻 _openDm 里的候选查找逻辑
    const candidates = [dmdbMod?.default, dmdbMod?.dmdb, dmdbMod?.default?.dmdb, dmdbMod];
    const mod = candidates.find((m) => m && typeof m.createPool === 'function');
    assert.ok(mod, `dmdb 已安装但找不到 createPool。导出项：${Object.keys(dmdbMod || {}).join(', ')}`);
    assert.equal(typeof mod.parseUrl, 'function', '应能拿到 parseUrl');
});

await ok('dmdb 的 URL 解析：密码含 @ 不会被截断', async () => {
    let dmdbMod;
    try {
        dmdbMod = await import('dmdb');
    } catch {
        return;
    }
    const candidates = [dmdbMod?.default, dmdbMod?.dmdb, dmdbMod?.default?.dmdb, dmdbMod];
    const mod = candidates.find((m) => m && typeof m.parseUrl === 'function');
    if (!mod) return;

    // 未编码：dmdb 按最后一个 @ 分割，密码里的 @ 不会被误判
    const raw = await mod.parseUrl('dm://FUND:Rgzn@2025@localhost:5236');
    const getRaw = (k) => (typeof raw.getAny === 'function' ? raw.getAny(k) : raw[k]);
    assert.equal(getRaw('password'), 'Rgzn@2025', '未编码时密码应完整');
    assert.equal(getRaw('host'), 'localhost', '未编码时 host 应正确');

    // 编码形式：也应正确解码
    const enc = await mod.parseUrl('dm://FUND:Rgzn%402025@localhost:5236');
    const getEnc = (k) => (typeof enc.getAny === 'function' ? enc.getAny(k) : enc[k]);
    assert.equal(getEnc('password'), 'Rgzn@2025', '编码形式应自动解码');
    assert.equal(getEnc('host'), 'localhost');
});

await ok('缺少 dmdb 驱动时给出可操作的提示，不崩', async () => {
    const saved = manager.saveConnection({
        name: '达梦无驱动',
        type: 'dm',
        host: '127.0.0.1',
        port: 5236,
        username: 'SYSDBA',
    });
    assert.equal(saved.ok, true);
    // 先授权，才能走到「尝试连接」这一步（否则会先被授权层拦掉）
    grant(saved.connection.id, 'readonly');
    // 本机可能装了 dmdb 也可能没装；两种情况都必须是「结构化失败」而不是抛异常
    const result = await manager.query(saved.connection.id, 'SELECT 1', [], { projectKey: PROJECT });
    if (result.ok === false) {
        assert.ok(['CONNECT_FAILED', 'DB_ERROR'].includes(result.code), JSON.stringify(result));
        assert.equal(typeof result.message, 'string');
        assert.ok(result.message.length > 0);
        // 提示里不能出现明文密码
        assert.equal(result.message.includes('pw'), false, '错误信息不应泄漏密码');
    }
    manager.deleteConnection(saved.connection.id);
});

console.log('连接与执行:');
await ok('未授权的连接一律拒绝（默认拒绝）', async () => {
    const r = await manager.query(connId, 'SELECT 1', [], { projectKey: 'no-such-project' });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.code, 'NOT_AUTHORIZED');
});

await ok('只读授权：能查、不能写', async () => {
    grant(connId, 'readonly');
    const read = await manager.query(connId, 'SELECT 1 AS one', [], { projectKey: PROJECT });
    assert.equal(read.ok, true, JSON.stringify(read));
    const write = await manager.query(connId, 'CREATE TABLE nope (a INT)', [], { readonly: false, projectKey: PROJECT });
    assert.equal(write.ok, false);
    assert.equal(write.code, 'PERMISSION_DENIED', JSON.stringify(write));
});

await ok('授权等级可升级/撤销', () => {
    grant(connId, 'readwrite');
    assert.equal(manager.accessOf(PROJECT)[connId], 'readwrite');
    manager.setAccess(PROJECT, connId, 'readonly');
    assert.equal(manager.accessOf(PROJECT)[connId], 'readonly');
    grant(connId, 'readwrite');
});

await ok('testConnection 能试连成功', async () => {
    const result = await manager.testConnection(connId);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(typeof result.durationMs, 'number');
});

await ok('建表、插入、参数化查询', async () => {
    const create = await manager.query(connId, 'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)', [], { readonly: false, projectKey: PROJECT });
    assert.equal(create.ok, true, JSON.stringify(create));

    const ins = await manager.query(connId, 'INSERT INTO users (name, age) VALUES (?, ?)', ['alice', 30], { readonly: false, projectKey: PROJECT });
    assert.equal(ins.ok, true, JSON.stringify(ins));
    assert.equal(ins.affectedRows, 1);

    await manager.query(connId, 'INSERT INTO users (name, age) VALUES (?, ?)', ['bob', 25], { readonly: false, projectKey: PROJECT });

    const sel = await manager.query(connId, 'SELECT * FROM users ORDER BY id', [], { projectKey: PROJECT });
    assert.equal(sel.ok, true, JSON.stringify(sel));
    assert.deepEqual(sel.columns, ['id', 'name', 'age']);
    assert.equal(sel.rowCount, 2);
    assert.equal(sel.rows[0].name, 'alice');
    assert.equal(sel.rows[1].age, 25);
});

await ok('参数化能防注入（值里的引号不生效）', async () => {
    const evil = "x' OR '1'='1";
    const ins = await manager.query(connId, 'INSERT INTO users (name, age) VALUES (?, ?)', [evil, 1], { readonly: false, projectKey: PROJECT });
    assert.equal(ins.ok, true);
    const sel = await manager.query(connId, 'SELECT * FROM users WHERE name = ?', [evil], { projectKey: PROJECT });
    assert.equal(sel.rowCount, 1, '应精确匹配那个字面值，而不是被 OR 恒真放大');
    assert.equal(sel.rows[0].name, evil);
});

await ok('只读模式先拦写操作（readonly 是硬闸门）', async () => {
    manager.setAccess(PROJECT, connId, 'readonly');
    const del = await manager.query(connId, 'DELETE FROM users', [], { readonly: true, projectKey: PROJECT });
    assert.equal(del.ok, false);
    // readonly:true 时，只读闸门先于授权检查生效
    assert.ok(['READONLY_VIOLATION', 'PERMISSION_DENIED'].includes(del.code), JSON.stringify(del));

    // 确认数据没被删
    const count = await manager.query(connId, 'SELECT COUNT(*) AS n FROM users', [], { projectKey: PROJECT });
    assert.equal(count.rows[0].n, 3);
    grant(connId, 'readwrite');
});

await ok('多语句被拦截', async () => {
    const multi = await manager.query(connId, 'SELECT 1; DELETE FROM users', [], { readonly: false, projectKey: PROJECT });
    assert.equal(multi.ok, false);
    assert.equal(multi.code, 'MULTI_STATEMENT');
});

await ok('空 SQL 给出明确错误', async () => {
    const empty = await manager.query(connId, '   ', [], { projectKey: PROJECT });
    assert.equal(empty.ok, false);
    assert.equal(empty.code, 'EMPTY_SQL');
});

await ok('语法错误转成 DB_ERROR，不抛异常', async () => {
    const bad = await manager.query(connId, 'SELEC * FROM users', [], { projectKey: PROJECT });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'DB_ERROR');
    assert.equal(typeof bad.message, 'string');
    assert.ok(bad.message.length > 0);
});

await ok('不存在的连接：先被授权层拒绝，不会泄漏「有没有这个连接」', async () => {
    const result = await manager.query('no-such-conn', 'SELECT 1', [], { projectKey: PROJECT });
    assert.equal(result.ok, false);
    // 授权层先于连接查找，所以未授权时一律 NOT_AUTHORIZED——
    // 这本身也是个安全特性：不让人探测「哪些连接 id 存在」
    assert.ok(['NOT_AUTHORIZED', 'NOT_FOUND'].includes(result.code), JSON.stringify(result));
});

await ok('结果集按上限截断并提示', async () => {
    const many = await manager.query(connId, 'SELECT * FROM users', [], { maxRows: 1, projectKey: PROJECT });
    assert.equal(many.ok, true);
    assert.equal(many.rows.length, 1, '应只返回 1 行');
    assert.equal(many.rowCount, 3, 'rowCount 仍是真实总数');
    assert.equal(many.truncated, true);
    assert.match(many.note, /已截断/);
});

console.log('元数据:');
await ok('listTables 能列出表', async () => {
    const result = await manager.listTables(connId, "", { projectKey: PROJECT });
    assert.equal(result.ok, true, JSON.stringify(result));
    const names = result.tables.map((t) => t.name);
    assert.ok(names.includes('users'), `表清单应包含 users，实际：${names.join(',')}`);
});

await ok('describeTable 返回字段与索引', async () => {
    await manager.query(connId, 'CREATE INDEX idx_users_name ON users(name)', [], { readonly: false, projectKey: PROJECT });
    const result = await manager.describeTable(connId, 'users', { projectKey: PROJECT });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.table, 'users');
    const byName = new Map(result.columns.map((c) => [c.name, c]));
    assert.ok(byName.has('id'));
    assert.equal(byName.get('id').primaryKey, true);
    assert.equal(byName.get('name').type, 'TEXT');
    assert.ok(result.indexes.some((i) => i.name === 'idx_users_name'), `应有索引，实际：${JSON.stringify(result.indexes)}`);
});

await ok('describeTable 对不存在的表返回空字段而不是崩', async () => {
    const result = await manager.describeTable(connId, 'no_such_table', { projectKey: PROJECT });
    assert.equal(result.ok, true);
    assert.equal(result.columns.length, 0);
});

console.log('ApiRunnerService 集成:');
await ok('describe 只列已授权的连接，未授权的不给模型看', async () => {
    const service = new ApiRunnerService({ homeDir });
    const saved = service.dbSave({ name: 'describe 库', type: 'sqlite', database: dbFile });
    assert.equal(saved.ok, true, JSON.stringify(saved));

    // 未授权时：不该出现在 describe 里（模型看不见，就不会去试）
    const before = service.describe('');
    assert.ok(Array.isArray(before.databases), 'describe 必须返回 databases 数组');
    assert.equal(before.databases.some((item) => item.name === 'describe 库'), false,
        '未授权的连接不应出现在 describe 里');

    // 授权后才出现，并带上权限等级
    service.dbManager.setAccess(PROJECT, saved.connection.id, 'readonly');
    const after = service.describe('');
    const hit = after.databases.find((item) => item.name === 'describe 库');
    assert.ok(hit, '授权后应出现在 describe 里');
    assert.equal(hit.type, 'sqlite');
    assert.equal(hit.level, 'readonly', '应带上权限等级，模型据此知道能不能写');
    assert.ok(hit.target.includes('test.db'), '应给出目标（文件路径）');

    // 不能泄漏密码
    const text = JSON.stringify(after);
    assert.equal(/password/i.test(text), false, 'describe 不应包含 password 字段');
    assert.equal(text.includes('secret'), false, 'describe 不应包含密码值');

    service.dispose();
});

await ok('service 暴露数据库方法，且 dispose 关闭连接池', async () => {
    const service = new ApiRunnerService({ homeDir });
    const saved = service.dbSave({ name: '服务层库', type: 'sqlite', database: dbFile });
    assert.equal(saved.ok, true, JSON.stringify(saved));

    const list = service.dbConnections();
    assert.equal(list.ok, true);
    assert.ok(list.connections.some((c) => c.name === '服务层库'));

    // 未授权时拒绝
    const denied = await service.dbQuery(saved.connection.id, 'SELECT 1 AS one', [], { projectKey: PROJECT });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'NOT_AUTHORIZED');

    // 授权后可查
    service.dbManager.setAccess(PROJECT, saved.connection.id, 'readonly');
    const queried = await service.dbQuery(saved.connection.id, 'SELECT 1 AS one', [], { projectKey: PROJECT });
    assert.equal(queried.ok, true, JSON.stringify(queried));
    assert.equal(queried.rows[0].one, 1);

    service.dispose();
});

await ok('service 在数据库模块缺失时给出 NO_DB', async () => {
    const service = new ApiRunnerService({ homeDir });
    service.dbManager = undefined;
    const result = service.dbConnections();
    assert.equal(result.ok, false);
    assert.equal(result.code, 'NO_DB');
});

console.log('清理:');
await ok('删除连接后不再出现在列表里', () => {
    // 前面「服务层库」是另一个 DbManager 实例写的，同一文件里还在；
    // 这里先把它清掉，只针对本实例创建的 connId 做断言
    for (const item of manager.listConnections()) manager.deleteConnection(item.id);
    assert.equal(manager.listConnections().length, 0);

    // 再保存一个，验证删除语义
    const saved = manager.saveConnection({ name: '待删除', type: 'sqlite', database: dbFile });
    assert.equal(saved.ok, true);
    const del = manager.deleteConnection(saved.connection.id);
    assert.equal(del.ok, true);
    assert.equal(manager.listConnections().length, 0, '删除后不应再出现在列表里');

    const again = manager.deleteConnection(saved.connection.id);
    assert.equal(again.ok, false);
    assert.equal(again.code, 'NOT_FOUND');
});

manager.dispose();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${process.exitCode ? 'FAILED' : 'PASSED'}: ${passed} checks`);
