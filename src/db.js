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

/**
 * 是否毁灭性操作：即使有读写权限也要额外确认。
 *
 * 判定标准偏保守——宁可误拒，不可误放：
 *   - DROP / TRUNCATE：直接删结构或清空表
 *   - DELETE / UPDATE 没有 WHERE：影响整表
 *   - 任何 GRANT / REVOKE：改权限
 */
export function isDestructiveSql(sql) {
    const stripped = stripStringsAndComments(String(sql || '')).trim();
    if (/^\s*(drop|truncate|grant|revoke)\b/i.test(stripped)) return true;
    // DELETE / UPDATE 缺少 WHERE 子句 = 全表操作
    if (/^\s*(delete|update)\b/i.test(stripped) && !/\bwhere\b/i.test(stripped)) return true;
    return false;
}

/** 授权等级：none < readonly < readwrite */
export const ACCESS_LEVELS = ['none', 'readonly', 'readwrite'];

/** 等级比较：是否满足所需等级 */
function levelAtLeast(actual, required) {
    const order = { none: 0, readonly: 1, readwrite: 2 };
    return (order[actual] ?? 0) >= (order[required] ?? 0);
}

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

/** 是否只读语句（仅看开头，作为第一道粗筛；真正的判定见 classifySql） */
export function isReadOnlySql(sql) {
    return READONLY_PREFIX.test(String(sql || ''));
}

/**
 * 危险关键字：出现在**任何位置**都视为写操作，即使语句以 SELECT 开头。
 *
 * 为什么要全串扫描而不是只看前缀：
 *   - `WITH x AS (SELECT 1) DELETE FROM t` 以 WITH 开头，但会删数据
 *   - `SELECT * FROM t FOR UPDATE` 会加锁，阻塞别人写入
 *   - `SELECT ... INTO OUTFILE` / `INTO DUMPFILE` 能往磁盘写文件
 *   - `SELECT load_file('/etc/passwd')` 能读任意文件
 *   - `EXPLAIN ANALYZE DELETE ...` 会真的执行
 * 这些用「开头是不是 SELECT」都拦不住。
 */
const DANGEROUS_KEYWORDS = [
    'insert', 'update', 'delete', 'merge', 'upsert',
    'create', 'alter', 'drop', 'truncate', 'rename',
    'grant', 'revoke', 'comment',
    'exec', 'execute', 'call', 'perform',
    'lock', 'unlock',
    'copy', 'load', 'outfile', 'dumpfile',
    'attach', 'detach', 'vacuum', 'reindex',
    'set', 'commit', 'rollback', 'savepoint', 'begin',
    'declare', 'prepare', 'deallocate',
    'analyze', 'optimize', 'repair', 'shutdown', 'kill',
];

