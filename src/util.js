/**
 * 通用小工具：配置发现、模板展开、文本裁剪、进程存活判断。
 * 本文件不依赖 cordis，可在纯 node 下单独测试。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 是否普通对象（排除数组、null） */
export function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 按“字节上限”截断文本，并给出截断提示 */
export function truncateText(text, maxBytes = 32 * 1024) {
    if (typeof text !== 'string') return '';
    const buf = Buffer.from(text, 'utf8');
    if (buf.length <= maxBytes) return text;
    // 从末尾往前找换行，避免切碎多字节字符
    let end = maxBytes;
    const slice = buf.subarray(0, end).toString('utf8');
    const cut = slice.lastIndexOf('\n');
    const body = cut > 0 ? slice.slice(0, cut) : slice;
    return `${body}\n…[已截断，原始 ${buf.length} 字节，仅显示前 ${maxBytes} 字节]`;
}

/** 展开 ${NAME}：先查 scope，再查 process.env；查不到保持原样 */
export function expandDollar(source, scope = {}) {
    if (typeof source !== 'string') return source;
    return source.replace(/\$\{([A-Za-z_][A-Za-z0-9_.-]*)\}/g, (whole, name) => {
        if (Object.prototype.hasOwnProperty.call(scope, name) && scope[name] !== undefined && scope[name] !== null) {
            return String(scope[name]);
        }
        const envValue = process.env[name];
        return envValue === undefined ? whole : envValue;
    });
}

/** 展开调用期占位符 {key}：只替换 vars 中存在的键，其余原样保留 */
export function expandBraces(source, vars = {}) {
    if (typeof source !== 'string') return source;
    if (!vars || Object.keys(vars).length === 0) return source;
    return source.replace(/\{([A-Za-z_][A-Za-z0-9_.-]*)\}/g, (whole, name) => {
        return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole;
    });
}

/** 递归展开对象/数组里的字符串模板 */
export function expandDeep(value, scope = {}, vars = {}) {
    if (typeof value === 'string') return expandBraces(expandDollar(value, scope), vars);
    if (Array.isArray(value)) return value.map((item) => expandDeep(item, scope, vars));
    if (isPlainObject(value)) {
        const out = {};
        for (const [key, item] of Object.entries(value)) out[expandBraces(expandDollar(key, scope), vars)] = expandDeep(item, scope, vars);
        return out;
    }
    return value;
}

/** 沿目录向上查找配置文件，返回绝对路径或 '' */
export function findUp(startDir, fileNames, maxDepth = 8) {
    let dir = path.resolve(startDir || '.');
    for (let depth = 0; depth <= maxDepth; depth += 1) {
        for (const name of fileNames) {
            const candidate = path.join(dir, name);
            try {
                if (fs.statSync(candidate).isFile()) return candidate;
            } catch {
                // 不存在，继续
            }
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return '';
}

/** 统一项目标识：盘符小写、正斜杠、去掉末尾斜杠 */
export function normalizeProjectKey(cwd) {
    if (!cwd || typeof cwd !== 'string') return '';
    let key = path.resolve(cwd).replace(/\\/g, '/');
    if (/^[A-Za-z]:/.test(key)) key = key[0].toLowerCase() + key.slice(1);
    return key.replace(/\/+$/, '');
}

/** 敏感请求头脱敏（只用于展示/返回给模型前的日志副本） */
export function redactHeaders(headers) {
    // 兼顾写法差异：标准头（authorization/cookie）、自定义头（X-Token、X-Api-Key）、
    // 以及名字里带 token/secret/password/key 的任意头，一律按敏感处理。
    const exact = /^(authorization|cookie|set-cookie|proxy-authorization)$/i;
    const fuzzy = /(^|[-_])(token|secret|password|passwd|pwd|key|auth|credential|signature)([-_]|$)/i;
    const out = {};
    for (const [key, value] of Object.entries(headers || {})) {
        out[key] = exact.test(key) || fuzzy.test(key) ? maskSecret(String(value)) : value;
    }
    return out;
}

export function maskSecret(text) {
    if (text.length <= 8) return '***';
    return `${text.slice(0, 4)}***${text.slice(-4)}`;
}

/** 尝试 JSON.parse，失败返回 undefined */
export function tryJson(text) {
    if (typeof text !== 'string' || text.trim() === '') return undefined;
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** 进程是否存活（EPERM 视为存活：存在但无权限） */
export function isPidAlive(pid) {
    const num = Number(pid);
    if (!Number.isInteger(num) || num <= 0) return false;
    try {
        process.kill(num, 0);
        return true;
    } catch (error) {
        return error?.code === 'EPERM';
    }
}

/** 相对路径按 baseDir 展开；绝对路径原样 */
export function resolveFrom(baseDir, target) {
    if (!target) return '';
    return path.isAbsolute(target) ? path.normalize(target) : path.resolve(baseDir, target);
}

/**
 * 读取状态文件里的某个命名空间。
 * 日志游标与服务 pid 共用同一个状态文件，所以必须按命名空间分开读写，
 * 否则一个组件写盘时会把另一个组件的记录整体抹掉。
 */
export function readStateNamespace(statePath, key) {
    if (!statePath) return {};
    try {
        const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        if (isPlainObject(parsed) && isPlainObject(parsed[key])) return parsed[key];
    } catch {
        // 首次运行或文件损坏，视为空
    }
    return {};
}

/** 只更新状态文件里的某个命名空间，保留其它命名空间（原子替换） */
export function writeStateNamespace(statePath, key, value) {
    if (!statePath) return;
    let doc = {};
    try {
        const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        if (isPlainObject(parsed)) doc = parsed;
    } catch {
        // 首次运行或文件损坏，从空文档开始
    }
    doc.version = 1;
    doc[key] = value;
    try {
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        const tmp = `${statePath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
        fs.renameSync(tmp, statePath);
    } catch {
        // 状态写失败不影响本次操作
    }
}

/** 对象深合并：后者覆盖前者，数组整体替换 */
export function deepMerge(base, patch) {
    if (!isPlainObject(base) || !isPlainObject(patch)) return patch === undefined ? base : patch;
    const out = { ...base };
    for (const [key, value] of Object.entries(patch)) {
        out[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value;
    }
    return out;
}
