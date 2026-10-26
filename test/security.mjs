/**
 * 安全专项测试：SQL 危险操作必须被拦。
 * 这是数据安全的核心防线，单独一份，改坏了一眼能看出来。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);

const { DbManager, classifySql, isDestructiveSql } = await load('src/db.js');

let passed = 0;
function ok(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => { passed += 1; console.log(`  ✓ ${name}`); })
        .catch((error) => {
            console.error(`  ✗ ${name}\n    ${error?.stack || error}`);
            process.exitCode = 1;
        });
}

console.log('classifySql：只读判定');

const READ_SQL = [
    'SELECT 1',
    'select * from users',
    'SELECT * FROM users WHERE name = ?',
    '  SELECT 1  ',
    'SELECT * FROM t WHERE note = \'delete\'',   // 字符串里的关键字不算
    'SELECT * FROM t WHERE note = \'drop table\'',
    'SHOW TABLES',
    'DESCRIBE users',
    'DESC users',
    'EXPLAIN SELECT * FROM users',
    'PRAGMA table_info(users)',
    'WITH x AS (SELECT 1 AS a) SELECT * FROM x',
    '-- 注释\nSELECT 1',
    '/* 块注释 */ SELECT 1',
];

for (const sql of READ_SQL) {
    await ok(`只读: ${sql.replace(/\n/g, ' ').slice(0, 46)}`, () => {
        assert.equal(classifySql(sql).kind, 'read', `应判定为只读，实际：${JSON.stringify(classifySql(sql))}`);
    });
}

console.log('\nclassifySql：写操作必须识别');

const WRITE_SQL = [
    'INSERT INTO t VALUES (1)',
    'UPDATE t SET a = 1 WHERE id = 2',
    'DELETE FROM t WHERE id = 1',
    'DROP TABLE t',
    'TRUNCATE TABLE t',
    'ALTER TABLE t ADD COLUMN c INT',
    'CREATE TABLE t (a INT)',
    'CREATE INDEX i ON t(a)',
    'RENAME TABLE a TO b',
    'GRANT SELECT ON t TO u',
    'REVOKE SELECT ON t FROM u',
    'WITH x AS (SELECT 1) DELETE FROM t',      // 以 WITH 开头的写
    'WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x',
    'SELECT * FROM t FOR UPDATE',               // 加锁
    'SELECT * FROM t FOR SHARE',
    'SELECT * INTO OUTFILE \'/tmp/x\' FROM t',   // 写文件
    'SELECT load_file(\'/etc/passwd\')',          // 读服务器文件
    'EXPLAIN ANALYZE DELETE FROM t',             // 真的会执行
    'BEGIN',
    'COMMIT',
    'ROLLBACK',
    'SET autocommit = 0',
    'CALL some_proc()',
    'EXEC sp_who',
    'VACUUM',
    'ATTACH DATABASE \'x\' AS y',
    'PRAGMA journal_mode = WAL',                 // PRAGMA 也可能写
];

for (const sql of WRITE_SQL) {
    await ok(`写: ${sql.slice(0, 46)}`, () => {
        const v = classifySql(sql);
        assert.notEqual(v.kind, 'read', `不应判定为只读：${sql} → ${JSON.stringify(v)}`);
    });
}

console.log('\nclassifySql：多语句与未知');

await ok('多语句一律拒绝（即使每条都只读）', () => {
    const v = classifySql('SELECT 1; SELECT 2');
    assert.equal(v.kind, 'write');
});

await ok('空 SQL 判为 unknown', () => {
    assert.equal(classifySql('').kind, 'unknown');
    assert.equal(classifySql('   ').kind, 'unknown');
});

console.log('\nisDestructiveSql：毁灭性操作');

const DESTRUCTIVE = [
    'DROP TABLE t',
    'DROP DATABASE d',
    'TRUNCATE TABLE t',
    'DELETE FROM t',                  // 没有 WHERE
    'UPDATE t SET a = 1',             // 没有 WHERE
    'GRANT ALL ON t TO u',
    'REVOKE ALL ON t FROM u',
];
for (const sql of DESTRUCTIVE) {
    await ok(`毁灭性: ${sql}`, () => {
        assert.equal(isDestructiveSql(sql), true, `应判为毁灭性：${sql}`);
    });
}