/** 需要额外警惕的「以 SELECT 开头但会写」的组合 */
const SELECT_WRITE_PATTERNS = [
    /\bfor\s+(update|share|no\s+key\s+update)\b/i,   // 加锁
    /\binto\s+(outfile|dumpfile)\b/i,                 // 写文件
    /\binto\s+@?[\w.]+\s+from\b/i,                    // SELECT INTO 建表
    /\bload_file\s*\(/i,                              // 读服务器文件
];

/**
 * PRAGMA 的两种形态：
 *   - 查询式：`PRAGMA table_info('t')`、`PRAGMA index_list(t)` —— 只读，放行
 *   - 赋值式：`PRAGMA journal_mode = WAL`、`PRAGMA user_version = 5` —— 改配置，拦
 * 白名单只放行已知的只读 pragma，其余一律按写处理。
 */
const READONLY_PRAGMA = /^\s*pragma\s+(table_info|table_xinfo|index_info|index_list|index_xinfo|foreign_key_list|foreign_key_check|database_list|collation_list|function_list|module_list|pragma_list|compile_options|integrity_check|quick_check|encoding|page_count|page_size|freelist_count|schema_version|user_version|journal_mode|wal_checkpoint)\b/i;
/** 允许「读」但不允许「写」的 pragma：带 `=` 时是写 */
const MUTABLE_PRAGMA = /^\s*pragma\s+(journal_mode|user_version|synchronous|foreign_keys|cache_size|busy_timeout|locking_mode|page_size|auto_vacuum|wal_autocheckpoint|mmap_size|temp_store|encoding)\b/i;

/**
 * 去掉 SQL 里的字符串字面量和注释，只留「结构性内容」。
 * 关键字扫描必须基于这个结果，否则 `WHERE note = 'delete'` 会被误判成写操作。
 */
export function stripStringsAndComments(sql) {
    const text = String(sql || '');
    let out = '';
    let i = 0;
    let quote = '';
    while (i < text.length) {
        const ch = text[i];
        const next = text[i + 1];
        if (quote) {
            if (ch === '\\' && (quote === "'" || quote === '"')) { i += 2; continue; }
            if (ch === quote) {
                if (next === quote) { i += 2; continue; }
                quote = '';
            }
            i += 1;
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') { quote = ch; i += 1; continue; }
        if (ch === '-' && next === '-') {
            const nl = text.indexOf('\n', i);
            i = nl === -1 ? text.length : nl + 1;
            continue;
        }
        if (ch === '/' && next === '*') {
            const close = text.indexOf('*/', i + 2);
            i = close === -1 ? text.length : close + 2;
            continue;
        }
        out += ch;
        i += 1;
    }
    return out;
}

/**
 * 判定一条 SQL 的性质。
 *
 * @returns {{ kind: 'read'|'write'|'unknown', reason?: string, keyword?: string }}
 *   - read：确定是只读查询，可以在只读模式下执行
 *   - write：包含写/危险操作，只读模式下必须拒绝
 *   - unknown：认不出来，按最严格的处理（只读模式下拒绝）
 */
export function classifySql(sql) {
    const text = String(sql || '').trim();
    if (text === '') return { kind: 'unknown', reason: 'SQL 为空' };

    const stripped = stripStringsAndComments(text);

    // 多语句：哪怕每一条都只读，也不允许（防止用分号绕过）
    if (splitStatements(text).length > 1) {
        return { kind: 'write', reason: '包含多条语句' };
    }

    // 危险关键字：全串扫描（已剔除字符串和注释）
    for (const kw of DANGEROUS_KEYWORDS) {
        const re = new RegExp(`\\b${kw}\\b`, 'i');
        if (re.test(stripped)) {
            return { kind: 'write', reason: `包含写操作关键字 ${kw.toUpperCase()}`, keyword: kw };
        }
    }

    // SELECT 开头但带锁/写文件等
    for (const pattern of SELECT_WRITE_PATTERNS) {
        if (pattern.test(stripped)) {
            return { kind: 'write', reason: '查询语句包含加锁或写文件动作' };
        }
    }

    // PRAGMA 单独判定：赋值式会改库配置，必须拦
    if (/^\s*pragma\b/i.test(stripped)) {
        // 可变的 pragma 带 `=` 或带参数但不是查询式 → 写
        if (MUTABLE_PRAGMA.test(stripped) && /\s*=\s*/.test(stripped)) {
            return { kind: 'write', reason: 'PRAGMA 赋值会修改数据库配置' };
        }
        // 只读白名单
        if (READONLY_PRAGMA.test(stripped)) {
            return { kind: 'read' };
        }
        // 认不出来的 pragma：按最严格处理
        return { kind: 'unknown', reason: '无法确认这条 PRAGMA 是只读的' };
    }

    // 结构上必须以只读关键字开头
    if (!READONLY_PREFIX.test(text)) {
        return { kind: 'unknown', reason: '无法识别为只读查询（只允许 SELECT / SHOW / DESCRIBE / EXPLAIN / PRAGMA）' };
    }

    return { kind: 'read' };
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

/**
 * 把连接串里的密码打码，用于界面回显与日志。
 * 形如 `dm://FUND:***@192.168.0.144:8185?...` —— 保留用户名和其余部分，
 * 用户能确认「填的是哪个连接」，但看不到密码。
 */
export function maskUrlPassword(connectString) {
    const text = String(connectString || '');
    // scheme://user:pass@rest
    return text.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^:/@]*):([^@]*)@/i, (_all, scheme, user, pass) => {
        return `${scheme}${user}:${pass ? '***' : ''}@`;
    });
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
        /**
         * 试连的独立超时（默认 15s）。
         * 比查询超时短：试连是交互动作，用户盯着等，不能让驱动自己卡 60 秒。
         */
        this.probeTimeoutMs = Number(options.probeTimeoutMs) || 15000;
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

    // ---------------------------------------------------------------- 项目授权
    /**
     * 授权模型：**按项目（工作空间）授权，默认拒绝**。
     *
     * 为什么默认拒绝而不是默认允许：
     *   一个连到生产库的连接，如果默认对所有项目开放，那么任何一个会话
     *   都能读它——这不可接受。所以新连接创建后是「未授权」状态，
     *   必须由用户在面板里显式授权给某个项目。
     *
     * 存储：`<数据目录>/db-connections.json` 的 `access` 命名空间，
     * 形如 { "<projectKey>": { "<connectionId>": "readonly" } }。
     */
    _loadAccess() {
        const ns = readStateNamespace(this.file, 'access');
        return isPlainObject(ns.projects) ? ns.projects : {};
    }

    _saveAccess(projects) {
        writeStateNamespace(this.file, 'access', { projects });
    }

    /** 某个项目对所有连接的授权表：{ connectionId: level } */
    accessOf(projectKey) {
        const key = String(projectKey || 'default');
        const all = this._loadAccess();
        const row = all[key];
        return isPlainObject(row) ? row : {};
    }

    /** 设置某项目对某连接的授权等级 */
    setAccess(projectKey, connectionId, level) {
        const key = String(projectKey || 'default');
        const cid = String(connectionId || '');
        if (cid === '') return { ok: false, code: 'MISSING_CONNECTION', message: '需要 connection_id' };
        const lv = String(level || 'none');
        if (!ACCESS_LEVELS.includes(lv)) {
            return { ok: false, code: 'BAD_LEVEL', message: `授权等级只能是 ${ACCESS_LEVELS.join(' / ')}` };
        }
        const all = this._loadAccess();
        const row = isPlainObject(all[key]) ? { ...all[key] } : {};
        if (lv === 'none') delete row[cid];
        else row[cid] = lv;
        all[key] = row;
        this._saveAccess(all);
        return { ok: true, projectKey: key, connectionId: cid, level: lv, access: row };
    }

    /** 某项目的完整授权视图（给面板用）：连接 + 当前等级 */
    accessView(projectKey) {
        const key = String(projectKey || 'default');
        const row = this.accessOf(key);
        const connections = this.listConnections().map((item) => ({
            id: item.id,
            name: item.name,
            type: item.type,
            target: item.urlMode ? item.connectString : (item.type === 'sqlite' ? item.file : `${item.host}:${item.port}/${item.database}`),
            level: row[item.id] || 'none',
        }));
        const authorized = connections.filter((item) => item.level !== 'none').length;
        return { ok: true, projectKey: key, connections, authorized, total: connections.length };
    }

    /**
     * 解析某个项目对某连接的访问权。
     *
     * options.projectKey 缺省时用 'default'（没有会话上下文的情况），
     * 这样工具调用和面板请求都能落到同一个可预期的档位。
     *
     * connectionOverride：面板试连时用草稿配置，此时没有连接 id，
     * 允许跳过授权检查（试连只做最轻量的 SELECT 1，不读业务数据）。
     */
    resolveAccess(connectionId, projectKey, connectionOverride) {
        if (connectionOverride) return { ok: true, level: 'readonly', projectKey: String(projectKey || 'default') };
        const key = String(projectKey || 'default');
        const cid = String(connectionId || '');
        if (cid === '') return { ok: false, code: 'MISSING_CONNECTION', message: '需要 connection_id' };
        const level = this.accessOf(key)[cid] || 'none';
        if (level === 'none') {
            return {
                ok: false,
                code: 'NOT_AUTHORIZED',
                message: `项目「${key}」没有获得这条连接的授权。请到面板「项目授权」里授权（只读 / 读写）后再试。`,
            };
        }
        return { ok: true, level, projectKey: key };
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
            /** URL 模式：回显时把密码打码，避免明文出现在界面/日志里 */
            connectString: item.connectString ? maskUrlPassword(item.connectString) : '',
            urlMode: Boolean(item.connectString),
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

        /**
         * 两种录入方式：
         *   - 分字段：host / port / database / username / password
         *   - URL：connectString 原样使用（dm://...、mysql://... 等）
         * URL 模式下不再强制 host，字段校验要按模式分支，否则「填了 URL 却报缺 host」。
         */
        const connectString = String(input.connectString ?? existing?.connectString ?? '').trim();
        const urlMode = connectString !== '';

        // sqlite 用 database 字段存文件路径；其它类型（非 URL 模式）需要 host
        const database = String(input.database ?? existing?.database ?? '').trim();
        if (type === 'sqlite' && database === '') {
            return { ok: false, code: 'MISSING_DATABASE', message: 'SQLite 连接需要填写数据库文件路径（:memory: 表示内存库）' };
        }
        if (type !== 'sqlite' && !urlMode && String(input.host ?? existing?.host ?? '').trim() === '') {
            return { ok: false, code: 'MISSING_HOST', message: `${type} 连接需要填写 host（或改用 URL 模式）` };
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
            /** URL 模式下的完整连接串（空表示分字段模式） */
            connectString,
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
        // URL 模式直接交给 mysql2 解析（它原生支持 mysql:// 串）
        if (config.connectString) {
            const pool = mysql.createPool({
                uri: config.connectString,
                waitForConnections: true,
                connectionLimit: 4,
                ...(isPlainObject(config.extra) ? config.extra : {}),
            });
            return { type: 'mysql', raw: pool };
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
        // URL 模式：pg 的 Pool 支持 connectionString
        if (config.connectString) {
            const pool = new Pool({
                connectionString: config.connectString,
                max: 4,
                ...(isPlainObject(config.extra) ? config.extra : {}),
            });
            return { type: 'postgres', raw: pool };
        }
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
        // URL 模式：oracle 的 connectString 本身就是 host:port/service 形式，直接透传
        const connectString = config.connectString
            || `${config.host}:${Number(config.port) || 1521}/${config.database || ''}`;
        const pool = await mod.createPool({
            user: config.username,
            password: config.password,
            connectString,
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
            /**
             * import 失败有两种，必须分开说，否则用户按「缺依赖」去装包可能白装：
             *
             *   1. ERR_MODULE_NOT_FOUND —— 真的没装。给出安装命令。
             *   2. 其它错误 —— 包装了但加载时抛异常（依赖损坏、Node 版本不兼容、
             *      或它内部某个初始化挂了）。这时「去装 dmdb」是没用的，
             *      要告诉用户真实原因和排查方法。
             */
            const code = error?.code || '';
            const detail = String(error?.message || error);
            if (code === 'ERR_MODULE_NOT_FOUND' || /Cannot find package/i.test(detail)) {
                throw new Error(
                    `缺少 dmdb 依赖。请在该插件目录执行 npm install dmdb，`
                    + `或改用 npm 安装插件（会自动带依赖）：${detail}`,
                );
            }
            // 包装了但加载失败：把堆栈前几行带出来，便于定位是哪一行挂的
            const stackTop = String(error?.stack || '')
                .split('\n')
                .slice(1, 4)
                .map((line) => line.trim())
                .filter(Boolean)
                .join(' ← ');
            throw new Error(
                `dmdb 已安装但加载失败（不是缺包，装它没用）。`
                + `原始错误：${detail}`
                + (stackTop ? `；位置：${stackTop}` : '')
                + `。常见原因：dmdb 版本与当前 Node 不兼容，或它的依赖装坏了——`
                + `在该插件目录删掉 node_modules/dmdb 后重新 npm install dmdb。`,
            );
        }

        /**
         * dmdb 的导出结构在不同版本/打包方式下不一致：
         * 有 `default`、有具名 `dmdb`、也有直接挂在模块上的。
         * 逐个尝试，找不到就明确说清楚，而不是让它变成
         * `Cannot convert undefined or null to object` 这种天书。
         */
        const candidates = [dmdb?.default, dmdb?.dmdb, dmdb?.default?.dmdb, dmdb];
        const mod = candidates.find((m) => m && typeof m.createPool === 'function');
        if (!mod) {
            const keys = Object.keys(dmdb || {}).slice(0, 12).join(', ');
            throw new Error(
                `dmdb 已安装但结构不可识别（没有 createPool）。导出项：${keys || '(空)'}。`
                + '请确认安装的是 npm 上的 dmdb，而不是其它同名包。',
            );
        }

        try {
            /**
             * connectString 的格式：
             *   - url 模式：原样使用用户填的 dm://... 串
             *   - 分字段模式：dm://user:password@host:port
             *
             * **必须显式给 poolAlias**：dmdb 的 poolAlias 默认是 "default"，
             * 第二个连接池就会报「数据库别名已存在」，而且后面测试/编辑/删除全废。
             * 这里用连接 id 派生出唯一别名，保证多个达梦连接能共存。
             */
            let connectString = String(config.connectString || '').trim();
            if (connectString === '') {
                const user = encodeURIComponent(String(config.username || ''));
                const pass = encodeURIComponent(String(config.password || ''));
                const port = Number(config.port) || 5236;
                connectString = `dm://${user}:${pass}@${config.host}:${port}`;
            }
            if (!/^dm:\/\//i.test(connectString)) {
                throw new Error(`达梦连接串必须以 dm:// 开头，当前是：${connectString.slice(0, 40)}`);
            }
            const poolAlias = `dsh-api-runner-${String(config.id || 'conn').replace(/[^\w-]/g, '_')}`;
            const pool = await mod.createPool({
                connectString,
                poolAlias,
                poolMax: 4,
                ...(isPlainObject(config.extra) ? config.extra : {}),
            });
            return { type: 'dm', raw: pool, mod, poolAlias };
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
                // dmdb / oracledb 的 close 也返回 Promise
                Promise.resolve(handle.raw.close()).catch(() => {});
            }
            /**
             * dmdb 把自己的池登记在 `dmdb.pools` 全局表里，close 之后**不一定**
             * 会删掉这条登记（它内部只在特定分支删）。残留的别名会让下次
             * 创建同名池时报「数据库别名已存在」，所以这里主动清一次。
             */
            if (handle.type === 'dm' && handle.poolAlias && handle.mod?.pools) {
                try {
                    handle.mod.pools.delete(handle.poolAlias);
                } catch {
                    /* 注册表结构变化时忽略 */
                }
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

        /**
         * 权限判定顺序（从严格到宽松，任何一步不通过就拒绝）：
         *   1. 项目授权：当前工作空间必须对该连接有授权
         *   2. **只读开关**：options.readonly=true 时，任何非只读语句一律拒绝
         *   3. 授权等级：写操作要求 readwrite
         *   4. 毁灭性操作：即使有读写权限也额外拦截
         *
         * 第 2 步是模型侧的硬闸门：main.js 对工具调用固定传 readonly:true，
         * 所以模型无论怎么构造参数都写不了数据。
         */
        const auth = this.resolveAccess(id, options.projectKey, options.connectionOverride);
        if (!auth.ok) return auth;

        const verdict = classifySql(single);

        // 第 2 步：只读模式 —— 非只读语句直接拒，不看授权等级
        if (options.readonly === true && verdict.kind !== 'read') {
            return {
                ok: false,
                code: 'READONLY_VIOLATION',
                message: `只读模式已开启：只允许 SELECT / SHOW / DESCRIBE / EXPLAIN 等查询语句。${verdict.reason ? `（${verdict.reason}）` : ''}要执行写操作请由人在面板里操作。`,
            };
        }

        if (verdict.kind !== 'read') {
            // 第 3 步：写操作必须 readwrite 授权
            if (auth.level !== 'readwrite') {
                return {
                    ok: false,
                    code: 'PERMISSION_DENIED',
                    message: `当前项目对这条连接只有「${auth.level === 'readonly' ? '只读' : '未授权'}」权限，不能执行写操作。${verdict.reason ? `（${verdict.reason}）` : ''}`,
                };
            }
            // 第 4 步：毁灭性操作
            if (isDestructiveSql(single) && options.allowDestructive !== true) {
                return {
                    ok: false,
                    code: 'DESTRUCTIVE_BLOCKED',
                    message: '拒绝执行：这条语句会破坏数据结构或数据（DROP / TRUNCATE / 无 WHERE 的 DELETE / UPDATE 等）。即使有读写权限也不允许通过工具执行，请到数据库客户端人工操作。',
                };
            }
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
    /**
     * 驱动自检：报告每个可选驱动能否加载。
     *
     * 为什么需要：用户装完插件后如果某个驱动没装上或装坏了，
     * 报错信息很难定位（尤其「包装了但加载失败」）。这个接口直接给出
     * 「装没装 / 能不能用 / 版本多少 / 报什么错」，面板上一键就能看。
     */
    async diagnose() {
        const checks = [
            { name: 'sqlite', label: 'SQLite', builtin: true },
            { name: 'mysql2', label: 'MySQL' },
            { name: 'pg', label: 'PostgreSQL' },
            { name: 'oracledb', label: 'Oracle' },
            { name: 'dmdb', label: '达梦' },
        ];
        const out = [];
        for (const item of checks) {
            if (item.builtin) {
                let ok = false;
                let detail = '';
                try {
                    const { DatabaseSync } = await import('node:sqlite');
                    ok = typeof DatabaseSync === 'function';
                    detail = ok ? `Node ${process.versions.node} 内置` : 'node:sqlite 不可用';
                } catch (error) {
                    detail = `Node ${process.versions.node} 不支持 node:sqlite（需要 >=22.5）：${error.message}`;
                }
                out.push({ name: item.name, label: item.label, installed: ok, ok, version: '', detail });
                continue;
            }
            try {
                const mod = await import(item.name);
                // 找到真正带 API 的那个导出
                const real = [mod?.default, mod?.dmdb, mod?.default?.dmdb, mod]
                    .find((m) => m && (typeof m.createPool === 'function' || typeof m.Pool === 'function' || typeof m.createConnection === 'function'));
                let version = '';
                try {
                    version = String(mod?.default?.version || mod?.version || '');
                } catch { /* 有的包不暴露 version */ }
                out.push({
                    name: item.name,
                    label: item.label,
                    installed: true,
                    ok: Boolean(real),
                    version,
                    detail: real ? '可用' : `已安装但结构异常（导出项：${Object.keys(mod || {}).slice(0, 8).join(', ') || '空'}）`,
                });
            } catch (error) {
                const code = error?.code || '';
                const missing = code === 'ERR_MODULE_NOT_FOUND' || /Cannot find package/i.test(String(error?.message));
                out.push({
                    name: item.name,
                    label: item.label,
                    installed: false,
                    ok: false,
                    version: '',
                    detail: missing
                        ? '未安装（在该插件目录执行 npm install 即可）'
                        : `已安装但加载失败：${error?.message || error}`,
                });
            }
        }
        return {
            ok: true,
            node: process.versions.node,
            drivers: out,
            /** 有任何一个驱动「装了但用不了」，就值得提醒 */
            broken: out.filter((d) => d.installed && !d.ok).map((d) => d.name),
            missing: out.filter((d) => !d.installed && d.name !== 'sqlite').map((d) => d.name),
        };
    }

    async listDatabases(id, options = {}) {
        const auth = this.resolveAccess(id, options.projectKey, options.connectionOverride);
        if (!auth.ok) return auth;
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
    async listTables(id, database = '', options = {}) {
        const auth = this.resolveAccess(id, options.projectKey, options.connectionOverride);
        if (!auth.ok) return auth;
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
    async describeTable(id, table, options = {}) {
        const name = String(table || '').trim();
        if (name === '') return { ok: false, code: 'MISSING_TABLE', message: '需要表名' };
        const auth = this.resolveAccess(id, options.projectKey, options.connectionOverride);
        if (!auth.ok) return auth;
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

    /**
     * 试连：真正建一次连接并执行最轻量的探测语句。
     *
     * @param {string|object} target - 连接 id，或一份草稿配置
     * @param {{timeoutMs?:number}} options - 超时（默认 probeTimeoutMs）
     */
    async testConnection(target, options = {}) {
        const started = Date.now();
        const timeoutMs = Number(options.timeoutMs) || this.probeTimeoutMs;
        /**
         * 支持三种入参：
         *   1. 已有连接的 id（字符串）
         *   2. 带 id 的完整配置对象（编辑时用当前表单值试，不落盘）
         *   3. 没有 id 的草稿配置（新增时试连）
         *
         * 草稿**不临时存记录**：那样会污染连接列表，而且 dmdb 的连接池别名
         * 按 id 生成，临时 id 和正式 id 会互相撞。这里直接构造临时句柄试连。
         */
        if (typeof target === 'string' && target !== '') {
            return this._withTimeout(
                this._probe(target, started),
                timeoutMs,
                `连接超时（${timeoutMs}ms）`,
            ).catch((error) => ({
                ok: false,
                code: 'PROBE_TIMEOUT',
                message: this._safeError(error),
                durationMs: Date.now() - started,
            }));
        }

        if (isPlainObject(target)) {
            const draft = { ...target };
            if (draft.id) {
                // 编辑已有连接：用保存过的密码（表单里的密码框是空的）
                const full = this._fullConfig(draft.id);
                if (full && (draft.password === undefined || draft.password === '')) draft.password = full.password;
                if (full && !draft.connectString && full.connectString) draft.connectString = full.connectString;
            }
            const normalized = this._normalizeDraft(draft);
            if (!normalized.ok) return { ...normalized, durationMs: Date.now() - started };
            return this._probeDraft(normalized.config, started, timeoutMs);
        }

        return { ok: false, code: 'MISSING_ARGUMENT', message: '需要连接 id 或配置' };
    }

    /** 把草稿补成完整配置（补齐默认端口等），不落盘 */
    _normalizeDraft(draft) {
        const type = String(draft.type || 'sqlite').toLowerCase();
        if (!DB_TYPES.includes(type)) {
            return { ok: false, code: 'BAD_TYPE', message: `不支持的数据库类型：${type}` };
        }
        const connectString = String(draft.connectString || '').trim();
        /**
         * 试连必须用**独立于正式连接**的临时 id。
         *
         * 之前这里直接沿用 draft.id（编辑时就是已保存连接的 id），
         * 于是 dmdb 会用同一个 poolAlias 再建一次池，撞上「连接池别名已存在」；
         * 而且撞完后该连接的后续测试/编辑/删除全废。
         * 统一加 probe- 前缀，保证试连的池和正式池永不重名。
         */
        const probeId = `probe-${crypto.randomBytes(4).toString('hex')}`;
        const config = {
            id: probeId,
            type,
            host: String(draft.host || '').trim(),
            port: Number(draft.port) || DEFAULT_PORTS[type] || 0,
            database: String(draft.database || '').trim(),
            username: String(draft.username || '').trim(),
            password: String(draft.password || ''),
            connectString,
            extra: isPlainObject(draft.extra) ? draft.extra : {},
        };
        if (type === 'sqlite' && config.database === '') {
            return { ok: false, code: 'MISSING_DATABASE', message: 'SQLite 需要填写数据库文件路径（:memory: 表示内存库）' };
        }
        if (type !== 'sqlite' && connectString === '' && config.host === '') {
            return { ok: false, code: 'MISSING_HOST', message: `${type} 需要填写 host（或改用 URL 模式）` };
        }
        return { ok: true, config };
    }

    /**
     * 用临时句柄试连，结束后一定关掉。
     *
     * **必须有超时**：达梦/MySQL 连不上时驱动自己会卡 30–60 秒，
     * 期间面板所有按钮都被 disabled，用户会以为「点不动了」。
     * 这里在打开阶段和探测阶段各加一层超时，最坏情况 ~15 秒返回。
     */
    async _probeDraft(config, started, timeoutMs) {
        const budget = Number(timeoutMs) || this.probeTimeoutMs || 15000;
        let handle;
        try {
            handle = await this._withTimeout(
                (async () => {
                    if (config.type === 'sqlite') return this._openSqlite(config);
                    if (config.type === 'mysql') return this._openMysql(config);
                    if (config.type === 'postgres') return this._openPostgres(config);
                    if (config.type === 'oracle') return this._openOracle(config);
                    if (config.type === 'dm') return this._openDm(config);
                    throw new Error(`不支持的数据库类型：${config.type}`);
                })(),
                budget,
                `连接超时（${budget}ms）`,
            );
        } catch (error) {
            return { ok: false, code: 'CONNECT_FAILED', message: this._safeError(error), durationMs: Date.now() - started };
        }
        const remaining = Math.max(2000, budget - (Date.now() - started));
        const probe = await this._withTimeout(
            this._probeHandle(handle, started),
            remaining,
            `探测超时（${remaining}ms）`,
        ).catch((error) => ({
            ok: false,
            code: 'PROBE_TIMEOUT',
            message: this._safeError(error),
            durationMs: Date.now() - started,
        }));
        // 试连用的池不能留着，否则 dmdb 别名/资源都会累积
        this._closeHandle(handle);
        return probe;
    }

    /** 给任意 Promise 套一个超时；超时后不再等它，但也不阻塞后续清理 */
    _withTimeout(promise, ms, message) {
        const timeout = Number(ms);
        if (!timeout || timeout <= 0) return promise;
        let timer;
        const guard = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(message)), timeout);
            timer.unref?.();
        });
        return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
    }

    async _probe(id, started) {
        const opened = await this._handle(id);
        if (!opened.ok) return { ...opened, durationMs: Date.now() - started };
        return this._probeHandle(opened.handle, started);
    }

    /** 对任意句柄跑最轻量的探测语句 */
    async _probeHandle(handle, started) {
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

    /** 关闭任意句柄（不涉及 this.pools 注册表） */
    _closeHandle(handle) {
        if (!handle) return;
        try {
            if (handle.type === 'sqlite') handle.raw.close();
            else if (handle.raw && typeof handle.raw.end === 'function') Promise.resolve(handle.raw.end()).catch(() => {});
            else if (handle.raw && typeof handle.raw.close === 'function') Promise.resolve(handle.raw.close()).catch(() => {});
            if (handle.type === 'dm' && handle.poolAlias && handle.mod?.pools) {
                try {
                    handle.mod.pools.delete(handle.poolAlias);
                } catch {
                    /* 注册表结构变化时忽略 */
                }
            }
        } catch {
            /* 关闭失败不影响结果 */
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
