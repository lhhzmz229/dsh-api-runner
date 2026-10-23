/**
 * 数据库连接管理与执行层。
 *
 * 设计取舍（与 dsh-db-tool 的关键差别）：
 *   - **不依赖任何 DSH 服务**（不 inject betterSidebar 之类）。原 dsh-db-tool 把
 *     betterSidebar 当硬依赖，服务没就绪就一直 pending，拖垮整个 web 启动
 *     （`web boot: 1 entry did not activate`）。这里只依赖 Node 内置能力。
 *   - **SQLite 用 Node 内置的 node:sqlite**（Node >= 22.5 自带），不装
 *     better-sqlite3 这类原生模块，避免 NODE_MODULE_VERSION 不匹配的坑。
 *   - 其它驱动（mysql2 / pg / oracledb）**按需动态 import**：没装对应包时
 *     只影响那一种类型的连接，不会让整个插件加载失败。
 *
 * 安全约定：
 *   - 密码落盘前加密，任何对外返回都不含明文（maskSecret 同款思路）。
 *   - 只允许单条语句，防多语句注入。
 *   - 只读模式默认开启，拒绝写操作。
 *   - 结果集行数上限，防撑爆内存。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPlainObject, maskSecret, readStateNamespace, writeStateNamespace } from './util.js';

/** 支持的数据库类型 */
export const DB_TYPES = ['sqlite', 'mysql', 'postgres', 'oracle', 'dm'];

/** 各类型的默认端口 */
const DEFAULT_PORTS = {
    mysql: 3306,
    postgres: 5432,
    oracle: 1521,
    dm: 5236,
};

/** 结果集默认上限 */
const DEFAULT_MAX_ROWS = 1000;
/** 查询默认超时 */
const DEFAULT_TIMEOUT_MS = 30_000;

/** 只读模式允许的语句前缀（忽略大小写与前置空白/注释） */
const READONLY_PREFIX = /^\s*(?:\/\*[\s\S]*?\*\/\s*|--[^\n]*\n\s*)*(select|with|show|desc|describe|explain|pragma|table)\b/i;

/**
 * 去掉 SQL 末尾的分号，并判断是否只包含一条语句。
 *
 * 为什么不用简单的 `/;/` 判断：字符串字面量里合法地会有分号
 * （如 `WHERE note = 'a;b'`），一律拒绝会误伤正常查询。
 * 这里用「跳过字符串/注释」的扫描，只在语句层面找分隔符。
 */
export function splitStatements(sql) {
    const text = String(sql || '');
    const out = [];
    let current = '';
    let i = 0;
    let quote = '';
    while (i < text.length) {
        const ch = text[i];
        const next = text[i + 1];
        if (quote) {
            current += ch;
            if (ch === '\\' && (quote === "'" || quote === '"')) {
                current += next ?? '';
                i += 2;
                continue;
            }
            if (ch === quote) {
                // SQL 里的 '' 转义：连续两个引号不结束字符串
                if (next === quote) {
                    current += next;
                    i += 2;
                    continue;
                }
                quote = '';
            }
            i += 1;
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') {
            quote = ch;
            current += ch;
            i += 1;
            continue;
        }
        if (ch === '-' && next === '-') {
            // 行注释：跳到行尾
            const nl = text.indexOf('\n', i);
            const end = nl === -1 ? text.length : nl + 1;
            current += text.slice(i, end);
            i = end;
            continue;
        }
        if (ch === '/' && next === '*') {
            const close = text.indexOf('*/', i + 2);
            const end = close === -1 ? text.length : close + 2;
            current += text.slice(i, end);
            i = end;
            continue;
        }
        if (ch === ';') {
            out.push(current);
            current = '';
            i += 1;
            continue;
        }
        current += ch;
        i += 1;
    }
    out.push(current);
    return out.map((item) => item.trim()).filter((item) => item !== '');
}

/** 是否只读语句 */
export function isReadOnlySql(sql) {
    return READONLY_PREFIX.test(String(sql || ''));
}

/**
 * 机器特征派生密钥。
 *
 * 目的不是抗住有备而来的攻击者（本地文件能读就能解），而是
 * **避免密码以明文出现在备份、同步盘、误提交里**。够用即可。
 */
function machineKey() {
    const parts = [
        os.hostname(),
        os.userInfo().username,
        process.platform,
        process.env.USERPROFILE || process.env.HOME || '',
    ];
    return crypto.createHash('sha256').update(parts.join('|')).digest();
}