const NOT_DESTRUCTIVE = [
    'DELETE FROM t WHERE id = 1',
    'UPDATE t SET a = 1 WHERE id = 2',
    'INSERT INTO t VALUES (1)',
    'SELECT 1',
    'CREATE TABLE t (a INT)',
];
for (const sql of NOT_DESTRUCTIVE) {
    await ok(`非毁灭性: ${sql}`, () => {
        assert.equal(isDestructiveSql(sql), false, `不应判为毁灭性：${sql}`);
    });
}

console.log('\n端到端：授权 + 安全拦截');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'api-runner-sec-'));
const dbFile = path.join(tmp, 'sec.db');
const manager = new DbManager({ homeDir: tmp });
const P = 'default';

const saved = manager.saveConnection({ name: 'sec', type: 'sqlite', database: dbFile });
assert.equal(saved.ok, true);
const cid = saved.connection.id;

await ok('未授权：连 SELECT 都拒绝', async () => {
    const r = await manager.query(cid, 'SELECT 1', [], { projectKey: P });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'NOT_AUTHORIZED');
});

manager.setAccess(P, cid, 'readonly');

await ok('只读授权：写操作被 PERMISSION_DENIED 拦住', async () => {
    const r = await manager.query(cid, 'INSERT INTO t VALUES (1)', [], { projectKey: P, readonly: false });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'PERMISSION_DENIED');
});

manager.setAccess(P, cid, 'readwrite');

await ok('读写授权：建表可以，DROP 仍被 DESTRUCTIVE_BLOCKED 拦住', async () => {
    const create = await manager.query(cid, 'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)', [], { projectKey: P, readonly: false });
    assert.equal(create.ok, true, JSON.stringify(create));

    const drop = await manager.query(cid, 'DROP TABLE t', [], { projectKey: P, readonly: false });
    assert.equal(drop.ok, false);
    assert.equal(drop.code, 'DESTRUCTIVE_BLOCKED', JSON.stringify(drop));

    // 确认表还在
    const check = await manager.query(cid, "SELECT name FROM sqlite_master WHERE type='table' AND name='t'", [], { projectKey: P });
    assert.equal(check.rowCount, 1, '表不应被删掉');
});

await ok('读写授权：无 WHERE 的 DELETE 被拦，带 WHERE 的放行', async () => {
    await manager.query(cid, "INSERT INTO t (name) VALUES ('a')", [], { projectKey: P, readonly: false });
    await manager.query(cid, "INSERT INTO t (name) VALUES ('b')", [], { projectKey: P, readonly: false });

    const noWhere = await manager.query(cid, 'DELETE FROM t', [], { projectKey: P, readonly: false });
    assert.equal(noWhere.ok, false);
    assert.equal(noWhere.code, 'DESTRUCTIVE_BLOCKED');

    const withWhere = await manager.query(cid, 'DELETE FROM t WHERE name = ?', ['a'], { projectKey: P, readonly: false });
    assert.equal(withWhere.ok, true, JSON.stringify(withWhere));

    const count = await manager.query(cid, 'SELECT COUNT(*) AS n FROM t', [], { projectKey: P });
    assert.equal(count.rows[0].n, 1, '只应删掉 name=a 那条');
});

await ok('模型侧永远只读（即使请求里写 readonly:false 也被强制为 true）', async () => {
    // 模拟 main.js 的做法：固定 readonly: true
    const r = await manager.query(cid, 'DELETE FROM t WHERE name = ?', ['b'], { projectKey: P, readonly: true });
    assert.equal(r.ok, false);
    // readonly:true 时，写操作在授权层之后仍会被 classifySql 拦
    assert.ok(['PERMISSION_DENIED', 'DESTRUCTIVE_BLOCKED', 'READONLY_VIOLATION'].includes(r.code), JSON.stringify(r));
});

manager.dispose();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${process.exitCode ? 'FAILED' : 'PASSED'}: ${passed} checks`);
