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

await ok('DB_TYPES 包含 dm 与 oracle', async () => {
    const { DB_TYPES } = await load('src/db.js');
    assert.ok(DB_TYPES.includes('dm'), '应支持达梦');
    assert.ok(DB_TYPES.includes('oracle'));
    assert.ok(DB_TYPES.includes('sqlite'));
    assert.ok(DB_TYPES.includes('mysql'));
    assert.ok(DB_TYPES.includes('postgres'));
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
    // 本机可能装了 dmdb 也可能没装；两种情况都必须是「结构化失败」而不是抛异常
    const result = await manager.query(saved.connection.id, 'SELECT 1', [], {});
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
await ok('testConnection 能试连成功', async () => {
    const result = await manager.testConnection(connId);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(typeof result.durationMs, 'number');
});

await ok('建表、插入、参数化查询', async () => {
    const create = await manager.query(connId, 'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)', [], { readonly: false });
    assert.equal(create.ok, true, JSON.stringify(create));

    const ins = await manager.query(connId, 'INSERT INTO users (name, age) VALUES (?, ?)', ['alice', 30], { readonly: false });
    assert.equal(ins.ok, true, JSON.stringify(ins));
    assert.equal(ins.affectedRows, 1);

    await manager.query(connId, 'INSERT INTO users (name, age) VALUES (?, ?)', ['bob', 25], { readonly: false });

    const sel = await manager.query(connId, 'SELECT * FROM users ORDER BY id', [], {});
    assert.equal(sel.ok, true, JSON.stringify(sel));
    assert.deepEqual(sel.columns, ['id', 'name', 'age']);
    assert.equal(sel.rowCount, 2);
    assert.equal(sel.rows[0].name, 'alice');
    assert.equal(sel.rows[1].age, 25);
});

await ok('参数化能防注入（值里的引号不生效）', async () => {
    const evil = "x' OR '1'='1";
    const ins = await manager.query(connId, 'INSERT INTO users (name, age) VALUES (?, ?)', [evil, 1], { readonly: false });
    assert.equal(ins.ok, true);
    const sel = await manager.query(connId, 'SELECT * FROM users WHERE name = ?', [evil], {});
    assert.equal(sel.rowCount, 1, '应精确匹配那个字面值，而不是被 OR 恒真放大');
    assert.equal(sel.rows[0].name, evil);
});

await ok('只读模式拒绝写操作', async () => {
    const del = await manager.query(connId, 'DELETE FROM users', [], { readonly: true });
    assert.equal(del.ok, false);
    assert.equal(del.code, 'READONLY_VIOLATION');

    // 确认数据没被删
    const count = await manager.query(connId, 'SELECT COUNT(*) AS n FROM users', [], {});
    assert.equal(count.rows[0].n, 3);
});

await ok('多语句被拦截', async () => {
    const multi = await manager.query(connId, 'SELECT 1; DELETE FROM users', [], { readonly: false });
    assert.equal(multi.ok, false);
    assert.equal(multi.code, 'MULTI_STATEMENT');
});

await ok('空 SQL 给出明确错误', async () => {
    const empty = await manager.query(connId, '   ', [], {});
    assert.equal(empty.ok, false);
    assert.equal(empty.code, 'EMPTY_SQL');
});

await ok('语法错误转成 DB_ERROR，不抛异常', async () => {
    const bad = await manager.query(connId, 'SELEC * FROM users', [], {});
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'DB_ERROR');
    assert.equal(typeof bad.message, 'string');
    assert.ok(bad.message.length > 0);
});

await ok('不存在的连接给出 NOT_FOUND', async () => {
    const result = await manager.query('no-such-conn', 'SELECT 1', [], {});
    assert.equal(result.ok, false);
    assert.equal(result.code, 'NOT_FOUND');
});

await ok('结果集按上限截断并提示', async () => {
    const many = await manager.query(connId, 'SELECT * FROM users', [], { maxRows: 1 });
    assert.equal(many.ok, true);
    assert.equal(many.rows.length, 1, '应只返回 1 行');
    assert.equal(many.rowCount, 3, 'rowCount 仍是真实总数');
    assert.equal(many.truncated, true);
    assert.match(many.note, /已截断/);
});

console.log('元数据:');
await ok('listTables 能列出表', async () => {
    const result = await manager.listTables(connId);
    assert.equal(result.ok, true, JSON.stringify(result));
    const names = result.tables.map((t) => t.name);
    assert.ok(names.includes('users'), `表清单应包含 users，实际：${names.join(',')}`);
});

await ok('describeTable 返回字段与索引', async () => {
    await manager.query(connId, 'CREATE INDEX idx_users_name ON users(name)', [], { readonly: false });
    const result = await manager.describeTable(connId, 'users');
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.table, 'users');
    const byName = new Map(result.columns.map((c) => [c.name, c]));
    assert.ok(byName.has('id'));
    assert.equal(byName.get('id').primaryKey, true);
    assert.equal(byName.get('name').type, 'TEXT');
    assert.ok(result.indexes.some((i) => i.name === 'idx_users_name'), `应有索引，实际：${JSON.stringify(result.indexes)}`);
});

await ok('describeTable 对不存在的表返回空字段而不是崩', async () => {
    const result = await manager.describeTable(connId, 'no_such_table');
    assert.equal(result.ok, true);
    assert.equal(result.columns.length, 0);
});

console.log('ApiRunnerService 集成:');
await ok('service 暴露数据库方法，且 dispose 关闭连接池', async () => {
    const service = new ApiRunnerService({ homeDir });
    const saved = service.dbSave({ name: '服务层库', type: 'sqlite', database: dbFile });
    assert.equal(saved.ok, true, JSON.stringify(saved));

    const list = service.dbConnections();
    assert.equal(list.ok, true);
    assert.ok(list.connections.some((c) => c.name === '服务层库'));

    const queried = await service.dbQuery(saved.connection.id, 'SELECT 1 AS one', [], {});
    assert.equal(queried.ok, true);
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