/** 加密密码；空密码原样返回空串 */
export function encryptSecret(plain) {
    const text = String(plain ?? '');
    if (text === '') return '';
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', machineKey(), iv);
    const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${Buffer.concat([iv, tag, enc]).toString('base64')}`;
}

/** 解密密码；解不开返回空串（换机器/文件损坏时按空密码处理，不让整个插件崩） */
export function decryptSecret(stored) {
    const text = String(stored ?? '');
    if (text === '') return '';
    if (!text.startsWith('v1:')) return text; // 兼容早期明文
    try {
        const raw = Buffer.from(text.slice(3), 'base64');
        const iv = raw.subarray(0, 12);
        const tag = raw.subarray(12, 28);
        const data = raw.subarray(28);
        const decipher = crypto.createDecipheriv('aes-256-gcm', machineKey(), iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch {
        return '';
    }
}

/** 生成连接 id */
function makeId(name) {
    const base = String(name || 'db')
        .toLowerCase()
        .replace(/[^\w-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'db';
    return `${base}-${crypto.randomBytes(3).toString('hex')}`;
}

export class DbManager {
    /**
     * @param {{homeDir?:string, settingsStore?:object, dataDir?:string, maxRows?:number, timeoutMs?:number}} options
     */
    constructor(options = {}) {
        this.homeDir = options.homeDir || process.env.DSH_HOME || path.join(process.cwd(), '.dsh');
        this.settingsStore = options.settingsStore || null;
        this.maxRows = Number(options.maxRows) || DEFAULT_MAX_ROWS;
        this.timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
        /** 连接池缓存：connectionId -> driver handle */
        this.pools = new Map();
        this._setDir(options.dataDir || this._preferredDataDir());
        this._installDmGuard();
    }

    /**
     * 拦掉 dmdb 已知的未捕获异步异常。
     *
     * dmdb 在连接失败后的池清理里会抛
     * `TypeError: Cannot read properties of undefined (reading 'log')`
     * （pool.js:263），且是未捕获的 Promise rejection —— 不拦就会把 DSH 主进程带崩。
     *
     * 只放行**这个精确签名**（message + 栈里含 dmdb/pool.js），
     * 其它未捕获异常照常抛给宿主，避免把真正的问题藏起来。
     */
    _installDmGuard() {
        if (DbManager._dmGuardInstalled) return;
        DbManager._dmGuardInstalled = true;
        const onUnhandled = (reason) => {
            const message = String(reason?.message || reason || '');
            const stack = String(reason?.stack || '');
            const isDmPoolBug = message.includes("reading 'log'") && stack.includes('dmdb');
            if (isDmPoolBug) {
                // 已知问题：连接失败后的清理异常，吞掉即可（连接失败本身已经通过返回值报告）
                return;
            }
            // 其它未捕获异常不归这里管，交回默认行为
            process.emitWarning(`[api-runner] unhandled rejection: ${message}`);
        };
        process.on('unhandledRejection', onUnhandled);
    }

    _preferredDataDir() {
        try {
            return this.settingsStore ? this.settingsStore.dataDir() : this.homeDir;
        } catch {
            return this.homeDir;
        }
    }

    /** 数据目录变了之后重新指向（老数据不迁移，只换读写位置） */
    _setDir(dir) {
        this.dataDir = dir || this.homeDir;
        this.file = path.join(this.dataDir, 'db-connections.json');
    }

    /** 设置里改了数据目录后调用 */
    refreshDataDir() {
        const next = this._preferredDataDir();
        if (next !== this.dataDir) {
            this._setDir(next);
            // 换了目录，旧池子的连接配置来源变了，直接清掉
            this.dispose();
        }
        return this.dataDir;
    }

    // ---------------------------------------------------------------- 连接存储
    /** 读原始记录（含加密后的密码），内部用 */
    _loadRaw() {
        const ns = readStateNamespace(this.file, 'connections');
        return Array.isArray(ns.items) ? ns.items.filter(isPlainObject) : [];
    }

    _saveRaw(items) {
        writeStateNamespace(this.file, 'connections', { items });
    }

    /** 脱敏后的连接视图：对外一律走这个 */
    _view(item) {
        return {
            id: item.id,
            name: item.name,
            type: item.type,
            host: item.host || '',
            port: Number(item.port) || DEFAULT_PORTS[item.type] || 0,
            database: item.database || '',
            username: item.username || '',
            /** 只给掩码，绝不回传明文 */
            hasPassword: Boolean(item.password),
            passwordMask: item.password ? maskSecret('********') : '',
            extra: isPlainObject(item.extra) ? item.extra : {},
            createdAt: item.createdAt || '',
            updatedAt: item.updatedAt || '',
            /** sqlite 特有：文件路径 */
            file: item.type === 'sqlite' ? String(item.database || '') : undefined,
        };
    }

    listConnections() {
        return this._loadRaw().map((item) => this._view(item));
    }

    getConnection(id) {
        const raw = this._loadRaw().find((item) => String(item.id) === String(id));
        return raw ? this._view(raw) : undefined;
    }

    /** 内部取完整配置（含明文密码），只在执行层用，不对外 */
    _fullConfig(id) {
        const raw = this._loadRaw().find((item) => String(item.id) === String(id));
        if (!raw) return undefined;
        return { ...raw, password: decryptSecret(raw.password) };
    }

    /**
     * 保存连接（新建或更新）。
     * 更新时若 password 传空/未传，保留原密码（避免"编辑时看不到密码→保存后被清空"）。
     */
    saveConnection(patch = {}) {
        const input = isPlainObject(patch) ? patch : {};
        const items = this._loadRaw();
        const id = String(input.id || '').trim();
        const existingIndex = id ? items.findIndex((item) => String(item.id) === id) : -1;
        const existing = existingIndex >= 0 ? items[existingIndex] : null;

        const type = String(input.type || existing?.type || 'sqlite').toLowerCase();
        if (!DB_TYPES.includes(type)) {
            return { ok: false, code: 'BAD_TYPE', message: `不支持的数据库类型：${type}（支持 ${DB_TYPES.join('/')}）` };
        }
        const name = String(input.name || existing?.name || '').trim();
        if (name === '') return { ok: false, code: 'MISSING_NAME', message: '连接名称不能为空' };

        // sqlite 用 database 字段存文件路径；其它类型需要 host
        const database = String(input.database ?? existing?.database ?? '').trim();
        if (type === 'sqlite' && database === '') {
            return { ok: false, code: 'MISSING_DATABASE', message: 'SQLite 连接需要填写数据库文件路径（:memory: 表示内存库）' };
        }
        if (type !== 'sqlite' && String(input.host ?? existing?.host ?? '').trim() === '') {
            return { ok: false, code: 'MISSING_HOST', message: `${type} 连接需要填写 host` };
        }

        // 密码：显式传了新值就加密存；传空或未传则沿用旧值
        let password = existing?.password || '';
        if (input.password !== undefined && input.password !== null && String(input.password) !== '') {
            password = encryptSecret(String(input.password));
        } else if (input.clearPassword === true) {
            password = '';
        }

        const record = {
            id: existing?.id || id || makeId(name),
            name,
            type,
            host: String(input.host ?? existing?.host ?? '').trim(),
            port: Number(input.port ?? existing?.port) || DEFAULT_PORTS[type] || 0,
            database,
            username: String(input.username ?? existing?.username ?? '').trim(),
            password,
            extra: isPlainObject(input.extra) ? input.extra : (existing?.extra || {}),
            createdAt: existing?.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };

        if (existingIndex >= 0) items[existingIndex] = record;
        else items.push(record);
        this._saveRaw(items);
        // 配置变了，旧池子必须销毁，否则还在用老连接串
        this._closePool(record.id);
        return { ok: true, connection: this._view(record), message: `已保存连接 ${record.name}` };
    }

    deleteConnection(id) {
        const key = String(id || '');
        const items = this._loadRaw();
        const next = items.filter((item) => String(item.id) !== key);
        if (next.length === items.length) {
            return { ok: false, code: 'NOT_FOUND', message: `没有连接 ${key}` };
        }
        this._saveRaw(next);
        this._closePool(key);
        return { ok: true, message: `已删除连接 ${key}` };
    }

    // ---------------------------------------------------------------- 驱动
    /**
     * 取得（或建立）某个连接的驱动句柄。
     * 失败返回 { ok:false, code, message }，不抛异常。
     */
    async _handle(id) {
        const key = String(id || '');
        const cached = this.pools.get(key);
        if (cached) return { ok: true, handle: cached };

        const config = this._fullConfig(key);
        if (!config) return { ok: false, code: 'NOT_FOUND', message: `没有连接 ${key}` };

        try {
            let handle;
            if (config.type === 'sqlite') handle = await this._openSqlite(config);
            else if (config.type === 'mysql') handle = await this._openMysql(config);
            else if (config.type === 'postgres') handle = await this._openPostgres(config);
            else if (config.type === 'oracle') handle = await this._openOracle(config);
            else if (config.type === 'dm') handle = await this._openDm(config);
            else return { ok: false, code: 'BAD_TYPE', message: `不支持的数据库类型：${config.type}` };
            this.pools.set(key, handle);
            return { ok: true, handle };
        } catch (error) {
            return { ok: false, code: 'CONNECT_FAILED', message: this._safeError(error) };
        }
    }

    /** SQLite：用 Node 内置 node:sqlite，零原生依赖 */
    async _openSqlite(config) {
        const { DatabaseSync } = await import('node:sqlite');
        const file = String(config.database || ':memory:');
        // 文件型库：确保父目录存在，否则驱动报错不够直白
        if (file !== ':memory:' && !file.startsWith('file:')) {
            fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
        }
        const db = new DatabaseSync(file);
        return { type: 'sqlite', raw: db };
    }

    /** MySQL：按需加载 mysql2（纯 JS，无原生编译） */
    async _openMysql(config) {
        let mysql;
        try {
            mysql = await import('mysql2/promise');
        } catch {
            throw new Error('缺少 mysql2 依赖：请在该插件目录执行 npm install mysql2');
        }
        const pool = mysql.createPool({
            host: config.host,
            port: Number(config.port) || 3306,
            user: config.username,
            password: config.password,
            database: config.database || undefined,
            waitForConnections: true,
            connectionLimit: 4,
            ...(isPlainObject(config.extra) ? config.extra : {}),
        });
        return { type: 'mysql', raw: pool };
    }

    /** PostgreSQL：按需加载 pg */
    async _openPostgres(config) {
        let pg;
        try {
            pg = await import('pg');
        } catch {
            throw new Error('缺少 pg 依赖：请在该插件目录执行 npm install pg');
        }
        const Pool = pg.Pool || pg.default?.Pool;
        const pool = new Pool({
            host: config.host,
            port: Number(config.port) || 5432,
            user: config.username,
            password: config.password,
            database: config.database || undefined,
            max: 4,
            ...(isPlainObject(config.extra) ? config.extra : {}),
        });
        return { type: 'postgres', raw: pool };
    }

    /** Oracle：按需加载 oracledb（原生模块，装不上时给出明确指引） */
    async _openOracle(config) {
        let oracledb;
        try {
            oracledb = await import('oracledb');
        } catch (error) {
            throw new Error(`缺少 oracledb 依赖（原生模块，可能需匹配 Node ABI）：${error?.message || error}`);
        }
        const mod = oracledb.default || oracledb;
        const pool = await mod.createPool({
            user: config.username,
            password: config.password,
            connectString: `${config.host}:${Number(config.port) || 1521}/${config.database || ''}`,
            poolMax: 4,
        });
        return { type: 'oracle', raw: pool, mod };
    }

    /**
     * 达梦（DM8）：dmdb 驱动，API 与 oracledb 高度相似。
     *
     * 连接串格式是 `host:port`（不是 `host:port/sid`）。
     * dmdb 虽然 README 自称「原生驱动」，但实际是纯 JS 包（唯一依赖 iconv-lite），
     * 不存在 NODE_MODULE_VERSION 匹配问题，装得上就能用。
     *
     * 注意：dmdb 在**连接失败后的清理阶段**会抛 `TypeError: Cannot read
     * properties of undefined (reading 'log')`（pool.js:263，它自己的 bug），
     * 而且是未捕获的异步异常，会把宿主进程带崩。所以这里要：
     *   1. 连接失败时主动兜住这个异常；
     *   2. 进程级加一个 unhandledRejection 白名单过滤，只放行这个已知签名。
     */
    async _openDm(config) {
        let dmdb;
        try {
            dmdb = await import('dmdb');
        } catch (error) {
            throw new Error(`缺少 dmdb 依赖：请在该插件目录执行 npm install dmdb（${error?.message || error}）`);
        }
        const mod = dmdb.default || dmdb;
        try {
            /**
             * createPool 的 connectString 必须是完整 URL：
             *   dm://user:password@host:port
             * 不能像 oracledb 那样单独传 user/password（会报 "URL must start with 'dm://'"）。
             * 用户名/密码里的特殊字符要转义，否则 URL 解析会错位。
             */
            const user = encodeURIComponent(String(config.username || ''));
            const pass = encodeURIComponent(String(config.password || ''));
            const port = Number(config.port) || 5236;
            const connectString = `dm://${user}:${pass}@${config.host}:${port}`;
            const pool = await mod.createPool({
                connectString,
                poolMax: 4,
            });
            return { type: 'dm', raw: pool, mod };
        } catch (error) {
            // dmdb 连接失败时内部状态是半初始化的，close 会再抛一次；吞掉它
            try {
                if (error?.pool) await error.pool.close();
            } catch {
                /* dmdb 自身的清理 bug，忽略 */
            }
            throw error;
        }
    }

    _closePool(id) {
        const key = String(id || '');
        const handle = this.pools.get(key);
        if (!handle) return;
        this.pools.delete(key);
        try {
            if (handle.type === 'sqlite') handle.raw.close();
            else if (handle.raw && typeof handle.raw.end === 'function') {
                // mysql2 / pg 的 end() 返回 Promise，这里不等待，失败也不影响主流程
                Promise.resolve(handle.raw.end()).catch(() => {});
            } else if (handle.raw && typeof handle.raw.close === 'function') {
                Promise.resolve(handle.raw.close()).catch(() => {});
            }
        } catch {
            /* 关闭失败不影响删除操作 */
        }
    }

    /** 把驱动异常转成安全文案：去掉可能含密码的连接串 */
    _safeError(error) {
        let text = String(error?.message || error || '未知错误');
        // 有些驱动会把整条 DSN 打进 message，这里把 password=xxx 抹掉
        text = text.replace(/password\s*=\s*[^;\s]*/gi, 'password=***');
        text = text.replace(/:\/\/[^@\s]*@/g, '://***@');
        return text;
    }

    // ---------------------------------------------------------------- 执行
    /**
     * 执行 SQL。
     * @param {string} id - 连接 id
     * @param {string} sql - 单条 SQL
     * @param {Array} params - 参数化占位值
     * @param {{readonly?:boolean, maxRows?:number, timeoutMs?:number}} options
     */
    async query(id, sql, params = [], options = {}) {
        const text = String(sql || '').trim();
        if (text === '') return { ok: false, code: 'EMPTY_SQL', message: 'SQL 不能为空' };

        const statements = splitStatements(text);
        if (statements.length === 0) return { ok: false, code: 'EMPTY_SQL', message: 'SQL 不能为空' };
        if (statements.length > 1) {
            return {
                ok: false,
                code: 'MULTI_STATEMENT',
                message: `只允许单条语句，检测到 ${statements.length} 条。请拆开执行。`,
            };
        }
        const single = statements[0];

        if (options.readonly === true && !isReadOnlySql(single)) {
            return {
                ok: false,
                code: 'READONLY_VIOLATION',
                message: '只读模式已开启：只允许 SELECT / SHOW / DESCRIBE / EXPLAIN 等查询语句。要执行写操作请关闭只读模式。',
            };
        }

        const opened = await this._handle(id);
        if (!opened.ok) return opened;
        const handle = opened.handle;

        const started = Date.now();
        const maxRows = Number(options.maxRows) || this.maxRows;
        const timeoutMs = Number(options.timeoutMs) || this.timeoutMs;
        try {
            const result = await this._runWithTimeout(handle, single, Array.isArray(params) ? params : [], timeoutMs, maxRows);
            return {
                ok: true,
                connectionId: String(id),
                sql: single,
                durationMs: Date.now() - started,
                ...result,
            };
        } catch (error) {
            return {
                ok: false,
                code: 'DB_ERROR',
                message: this._safeError(error),
                durationMs: Date.now() - started,
            };
        }
    }

    /** 按驱动类型执行，并统一结果结构 */
    async _runWithTimeout(handle, sql, params, timeoutMs, maxRows) {
        const work = (async () => {
            if (handle.type === 'sqlite') {
                const stmt = handle.raw.prepare(sql);
                // 有参数时按参数化执行；否则区分「有结果集」与「纯写操作」
                const upper = sql.trim().toUpperCase();
                const returnsRows = /^(SELECT|WITH|PRAGMA|EXPLAIN|SHOW|DESC|DESCRIBE|TABLE)\b/.test(upper)
                    || stmt.columns?.().length > 0;
                if (returnsRows) {
                    const rows = params.length > 0 ? stmt.all(...params) : stmt.all();
                    return this._shapeRows(rows, maxRows);
                }
                const info = params.length > 0 ? stmt.run(...params) : stmt.run();
                return { columns: [], rows: [], rowCount: 0, affectedRows: Number(info?.changes || 0), lastInsertRowid: Number(info?.lastInsertRowid || 0) };
            }
            if (handle.type === 'mysql') {
                const [result, fields] = await handle.raw.query({ sql, timeout: timeoutMs }, params);
                if (Array.isArray(result)) {
                    const columns = Array.isArray(fields) ? fields.map((f) => f.name) : [];
                    return this._shapeRows(result, maxRows, columns);
                }
                return { columns: [], rows: [], rowCount: 0, affectedRows: Number(result?.affectedRows || 0) };
            }
            if (handle.type === 'postgres') {
                const result = await handle.raw.query({ text: sql, values: params, ...(timeoutMs ? { query_timeout: timeoutMs } : {}) });
                const columns = (result.fields || []).map((f) => f.name);
                if (columns.length > 0) return this._shapeRows(result.rows || [], maxRows, columns);
                return { columns: [], rows: [], rowCount: 0, affectedRows: Number(result.rowCount || 0) };
            }
            if (handle.type === 'oracle') {
                const result = await handle.raw.execute(sql, params, { outFormat: handle.mod?.OUT_FORMAT_OBJECT, maxRows });
                const rows = result.rows || [];
                const columns = (result.metaData || []).map((m) => m.name);
                return {
                    ...this._shapeRows(rows, maxRows, columns),
                    affectedRows: Number(result.rowsAffected || 0),
                };
            }
            if (handle.type === 'dm') {
                const result = await this._execute(handle, sql, params, { maxRows });
                const rows = result.rows || [];
                const columns = (result.metaData || []).map((m) => m.name);
                return {
                    ...this._shapeRows(rows, maxRows, columns),
                    affectedRows: Number(result.rowsAffected || 0),
                };
            }
            throw new Error(`未知驱动类型 ${handle.type}`);
        })();

        if (!timeoutMs || timeoutMs <= 0) return work;
        let timer;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`查询超时（${timeoutMs}ms）`)), timeoutMs);
            timer.unref?.();
        });
        try {
            return await Promise.race([work, timeout]);
        } finally {
            clearTimeout(timer);
        }
    }

    /** 统一结果集形状：列名 + 行数组 + 截断标记 */
    _shapeRows(rows, maxRows, columns) {
        const list = Array.isArray(rows) ? rows : [];
        const cols = Array.isArray(columns) && columns.length > 0
            ? columns
            : (list.length > 0 && isPlainObject(list[0]) ? Object.keys(list[0]) : []);
        const truncated = list.length > maxRows;
        const sliced = truncated ? list.slice(0, maxRows) : list;
        return {
            columns: cols,
            rows: sliced,
            rowCount: list.length,
            truncated,
            maxRows,
            note: truncated ? `结果共 ${list.length} 行，已截断为前 ${maxRows} 行` : undefined,
        };
    }

    // ---------------------------------------------------------------- 元数据
    /** 列出库（MySQL/PG 有库的概念；SQLite 只有文件） */
    async listDatabases(id) {
        const opened = await this._handle(id);
        if (!opened.ok) return opened;
        const handle = opened.handle;
        try {
            if (handle.type === 'sqlite') {
                return { ok: true, databases: [{ name: String(this._fullConfig(id)?.database || ':memory:') }] };
            }
            if (handle.type === 'mysql') {
                const [rows] = await handle.raw.query('SHOW DATABASES');
                return { ok: true, databases: rows.map((r) => ({ name: r.Database || r.database || Object.values(r)[0] })) };
            }
            if (handle.type === 'postgres') {
                const result = await handle.raw.query('SELECT datname AS name FROM pg_database WHERE datistemplate = false ORDER BY datname');
                return { ok: true, databases: result.rows };
            }
            if (handle.type === 'oracle') {
                return { ok: true, databases: [{ name: this._fullConfig(id)?.database || '' }] };
            }
            if (handle.type === 'dm') {
                // 达梦里「模式」（schema）≈ 其它库的「数据库」概念
                const result = await this._execute(handle, 'SELECT DISTINCT OWNER AS NAME FROM ALL_TABLES ORDER BY OWNER');
                const rows = (result.rows || []).map((r) => ({ name: r.NAME || r.name })).filter((r) => r.name);
                if (rows.length > 0) return { ok: true, databases: rows };
                return { ok: true, databases: [{ name: this._fullConfig(id)?.database || '' }] };
            }
            return { ok: false, code: 'UNSUPPORTED', message: `不支持的驱动 ${handle.type}` };
        } catch (error) {
            return { ok: false, code: 'DB_ERROR', message: this._safeError(error) };
        }
    }

    /** 列出表 */
    async listTables(id, database = '') {
        const opened = await this._handle(id);
        if (!opened.ok) return opened;
        const handle = opened.handle;
        try {
            if (handle.type === 'sqlite') {
                const rows = handle.raw
                    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
                    .all();
                return { ok: true, tables: rows.map((r) => ({ name: r.name })) };
            }
            if (handle.type === 'mysql') {
                const db = String(database || this._fullConfig(id)?.database || '');
                if (db === '') return { ok: false, code: 'MISSING_DATABASE', message: '请先指定数据库名' };
                const [rows] = await handle.raw.query(
                    'SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
                    [db],
                );
                return { ok: true, tables: rows.map((r) => ({ name: r.name, type: r.type })) };
            }
            if (handle.type === 'postgres') {
                const schema = String(database || 'public');
                const result = await handle.raw.query(
                    "SELECT table_name AS name, table_type AS type FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
                    [schema],
                );
                return { ok: true, tables: result.rows };
            }
            if (handle.type === 'oracle') {
                const result = await handle.raw.execute(
                    'SELECT table_name AS NAME FROM user_tables ORDER BY table_name',
                    [],
                    { outFormat: handle.mod?.OUT_FORMAT_OBJECT },
                );
                return { ok: true, tables: (result.rows || []).map((r) => ({ name: r.NAME || r.name })) };
            }
            if (handle.type === 'dm') {
                // 指定了模式就查那个模式，否则查当前用户可见的表
                const schema = String(database || '').trim().toUpperCase();
                const result = await this._execute(
                    handle,
                    schema
                        ? 'SELECT TABLE_NAME AS NAME FROM ALL_TABLES WHERE OWNER = ? ORDER BY TABLE_NAME'
                        : 'SELECT TABLE_NAME AS NAME FROM USER_TABLES ORDER BY TABLE_NAME',
                    schema ? [schema] : [],
                );
                return { ok: true, tables: (result.rows || []).map((r) => ({ name: r.NAME || r.name })) };
            }
            return { ok: false, code: 'UNSUPPORTED', message: `不支持的驱动 ${handle.type}` };
        } catch (error) {
            return { ok: false, code: 'DB_ERROR', message: this._safeError(error) };
        }
    }

    /** 表结构：字段 + 索引 */
    async describeTable(id, table) {
        const name = String(table || '').trim();
        if (name === '') return { ok: false, code: 'MISSING_TABLE', message: '需要表名' };
        const opened = await this._handle(id);
        if (!opened.ok) return opened;
        const handle = opened.handle;
        try {
            if (handle.type === 'sqlite') {
                // PRAGMA 不支持参数绑定，表名要转义引号防注入
                const safe = name.replace(/'/g, "''");
                const cols = handle.raw.prepare(`PRAGMA table_info('${safe}')`).all();
                const idx = handle.raw.prepare(`PRAGMA index_list('${safe}')`).all();
                const columns = cols.map((c) => ({
                    name: c.name,
                    type: c.type,
                    nullable: !c.notnull,
                    defaultValue: c.dflt_value,
                    primaryKey: Boolean(c.pk),
                }));
                const indexes = idx.map((i) => ({
                    name: i.name,
                    unique: Boolean(i.unique),
                    columns: handle.raw.prepare(`PRAGMA index_info('${String(i.name).replace(/'/g, "''")}')`).all().map((c) => c.name),
                }));
                return { ok: true, table: name, columns, indexes };
            }
            if (handle.type === 'mysql') {
                const db = String(this._fullConfig(id)?.database || '');
                if (db === '') return { ok: false, code: 'MISSING_DATABASE', message: '请先在连接里指定数据库名' };
                const [cols] = await handle.raw.query(
                    'SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS defaultValue, COLUMN_KEY AS columnKey, COLUMN_COMMENT AS comment FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
                    [db, name],
                );
                const [idx] = await handle.raw.query(
                    'SELECT INDEX_NAME AS name, NON_UNIQUE AS nonUnique, COLUMN_NAME AS columnName FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX',
                    [db, name],
                );
                return {
                    ok: true,
                    table: name,
                    columns: cols.map((c) => ({
                        name: c.name,
                        type: c.type,
                        nullable: String(c.nullable).toUpperCase() === 'YES',
                        defaultValue: c.defaultValue,
                        primaryKey: c.columnKey === 'PRI',
                        comment: c.comment || '',
                    })),
                    indexes: groupIndexes(idx, (r) => ({ name: r.name, unique: Number(r.nonUnique) === 0, column: r.columnName })),
                };
            }
            if (handle.type === 'postgres') {
                const cols = await handle.raw.query(
                    'SELECT column_name AS name, data_type AS type, is_nullable AS nullable, column_default AS "defaultValue" FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position',
                    [name],
                );
                const idx = await handle.raw.query(
                    'SELECT indexname AS name, indexdef AS def FROM pg_indexes WHERE tablename = $1',
                    [name],
                );
                return {
                    ok: true,
                    table: name,
                    columns: cols.rows.map((c) => ({
                        name: c.name,
                        type: c.type,
                        nullable: String(c.nullable).toUpperCase() === 'YES',
                        defaultValue: c.defaultValue,
                    })),
                    indexes: idx.rows.map((r) => ({ name: r.name, definition: r.def })),
                };
            }
            if (handle.type === 'oracle') {
                const cols = await handle.raw.execute(
                    'SELECT column_name AS NAME, data_type AS TYPE, nullable AS NULLABLE, data_default AS DEF FROM user_tab_columns WHERE table_name = :1 ORDER BY column_id',
                    [name.toUpperCase()],
                    { outFormat: handle.mod?.OUT_FORMAT_OBJECT },
                );
                return {
                    ok: true,
                    table: name,
                    columns: (cols.rows || []).map((c) => ({
                        name: c.NAME,
                        type: c.TYPE,
                        nullable: c.NULLABLE === 'Y',
                        defaultValue: c.DEF,
                    })),
                    indexes: [],
                };
            }
            if (handle.type === 'dm') {
                // 达梦用 ? 占位（不是 oracle 的 :1）
                const cols = await this._execute(
                    handle,
                    'SELECT COLUMN_NAME AS NAME, DATA_TYPE AS TYPE, NULLABLE AS NULLABLE, DATA_DEFAULT AS DEF FROM USER_TAB_COLUMNS WHERE TABLE_NAME = ? ORDER BY COLUMN_ID',
                    [name.toUpperCase()],
                );
                const idx = await this._execute(
                    handle,
                    'SELECT INDEX_NAME AS NAME, UNIQUENESS AS UNIQ FROM USER_INDEXES WHERE TABLE_NAME = ? ORDER BY INDEX_NAME',
                    [name.toUpperCase()],
                );
                return {
                    ok: true,
                    table: name,
                    columns: (cols.rows || []).map((c) => ({
                        name: c.NAME,
                        type: c.TYPE,
                        nullable: c.NULLABLE === 'Y',
                        defaultValue: c.DEF,
                    })),
                    indexes: (idx.rows || []).map((r) => ({
                        name: r.NAME,
                        unique: String(r.UNIQ).toUpperCase() === 'UNIQUE',
                    })),
                };
            }
            return { ok: false, code: 'UNSUPPORTED', message: `不支持的驱动 ${handle.type}` };
        } catch (error) {
            return { ok: false, code: 'DB_ERROR', message: this._safeError(error) };
        }
    }

    /** 试连：真正建一次连接并执行最轻量的探测语句 */
    async testConnection(target) {
        const started = Date.now();
        // 支持传已有 id，或传一份完整配置（新建前先试）
        let id = '';
        if (typeof target === 'string') id = target;
        else if (isPlainObject(target) && target.id) id = String(target.id);
        else if (isPlainObject(target)) {
            // 临时配置：存一个临时 id 再试，试完删掉
            const saved = this.saveConnection({ ...target, name: target.name || '__probe__' });
            if (!saved.ok) return { ...saved, durationMs: Date.now() - started };
            id = saved.connection.id;
            try {
                return await this._probe(id, started);
            } finally {
                this.deleteConnection(id);
            }
        }
        if (!id) return { ok: false, code: 'MISSING_ARGUMENT', message: '需要连接 id 或配置' };
        return this._probe(id, started);
    }

    async _probe(id, started) {
        const opened = await this._handle(id);
        if (!opened.ok) return { ...opened, durationMs: Date.now() - started };
        const handle = opened.handle;
        try {
            if (handle.type === 'sqlite') handle.raw.prepare('SELECT 1').all();
            else if (handle.type === 'mysql') await handle.raw.query('SELECT 1');
            else if (handle.type === 'postgres') await handle.raw.query('SELECT 1');
            else if (handle.type === 'oracle') await handle.raw.execute('SELECT 1 FROM dual');
            else if (handle.type === 'dm') await this._execute(handle, 'SELECT 1');
            return { ok: true, durationMs: Date.now() - started, message: '连接成功' };
        } catch (error) {
            return { ok: false, code: 'DB_ERROR', message: this._safeError(error), durationMs: Date.now() - started };
        }
    }

    /** 关闭所有连接池（插件卸载时调用） */
    dispose() {
        for (const key of [...this.pools.keys()]) this._closePool(key);
    }

    /**
     * 统一的 execute 封装：dmdb 的 Pool 没有 execute（只有 getConnection），
     * oracledb 的 Pool 有。这里抹平差异，元数据/探测代码都走它。
     */
    async _execute(handle, sql, params = [], options = {}) {
        if (handle.type === 'dm') {
            const conn = await handle.raw.getConnection();
            try {
                return await conn.execute(sql, params, { outFormat: handle.mod?.OUT_FORMAT_OBJECT, ...options });
            } finally {
                try {
                    await conn.close();
                } catch {
                    /* 归还失败不影响结果 */
                }
            }
        }
        return handle.raw.execute(sql, params, { outFormat: handle.mod?.OUT_FORMAT_OBJECT, ...options });
    }
}

/** 把 information_schema.STATISTICS 的多行按索引名合并 */
function groupIndexes(rows, map) {
    const byName = new Map();
    for (const row of rows) {
        const item = map(row);
        const existing = byName.get(item.name);
        if (existing) existing.columns.push(item.column);
        else byName.set(item.name, { name: item.name, unique: item.unique, columns: [item.column] });
    }
    return [...byName.values()];
}
