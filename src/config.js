/**
 * 配置加载：默认路径 ${DSH_HOME}/api-runner.yml，也支持插件 Config 指定路径。
 *
 * 解析顺序（后者覆盖前者）：
 *   1. 内置默认值
 *   2. 全局配置 `${DSH_HOME}/api-runner.yml`（不存在则跳过）
 *   3. 项目配置 `<project>/.dsh/api-runner.yml`（存在则覆盖，便于按仓库差异）
 * 每次读取都重新解析（带 mtime 缓存），改配置不需要重启 DSH。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { deepMerge, expandDeep, expandDollar, isPlainObject, resolveFrom } from './util.js';

export const DEFAULT_CONFIG = {
    /** 配置级默认请求设置，接口可单独覆盖 */
    defaults: {
        timeoutMs: 30_000,
        headers: {},
        /** 只对这些 header 保留，不填则全保留 */
        keepHeaders: [],
    },
    /** 命名环境变量组：接口 url/headers 里可用 ${NAME} 引用 */
    env: {},
    /** 接口清单 */
    apis: [],
    /** 服务清单 */
    services: [],
    /** 日志清单 */
    logs: [],
};

/** 候选文件名（按优先级） */
const CONFIG_FILES = ['api-runner.yml', 'api-runner.yaml', 'dsh-api-runner.yml'];

export class ConfigStore {
    constructor(options = {}) {
        this.homeDir = options.homeDir || process.env.DSH_HOME || path.join(process.cwd(), '.dsh');
        this.explicitPath = options.configPath || '';
        this._cache = new Map();
    }

    /** 全局配置路径 */
    globalPath() {
        if (this.explicitPath) return resolveFrom(this.homeDir, this.explicitPath);
        for (const name of CONFIG_FILES) {
            const candidate = path.join(this.homeDir, name);
            if (this._isFile(candidate)) return candidate;
        }
        return path.join(this.homeDir, CONFIG_FILES[0]);
    }

    /** 项目级配置路径（存在才返回） */
    projectPath(cwd) {
        if (!cwd) return '';
        for (const name of CONFIG_FILES) {
            const candidate = path.join(cwd, '.dsh', name);
            if (this._isFile(candidate)) return candidate;
        }
        return '';
    }

    /**
     * 读取生效配置。返回 { config, sources, warnings }
     * cwd 用于定位项目级配置与相对路径解析基准。
     * extra 是最后一个覆盖层（侧边栏面板里维护的配置），优先级最高。
     */
    load(cwd = '', extra = undefined) {
        const warnings = [];
        const sources = [];
        let config = structuredClone(DEFAULT_CONFIG);

        for (const file of [this.globalPath(), this.projectPath(cwd)].filter(Boolean)) {
            if (!this._isFile(file)) continue;
            const parsed = this._readYaml(file, warnings);
            if (parsed && isPlainObject(parsed)) {
                config = deepMerge(config, parsed);
                sources.push(file);
            }
        }

        if (isPlainObject(extra)) {
            // 面板配置里的 apis 要按 id 与 YAML 合并（同 id 面板覆盖），
            // 不能像 deepMerge 那样整体替换数组——否则面板一存，YAML 里的接口全消失。
            const { apis: extraApis, ...rest } = extra;
            config = deepMerge(config, rest);
            if (Array.isArray(extraApis) && extraApis.length > 0) {
                const byId = new Map();
                for (const item of Array.isArray(config.apis) ? config.apis : []) {
                    if (isPlainObject(item)) byId.set(String(item.id || item.name || ''), item);
                }
                for (const item of extraApis) {
                    if (isPlainObject(item)) byId.set(String(item.id || item.name || ''), item);
                }
                config.apis = [...byId.values()];
            }
            sources.push('(面板配置)');
        }

        const baseDir = cwd || path.dirname(sources[sources.length - 1] || this.globalPath());
        return {
            config: this._normalize(config, baseDir, warnings),
            sources,
            baseDir,
            warnings,
        };
    }

    _readYaml(file, warnings) {
        let stat;
        try {
            stat = fs.statSync(file);
        } catch {
            return undefined;
        }
        const cached = this._cache.get(file);
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.value;
        try {
            const text = fs.readFileSync(file, 'utf8');
            const value = parseYaml(text);
            this._cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
            return value;
        } catch (error) {
            warnings.push(`解析配置失败 ${file}: ${error.message}`);
            this._cache.delete(file);
            return undefined;
        }
    }

    _isFile(file) {
        try {
            return fs.statSync(file).isFile();
        } catch {
            return false;
        }
    }

    /** 规整为运行期结构：补 id、解析相对日志路径、展开环境引用 */
    _normalize(config, baseDir, warnings) {
        const scope = { ...(isPlainObject(config.env) ? config.env : {}), ...process.env };
        const defaults = isPlainObject(config.defaults) ? config.defaults : {};

        const apis = (Array.isArray(config.apis) ? config.apis : [])
            .filter((item) => isPlainObject(item))
            .map((item, index) => {
                const id = String(item.id || item.name || `api-${index + 1}`).trim();
                const headers = expandDeep(deepMerge(isPlainObject(defaults.headers) ? defaults.headers : {}, item.headers), scope);
                return {
                    id,
                    name: String(item.name || id),
                    description: String(item.description || ''),
                    method: String(item.method || 'GET').toUpperCase(),
                    url: String(expandDollar(item.url || '', scope)),
                    headers: isPlainObject(headers) ? headers : {},
                    query: isPlainObject(item.query) ? item.query : {},
                    body: item.body,
                    timeoutMs: Number(item.timeoutMs || defaults.timeoutMs || 30_000),
                    /** baseUrl 前缀，可选 */
                    baseUrl: String(expandDollar(item.baseUrl || '', scope)),
                    /** 登录接口声明：调用成功后从响应里取 token 并保存 */
                    login: isPlainObject(item.login)
                        ? {
                              /** 响应 JSON 里的取值路径，如 data.token */
                              tokenPath: String(item.login.tokenPath || 'token'),
                              /** token 保存后自动注入的请求头 */
                              header: String(item.login.header || 'Authorization'),
                              /** 头值前缀，如 "Bearer "；不需要前缀就写空串 */
                              prefix: String(item.login.prefix ?? 'Bearer '),
                              /** 保存后不再注入（纯展示用）；一般不需要 */
                              disabled: item.login.disabled === true,
                          }
                        : undefined,
                    /** 调用本接口时注入哪个登录接口保存的 token（id）；留空则自动匹配唯一可用 token */
                    useToken: String(item.useToken || ''),
                    /** 面板专用的原文/示例字段，YAML 里写了也保留，方便面板回显 */
                    headersText: typeof item.headersText === 'string' ? item.headersText : undefined,
                    bodyText: typeof item.bodyText === 'string' ? item.bodyText : undefined,
                    sampleText: typeof item.sampleText === 'string' ? item.sampleText : undefined,
                    /** 示例参数：call/面板测试未提供参数时用作默认值 */
                    sampleParams: isPlainObject(item.sampleParams) ? item.sampleParams : undefined,
                    /** 来自面板还是 YAML 文件 */
                    source: item.source === 'ui' ? 'ui' : undefined,
                };
            });

        const services = (Array.isArray(config.services) ? config.services : [])
            .filter((item) => isPlainObject(item))
            .map((item, index) => {
                const id = String(item.id || item.name || `service-${index + 1}`).trim();
                const mode = String(item.mode || 'observe').toLowerCase();
                const health = isPlainObject(item.health) ? item.health : {};
                return {
                    id,
                    name: String(item.name || id),
                    mode: mode === 'managed' ? 'managed' : 'observe',
                    cwd: resolveFrom(baseDir, String(item.cwd || '')),
                    command: String(item.command || ''),
                    args: (Array.isArray(item.args) ? item.args : []).map(String),
                    env: isPlainObject(item.env) ? item.env : {},
                    /** managed：启动后等待健康检查通过的最长时间 */
                    startupTimeoutMs: Number(item.startupTimeoutMs || 60_000),
                    /** managed：重启前等待旧进程退出的时间 */
                    stopTimeoutMs: Number(item.stopTimeoutMs || 10_000),
                    /** 停止时优先整棵进程树 */
                    killTree: item.killTree !== false,
                    /** managed：子进程 stdout/stderr 追加写入的文件（可选） */
                    logPath: resolveFrom(baseDir, String(expandDollar(item.logPath || '', scope))),
                    health: {
                        url: String(expandDollar(health.url || '', scope)),
                        method: String(health.method || 'GET').toUpperCase(),
                        expectStatus: Number(health.expectStatus || 0),
                        timeoutMs: Number(health.timeoutMs || 3_000),
                        intervalMs: Number(health.intervalMs || 1_000),
                        /** observe 模式额外探测的 TCP 端口 */
                        ports: (Array.isArray(health.ports) ? health.ports : []).map(Number).filter(Boolean),
                        host: String(health.host || '127.0.0.1'),
                    },
                };
            });

        const logs = (Array.isArray(config.logs) ? config.logs : [])
            .filter((item) => isPlainObject(item))
            .map((item, index) => {
                const id = String(item.id || item.name || `log-${index + 1}`).trim();
                return {
                    id,
                    name: String(item.name || id),
                    path: resolveFrom(baseDir, String(expandDollar(item.path || '', scope))),
                    /** 本插件维护的读取游标文件（可选） */
                    encoding: String(item.encoding || 'utf8'),
                    description: String(item.description || ''),
                };
            });

        const seen = new Set();
        for (const item of [...apis, ...services, ...logs]) {
            if (seen.has(item.id)) warnings.push(`配置 id 重复：${item.id}（后出现的会覆盖前者）`);
            seen.add(item.id);
        }

        return {
            defaults,
            env: isPlainObject(config.env) ? config.env : {},
            apis,
            services,
            logs,
        };
    }

    /** 按 id 找接口（支持 name 别名） */
    findApi(config, id) {
        const key = String(id || '').trim();
        return config.apis.find((item) => item.id === key || item.name === key);
    }

    findService(config, id) {
        const key = String(id || '').trim();
        return config.services.find((item) => item.id === key || item.name === key);
    }

    findLog(config, id) {
        const key = String(id || '').trim();
        return config.logs.find((item) => item.id === key || item.name === key);
    }
}
