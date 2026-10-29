/**
 * 业务编排层：工具与 HTTP API 共用同一套操作实现。
 * 所有函数返回可直接 JSON 化的普通对象，错误以 {ok:false,...} 形式返回而非抛出。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ConfigStore } from './config.js';
import { callApi, pickPath } from './api.js';
import { DbManager } from './db.js';
import { JavaRunner } from './java-runner.js';
import { discoverLogs, listJavaProcesses, readFileChunk, readFileTail } from './java.js';
import { LogReader } from './log.js';
import { javaKeyOf } from './project-store.js';
import { ServiceManager } from './service.js';
import { expandDeep, isPlainObject, maskSecret, normalizeProjectKey, redactHeaders, truncateText, tryJson } from './util.js';

export class ApiRunnerService {
    /**
     * @param {{homeDir:string, configPath?:string, projectStore?:import('./project-store.js').ProjectStore}} options
     */
    constructor(options = {}) {
        this.homeDir = options.homeDir;
        this.statePath = path.join(this.homeDir, 'api-runner-state.json');
        this.configStore = new ConfigStore({ homeDir: this.homeDir, configPath: options.configPath });
        this.logReader = new LogReader({ statePath: this.statePath });
        this.serviceManager = new ServiceManager({ statePath: this.statePath });
        /** 侧边栏面板维护的配置（存在时作为最高优先覆盖层） */
        this.projectStore = options.projectStore;
        /** 由插件接管的 Java 服务（IDEA 起的进程关闭后由这里重新拉起并记账） */
        this.settingsStore = options.settingsStore;
        this.javaRunner = options.javaRunner || new JavaRunner({ homeDir: this.homeDir, settingsStore: this.settingsStore });
        /** 记录最近一次错误，便于排查 */
        this.lastError = '';
        /**
         * 一键启动的后台批次：`{ [batchId]: { id, cwd, startedAt, done, total, items, finished, result } }`。
         *
         * 为什么放后台跑：一批服务要逐个 mvn 编译，几个服务就是几分钟，
         * 同步 HTTP 请求会一直挂着（浏览器和 fetch 都可能超时），面板也没法显示进度。
         * 批次只存内存：DSH 重启后丢批次记录没关系，进程本身已经起来了。
         */
        this.startBatches = new Map();
        this._batchSeq = 0;
        /**
         * 数据库连接管理。数据库能力从原 dsh-db-tool 合并进来，
         * 但**不依赖任何 DSH 服务**（原插件把 betterSidebar 当硬依赖，
         * 服务没就绪就一直 pending，拖垮整个 web 启动）。
         */
        this.dbManager = options.dbManager || new DbManager({ homeDir: this.homeDir, settingsStore: this.settingsStore });
    }

    /** 面板配置转成 YAML 同构的覆盖层；没有面板存储时返回 undefined */
    uiOverlay(cwd) {
        if (!this.projectStore) return undefined;
        const project = this.projectStore.project(cwd);
        if (project.apis.length === 0) return undefined;
        // 面板里没填 baseUrl 的接口，统一回落到项目级 baseUrl（面板顶部那一个输入框）
        const apis = project.apis.map((api) => ({
            ...api,
            baseUrl: api.baseUrl || project.baseUrl || '',
            source: 'ui',
        }));
        return { apis };
    }

    /** 读取配置（每次重读，支持热改） */
    config(cwd = '') {
        return this.configStore.load(cwd, this.uiOverlay(cwd));
    }

    /** 配置概览：只给模型必要信息，不泄漏 headers 具体值 */
    describe(cwd = '') {
        const { config, sources, warnings } = this.config(cwd);
        const tokens = this.projectStore ? this.projectStore.tokenStatus(cwd) : {};
        return {
            ok: true,
            sources,
            warnings,
            apis: config.apis.map((api) => {
                const tokenId = api.login ? '' : api.useToken || (Object.keys(tokens).length === 1 ? Object.keys(tokens)[0] : '');
                return {
                    id: api.id,
                    name: api.name,
                    method: api.method,
                    url: displayUrl(api),
                    description: api.description,
                    isLogin: Boolean(api.login),
                    /** 调用时会自动带的 token 来源；空表示不带 */
                    tokenFrom: tokenId,
                    params: collectParams(api),
                };
            }),
            tokens,
            services: config.services.map((service) => ({
                id: service.id,
                name: service.name,
                mode: service.mode,
                cwd: service.cwd,
                command: [service.command, ...service.args].filter(Boolean).join(' '),
                health: service.health.url || (service.health.ports.length > 0 ? `tcp:${service.health.ports.join(',')}` : ''),
            })),
            logs: config.logs.map((log) => ({
                id: log.id,
                name: log.name,
                path: log.path,
                exists: fileExists(log.path),
                size: fileSize(log.path),
            })),
            /**
             * 数据库连接也放进 describe：模型据此知道「有哪些库可查」。
             *
             * **只列当前项目已授权的连接**——未授权的连接模型不该看见，
             * 否则它会反复尝试然后被拒，浪费轮次还误导用户。
             * 只给 id / 名称 / 类型 / 目标 / 权限等级，不给账号密码。
             */
            databases: this.dbManager
                ? (() => {
                    const access = this.dbManager.accessOf('default');
                    return this.dbManager.listConnections()
                        .map((item) => {
                            const level = access[item.id] || 'none';
                            return {
                                id: item.id,
                                name: item.name,
                                type: item.type,
                                target: item.urlMode
                                    ? item.connectString
                                    : (item.type === 'sqlite' ? (item.file || ':memory:') : `${item.host}:${item.port}/${item.database}`),
                                username: item.username || '',
                                level,
                            };
                        })
                        .filter((item) => item.level !== 'none');
                })()
                : [],
        };
    }

    /** 调用接口 */
    async call(cwd, apiId, params = {}, options = {}) {
        const { config } = this.config(cwd);
        const api = this.configStore.findApi(config, apiId);
        if (!api) {
            return { ok: false, code: 'API_NOT_FOUND', message: `未找到接口 ${apiId}；已配置：${config.apis.map((item) => item.id).join(', ') || '（空）'}` };
        }
        const resolved = this.resolveApi(cwd, api, options);
        // 模型没传参数时，用接口上配置的示例参数兜底（面板里填的那份）
        const merged = { ...(api.sampleParams || {}), ...(isPlainObject(params) ? params : {}) };
        const result = await callApi(resolved.api, merged, options);
        return {
            ...result,
            request: {
                method: resolved.api.method,
                url: result.url,
                headers: redactHeaders(resolved.api.headers),
            },
            token: resolved.token
                ? { from: resolved.token.loginId, header: resolved.token.header, masked: maskSecret(resolved.token.value) }
                : undefined,
        };
    }

    /**
     * 解析「这次调用要不要带 token」：
     *  1. options.tokenFrom 显式指定；
     *  2. 接口自己声明 useToken；
     *  3. 项目里只有一个已保存 token 时自动带上（登录一次，后续接口不用配）；
     * 命中后把 token 值注入到 Authorization（或登录定义里指定的头）。
     */
    resolveApi(cwd, api, options = {}) {
        const store = this.projectStore;
        if (!store) return { api, token: undefined };
        const { config } = this.config(cwd);

        let loginId = String(options.tokenFrom || api.useToken || '');
        if (!loginId) {
            const saved = store.tokenIds(cwd);
            // 只有一个 token 时自动使用；有多个则要求接口显式声明，避免串号
            if (saved.length === 1) loginId = saved[0];
        }
        if (!loginId) return { api, token: undefined };

        const value = store.tokenValue(cwd, loginId);
        if (!value) return { api, token: undefined };

        // 登录定义优先取 logins 里的，其次取同 id 的接口上声明的 login
        const loginDef = config.logins?.find?.((item) => item.id === loginId) ?? config.apis.find((item) => item.id === loginId)?.login;
        const header = String(options.tokenHeader || loginDef?.header || 'Authorization');
        const prefix = String(options.tokenPrefix ?? loginDef?.prefix ?? 'Bearer ');
        const headers = { ...(api.headers || {}) };
        // 已有同名头（大小写不敏感）时不覆盖用户手写的值
        const existing = Object.keys(headers).find((key) => key.toLowerCase() === header.toLowerCase());
        if (existing === undefined) headers[header] = `${prefix}${value}`;

        return { api: { ...api, headers }, token: { loginId, header, value } };
    }

    /**
     * 登录：调接口 → 从响应里取 token → 保存。
     * 这是「调用登录接口直接保存 token」的实现，工具和面板都走这里。
     */
    async login(cwd, loginId, params = {}, options = {}) {
        const { config } = this.config(cwd);
        const api = this.configStore.findApi(config, loginId);
        if (!api) return { ok: false, code: 'API_NOT_FOUND', message: `未找到登录接口 ${loginId}` };
        const login = api.login || { tokenPath: 'token', header: 'Authorization', prefix: 'Bearer ' };

        // 登录请求本身不能带旧 token，避免死循环/串号
        const merged = { ...(api.sampleParams || {}), ...(isPlainObject(params) ? params : {}) };
        const result = await callApi(api, merged, options);
        if (!result.ok) {
            return {
                ok: false,
                code: 'LOGIN_FAILED',
                message: result.error || `登录接口返回 HTTP ${result.status}`,
                status: result.status,
                body: result.body,
            };
        }
        const found = pickPath(result.json, login.tokenPath);
        let token = typeof found === 'string' ? found : found === undefined || found === null ? '' : String(found);
        let usedPath = login.tokenPath;
        let autoDetected = false;
        if (token === '') {
            // tokenPath 没命中时，若响应里只有一个像 token 的字段，就自动用它。
            // 这能把「配置了登录接口但不知道 token 在响应哪一层」的常见情况直接救活；
            // 有多个候选则不猜，列给用户/模型自己选。
            const candidates = tokenCandidates(result.json);
            if (candidates.length === 1) {
                const auto = pickPath(result.json, candidates[0]);
                if (typeof auto === 'string' && auto !== '') {
                    token = auto;
                    usedPath = candidates[0];
                    autoDetected = true;
                }
            }
            if (token === '') {
                return {
                    ok: false,
                    code: 'TOKEN_NOT_FOUND',
                    message: candidates.length
                        ? `登录成功（HTTP ${result.status}）但响应里没有 ${login.tokenPath}，且有多个候选：${candidates.join(', ')}；请把 login.tokenPath 改成其中一个`
                        : `登录成功（HTTP ${result.status}）但响应里没有 ${login.tokenPath}；检查 login.tokenPath 配置`,
                    tokenPath: login.tokenPath,
                    candidates,
                    body: result.body,
                };
            }
        }
        if (!this.projectStore) return { ok: false, code: 'NO_STORE', message: '面板配置存储不可用' };
        // 自动探测到正确路径时写回接口定义，避免每次登录都重复警告；
        // 只对面板创建的接口生效（YAML 接口在文件里，插件不改用户的配置文件）。
        if (autoDetected) {
            const project = this.projectStore.project(cwd);
            if (project.apis.some((item) => String(item.id) === String(api.id))) {
                this.projectStore.setApiTokenPath(cwd, api.id, usedPath);
            }
        }
        // 把登录定义一起存下来，后续调用才知道该用哪个头
        this.projectStore.saveLogin(cwd, {
            id: api.id,
            name: api.name,
            apiId: api.id,
            tokenPath: usedPath,
            header: login.header,
            prefix: login.prefix,
        });
        this.projectStore.saveToken(cwd, api.id, token);
        return {
            ok: true,
            loginId: api.id,
            status: result.status,
            masked: maskSecret(token),
            tokenPath: usedPath,
            header: login.header,
            message: autoDetected
                ? `已保存 token（${login.header}: ${login.prefix}${maskSecret(token)}）。注意：配置的 tokenPath 是 ${login.tokenPath} 但没取到值，已自动改用响应里的 ${usedPath} 并写回配置`
                : `已保存 token（${login.header}: ${login.prefix}${maskSecret(token)}），后续调用会自动带上`,
        };
    }

    /** 服务状态（单个或全部） */
    async serviceStatus(cwd, serviceId) {
        const { config } = this.config(cwd);
        if (serviceId) {
            const service = this.configStore.findService(config, serviceId);
            if (!service) return { ok: false, code: 'SERVICE_NOT_FOUND', message: `未找到服务 ${serviceId}` };
            const health = await this.serviceManager.check(service);
            return { ok: true, service: service.id, mode: service.mode, healthy: health.ok, checks: health.checks };
        }
        const list = await this.serviceManager.statusAll(config.services);
        return { ok: true, services: list };
    }

    async serviceAction(cwd, serviceId, action, options = {}) {
        const { config } = this.config(cwd);
        const service = this.configStore.findService(config, serviceId);
        if (!service) return { ok: false, code: 'SERVICE_NOT_FOUND', message: `未找到服务 ${serviceId}` };
        switch (action) {
            case 'start':
                return { ok: true, service: service.id, ...(await this.serviceManager.start(service, options)) };
            case 'stop':
                return { ok: true, service: service.id, ...(await this.serviceManager.stop(service)) };
            case 'restart':
                return { ok: true, service: service.id, ...(await this.serviceManager.restart(service, options)) };
            case 'wait': {
                const health = await this.serviceManager.waitHealthy(service, Number(options.timeoutMs || service.startupTimeoutMs));
                return { ok: health.ok, service: service.id, waitedMs: health.waitedMs, checks: health.checks };
            }
            default:
                return { ok: false, code: 'BAD_ACTION', message: `不支持的服务动作 ${action}` };
        }
    }

    /** 读日志 */
    readLog(cwd, logId, options = {}) {
        const { config } = this.config(cwd);
        const log = logId
            ? this.configStore.findLog(config, logId)
            : config.logs[0];
        if (!log) {
            return { ok: false, code: 'LOG_NOT_FOUND', message: logId ? `未找到日志 ${logId}` : '未配置任何日志，请在 api-runner.yml 的 logs 里添加' };
        }
        try {
            return this.logReader.read(log, options);
        } catch (error) {
            return { ok: false, code: 'LOG_READ_FAILED', message: error.message };
        }
    }

    async waitLog(cwd, logId, options = {}) {
        const { config } = this.config(cwd);
        const log = logId ? this.configStore.findLog(config, logId) : config.logs[0];
        if (!log) return { ok: false, code: 'LOG_NOT_FOUND', message: `未找到日志 ${logId || '(默认)'}` };
        try {
            return await this.logReader.waitFor(log, options);
        } catch (error) {
            return { ok: false, code: 'LOG_READ_FAILED', message: error.message };
        }
    }

    resetLog(cwd, logId) {
        const { config } = this.config(cwd);
        const log = logId ? this.configStore.findLog(config, logId) : config.logs[0];
        if (!log) return { ok: false, code: 'LOG_NOT_FOUND', message: `未找到日志 ${logId || '(默认)'}` };
        this.logReader.resetCursor(log.id);
        this.logReader.save();
        return { ok: true, logId: log.id, message: '游标已重置，下次读取从文件末尾开始' };
    }

    /**
     * 一键验证流程：重启服务 → 等启动日志 → 调用接口 → 读错误日志。
     * 让模型一条命令完成"改完自测"，无需手工串多个步骤。
     */
    async verify(cwd, options = {}) {
        const { config } = this.config(cwd);
        const steps = [];
        const service = options.service ? this.configStore.findService(config, options.service) : config.services[0];

        if (service) {
            if (options.restart !== false) {
                const restart = await this.serviceManager.restart(service, { timeoutMs: options.startupTimeoutMs });
                // 注意：restart 结果里自带 stage，必须先展开再覆盖，否则 stage 会变成 'done'
                steps.push({ ...restart, stage: 'restart', service: service.id });
                if (!restart.ok && restart.reason === 'OBSERVE_MODE') {
                    // observe 模式：进程归 IDE 管，这里只能等它自己就绪，不算失败
                    const health = await this.serviceManager.waitHealthy(service, Number(options.startupTimeoutMs || service.startupTimeoutMs));
                    steps.push({ stage: 'wait', ok: health.ok, waitedMs: health.waitedMs, checks: health.checks, note: '服务为 observe 模式，未自动重启；等待健康检查通过（如未通过请在 IDEA 里重启）' });
                } else if (!restart.ok) {
                    return { ok: false, code: 'RESTART_FAILED', message: restart.message, steps };
                }
            } else {
                steps.push({ stage: 'restart', skipped: true });
            }
        }

        if (options.logId) {
            const logOptions = {
                pattern: options.pattern || '',
                ignoreCase: Boolean(options.ignoreCase),
                maxLines: options.maxLines || 200,
            };
            // 有 pattern 时等它出现（重启后日志可能还没刷盘），否则直接增量读一次
            const read = options.pattern
                ? await this.waitLog(cwd, options.logId, { ...logOptions, timeoutMs: options.logWaitMs || 10_000 })
                : this.readLog(cwd, options.logId, logOptions);
            steps.push({ ...read, stage: 'log' });
        }

        if (options.apiId) {
            const call = await this.call(cwd, options.apiId, options.params || {}, {});
            steps.push({ stage: 'call', ...call });
        }

        // 顶层 ok 取所有步骤的综合结论：任一实质性步骤失败即失败。
        // observe 模式的 restart 失败是「预期内不支持」（进程由 IDE 管），不算失败。
        const failed = steps.filter((step) => step.ok === false && step.reason !== 'OBSERVE_MODE');
        if (failed.length > 0) {
            const first = failed[0];
            return { ok: false, code: `STEP_FAILED:${first.stage}`, message: describeFailure(first), steps };
        }
        return { ok: true, steps };
    }

    // ---- 侧边栏面板用：配置读写 ----
    /**
     * 面板初始数据：YAML 配置 + 面板配置 + token 状态 + 项目 key
     *
     * options.project 是「接口」页二级页签里选中的项目（ProjectStore 的 key）。
     * 给了它就整个切到那个项目：接口、token、baseUrl 都取自它，保存/调用也写它。
     * 不给就是会话当前工作区。
     */
    async uiState(cwd = '', options = {}) {
        const selected = options && typeof options.project === 'string' ? options.project : '';
        const target = selected || cwd;
        // 会话工作区单独传（切了项目之后 cwd 已经是目标项目，不能再用它推「当前工作区」）
        const sessionCwd = options && typeof options.sessionCwd === 'string' ? options.sessionCwd : cwd;
        const { config, sources, warnings } = this.config(target);
        const project = this.projectStore ? this.projectStore.project(target) : { key: 'default', apis: [], logins: [], tokens: {}, bindings: [] };
        const rawById = new Map(project.apis.map((item) => [String(item.id), item]));
        return {
            ok: true,
            projectKey: project.key,
            /** 会话工作区自己的 key：面板用它把那一档标成「当前工作区」，而不是靠猜 */
            cwdProjectKey: this.projectStore ? this.projectStore.keyOf(sessionCwd) : 'default',
            sources,
            warnings,
            baseUrl: project.baseUrl || '',
            apis: config.apis.map((api) => {
                const raw = rawById.get(api.id);
                const tokenId = api.login ? '' : api.useToken || (Object.keys(project.tokens).length === 1 ? Object.keys(project.tokens)[0] : '');
                return {
                    id: api.id,
                    name: api.name,
                    method: api.method,
                    url: displayUrl(api),
                    baseUrl: raw?.baseUrl || project.baseUrl || api.baseUrl || '',
                    description: api.description,
                    isLogin: Boolean(api.login),
                    tokenPath: api.login?.tokenPath || '',
                    header: api.login?.header || '',
                    prefix: api.login?.prefix ?? '',
                    useToken: api.useToken || '',
                    /** 面板表单字段：面板自己存的原文优先，YAML 接口则从规整后的值反推 */
                    headersText: raw?.headersText ?? (Object.keys(api.headers || {}).length > 0 ? JSON.stringify(api.headers, null, 2) : ''),
                    bodyText: raw?.bodyText ?? (api.body === undefined ? '' : JSON.stringify(api.body, null, 2)),
                    /**
                     * 示例参数：面板存的是 sampleParams（解析后的对象），没有 sampleText 原文。
                     * 所以取不到原文时必须从 sampleParams 反推，否则面板保存过一次后
                     * 再点「编辑」，这个输入框永远是空的（用户填的内容看起来被吞了）。
                     */
                    sampleText: raw?.sampleText ?? (isPlainObject(api.sampleParams) && Object.keys(api.sampleParams).length > 0
                        ? JSON.stringify(api.sampleParams, null, 2)
                        : ''),
                    /** query 原文：面板要能回显，否则保存时会把它丢掉（见 saveApi 的整体替换） */
                    queryText: raw?.queryText ?? (isPlainObject(api.query) && Object.keys(api.query).length > 0
                        ? JSON.stringify(api.query, null, 2)
                        : ''),
                    params: collectParams(api),
                    /** 来自面板还是 YAML，面板里只允许删自己创建的 */
                    source: raw ? 'ui' : 'file',
                    tokenFrom: tokenId,
                    timeoutMs: api.timeoutMs,
                };
            }),
            logins: project.logins,
            tokens: this.projectStore ? this.projectStore.tokenStatus(target) : {},
            bindings: project.bindings,
            /** 「接口」页按项目分类的页签清单（含当前工作区，见 projectList） */
            projects: this.projectList(project.key, sessionCwd),
        };
    }

    /**
     * 已知项目清单，供「接口」页的项目页签用。
     *
     * 来源三处：会话当前工作区、设置里的默认工作区、面板配过东西的项目桶。
     * 一个项目即使还没配接口也要出现——用户得先能切过去，才能在那儿新增接口；
     * 只有「配过接口的项目」够不成可选项，这正是之前页签整排不显示的原因。
     */
    projectList(currentKey, cwd) {
        const store = this.projectStore;
        if (!store) return [];
        const items = new Map();
        const add = (dir, origin) => {
            if (!dir) return;
            let project;
            try {
                project = store.project(dir);
            } catch {
                return;
            }
            const existing = items.get(project.key);
            const origins = existing ? existing.origins.slice() : [];
            if (!origins.includes(origin)) origins.push(origin);
            items.set(project.key, {
                key: project.key,
                updatedAt: project.updatedAt,
                baseUrl: project.baseUrl,
                apiCount: project.apis.length,
                savedCount: project.saved.length,
                origins,
            });
        };
        add(cwd, 'cwd');
        let workspace = '';
        try {
            const current = this.settingsStore && typeof this.settingsStore.read === 'function' ? this.settingsStore.read() : null;
            workspace = current && current.workspace ? String(current.workspace) : '';
        } catch {
            workspace = '';
        }
        add(workspace, 'settings');
        for (const item of store.allProjects()) {
            if (items.has(item.key)) continue;
            items.set(item.key, {
                key: item.key,
                updatedAt: item.updatedAt,
                baseUrl: item.baseUrl,
                apiCount: item.apis.length,
                savedCount: Array.isArray(item.saved) ? item.saved.length : 0,
                origins: ['store'],
            });
        }
        // 会话工作区永远排第一（页签顺序不能随着点击而跳），其余按最近改过的时间倒序
        const cwdKey = store.keyOf(cwd);
        return [...items.values()].sort((a, b) => {
            if (a.key === cwdKey) return -1;
            if (b.key === cwdKey) return 1;
            return String(b.updatedAt).localeCompare(String(a.updatedAt));
        });
    }

    saveApiUi(cwd, api) {
        if (!this.projectStore) return { ok: false, code: 'NO_STORE', message: '面板配置存储不可用' };
        try {
            this.projectStore.saveApi(cwd, api);
            return { ok: true, message: `已保存接口 ${api.id}` };
        } catch (error) {
            return { ok: false, code: 'SAVE_FAILED', message: error.message };
        }
    }

    deleteApiUi(cwd, id) {
        if (!this.projectStore) return { ok: false, code: 'NO_STORE', message: '面板配置存储不可用' };
        const project = this.projectStore.project(cwd);
        if (!project.apis.some((item) => String(item.id) === String(id))) {
            return { ok: false, code: 'NOT_FROM_UI', message: `${id} 不是面板创建的接口；请直接改 YAML 配置` };
        }
        this.projectStore.deleteApi(cwd, id);
        return { ok: true, message: `已删除接口 ${id}` };
    }

    clearTokenUi(cwd, loginId) {
        if (!this.projectStore) return { ok: false, code: 'NO_STORE', message: '面板配置存储不可用' };
        this.projectStore.clearToken(cwd, loginId);
        return { ok: true, message: `已清除 ${loginId} 的 token` };
    }

    // ---- 本机 Java 服务 ----
    /**
     * 列表要同时给出两类进程，并让面板一眼看出区别：
     *   owner='idea'    —— IDEA 起的（插件只能「接管」，不能直接重启）
     *   owner='plugin'  —— 插件接管的（可以直接停 / 重启 / 看日志）
     * 同名的两边都出现时，以插件那份为准（IDEA 的进程已经被杀掉了，jps 里自然也就没了）。
     */
    async javaProcesses(cwd = '') {
        const result = await listJavaProcesses();
        const runs = this.javaRunner ? this.javaRunner.runs(cwd) : [];
        if (!result.ok) {
            /**
             * 没有 jps（没装 JDK）时也必须给全字段。
             *
             * 面板会直接读 saved / ignored / maven 并 .map 它们；早期这里只返回
             * processes，前端拿 undefined 就崩（「已保存」页签整个白掉）。
             * 而且用户没 JDK 时更需要看到「已保存的配方」和「怎么装 JDK」。
             */
            const missingProject = this.projectStore ? this.projectStore.project(cwd) : { bindings: [], ignored: [], saved: [] };
            return {
                ok: false,
                code: 'JPS_MISSING',
                message: result.note,
                processes: runs.map((run) => this._runView(run)),
                runs: runs.map((run) => this._runView(run)),
                saved: (missingProject.saved || []).map((item) => this._savedView(item)),
                bindings: missingProject.bindings || [],
                ignored: missingProject.ignored || [],
                maven: await this._mavenHint(),
                note: result.note,
            };
        }
        const project = this.projectStore ? this.projectStore.project(cwd) : { bindings: [], ignored: [] };
        const boundPids = new Set(project.bindings.map((item) => Number(item.pid)));
        const ignoredKeys = new Set((project.ignored || []).map((item) => javaKeyOf(item)));

        /**
         * 用 jps 的真实结果校正托管记录的存活状态。
         *
         * 只看 pid 是否存活会被「pid 复用」骗过：进程死了、pid 被系统分给别的
         * 进程，面板就以为服务还在跑（显示「插件启动」），点重启却超时。
         * 这里拿 jps 的 pid→主类名对一遍，对不上就判定已退出。
         */
        if (this.javaRunner && typeof this.javaRunner.verifyAlive === 'function' && runs.length > 0) {
            const pidToMain = new Map();
            for (const item of result.processes || []) {
                if (item && Number.isFinite(Number(item.pid))) pidToMain.set(Number(item.pid), String(item.mainClass || ''));
            }
            const verdict = this.javaRunner.verifyAlive(runs, pidToMain);
            for (const run of runs) {
                if (verdict.has(run.id)) run.alive = verdict.get(run.id);
            }
        }
        const runByPid = new Map(runs.filter((run) => run.alive).map((run) => [Number(run.pid), run]));
        const runByName = new Map(runs.map((run) => [String(run.id), run]));

        const processes = result.processes.map((item) => {
            // 优先按 pid 认；状态文件丢过（换机器、清过 DSH_HOME）时按启动标记认，
            // 否则自己起的进程会被误标成 IDEA 的，用户就没法在这里停它了
            const marker = item.systemProperties?.['dshApiRunner.runId'];
            const run = runByPid.get(item.pid) || (marker ? runByName.get(String(marker)) : undefined);
            return {
                ...item,
                owner: run ? 'plugin' : item.fromIdea ? 'idea' : 'other',
                /** 插件托管时带上自己的记账信息（runId / 日志 / 能否停止） */
                runId: run ? run.id : '',
                managedLogPath: run ? run.logPath : '',
                restartable: Boolean(run),
                stoppable: Boolean(run),
                /**
                 * 这个字段必须有：合并进来的 jps 记录本身没有 alive，
                 * 前端据此判断「插件启动」还是「已停止」。以前漏了它，
                 * 结果所有插件托管的进程都被显示成「已停止」。
                 */
                alive: run ? Boolean(run.alive) : true,
                bound: boundPids.has(item.pid),
                ignored: ignoredKeys.has(javaKeyOf(item)),
                /** 面板上可直接拿它当 baseUrl 用：只认探测到「真的讲 HTTP」的端口 */
                baseUrl: item.httpPort ? `http://127.0.0.1:${item.httpPort}` : '',
            };
        });

        // 插件起的进程如果已经退出（或 jps 没抓到），补一行，保证面板上看得到、能再启动
        const seen = new Set(processes.map((item) => Number(item.pid)));
        for (const run of runs) {
            if (run.alive && seen.has(Number(run.pid))) continue;
            if (processes.some((item) => item.runId === run.id)) continue;
            const view = this._runView(run);
            // 同名的 IDEA 进程还在（用户没接管成功，或又在 IDEA 里重跑了）时，注明冲突
            const ideaTwin = processes.find((item) => item.name === run.id && item.owner !== 'plugin');
            if (ideaTwin) {
                ideaTwin.managedTwinId = run.id;
                // 记录已退出但同名进程还在跑：不再补一条「已停止」，否则同一个服务
                // 在列表里既显示「正在运行」又显示「已停止」，很容易误判（用户反馈过）
                if (!run.alive) continue;
            }
            processes.push(view);
        }

        return {
            ok: true,
            jps: result.jps,
            total: processes.length,
            processes,
            runs: runs.map((run) => this._runView(run)),
            saved: (project.saved || []).map((item) => this._savedView(item)),
            bindings: project.bindings,
            ignored: project.ignored || [],
            maven: await this._mavenHint(),
            note: runByName.size > 0 ? `${runByName.size} 个服务由插件托管（可直接停止/重启/看日志）` : '',
        };
    }

    /**
     * 已保存配方的对外视图：classPath 动辄几万字符，列表里只给长度，
     * 否则返回体小则几十 KB、大则上百 KB，模型和面板都用不上。
     */
    _savedView(item) {
        return {
            id: item.id,
            name: item.name,
            mainClass: item.mainClass,
            port: item.port,
            debugPort: item.debugPort,
            javaExe: item.javaExe,
            javaHome: item.javaHome,
            cwd: item.cwd,
            module: item.module,
            classPathLength: String(item.classPath || '').length,
            jvmArgs: Array.isArray(item.jvmArgs) ? item.jvmArgs.length : 0,
            programArgs: Array.isArray(item.programArgs) ? item.programArgs.length : 0,
            savedAt: item.savedAt,
        };
    }

    /**
     * 保存一个服务配方，之后不依赖 IDEA 也能由插件直接拉起。
     * 来源可以是正在跑的 IDEA 进程（pid），也可以是已经托管的服务（id）。
     */
    async saveJava(cwd, target = {}) {
        if (!this.projectStore) return { ok: false, code: 'NO_STORE', message: '面板配置存储不可用' };
        const idOrPid = String(target.id || target.pid || '');
        if (!idOrPid) return { ok: false, code: 'MISSING_ARGUMENT', message: '需要 id 或 pid' };

        const runs = this.javaRunner ? this.javaRunner.runs(cwd) : [];
        const run = runs.find((item) => String(item.id) === idOrPid || String(item.pid) === idOrPid
            || (Number(target.pid) > 0 && Number(item.pid) === Number(target.pid)));
        let recipe;
        if (run) {
            // 托管记录里本来就存了完整 argv/classpath 快照
            recipe = {
                id: run.id,
                name: run.id,
                mainClass: run.mainClass,
                classPath: run.classPath || this._classPathFromArgv(run.argv),
                jvmArgs: run.jvmArgs || [],
                programArgs: run.programArgs || [],
                javaExe: run.javaExe || '',
                javaHome: run.javaHome || '',
                cwd: run.cwd || '',
                port: run.port || 0,
                debugPort: run.debugPort || 0,
                module: run.module || null,
            };
        } else {
            // java_id 可能是服务名（如 UserService），也可能是 pid；名字转不成数字时用显式传的 pid
            const numericId = Number(idOrPid);
            const pid = Number.isInteger(numericId) && numericId > 0 ? numericId : Number(target.pid) || 0;
            if (!Number.isInteger(pid) || pid <= 0) {
                return { ok: false, code: 'NOT_FOUND', message: `找不到服务 ${idOrPid}（要保存的服务必须正在运行）` };
            }
            const { getJavaSnapshot } = await import('./restart.js');
            const snapshot = await getJavaSnapshot(pid);
            if (!snapshot.ok) return { ok: false, code: 'SNAPSHOT_FAILED', message: snapshot.message };
            const { inferMavenModule } = await import('./restart.js');
            const list = await this.javaProcesses(cwd);
            const process = (list.processes || []).find((item) => Number(item.pid) === pid);
            recipe = {
                id: String(process?.name || ''),
                name: String(process?.name || ''),
                mainClass: snapshot.mainClass,
                classPath: snapshot.classPath,
                jvmArgs: snapshot.jvmArgs,
                programArgs: snapshot.programArgs,
                javaExe: snapshot.javaExe,
                javaHome: snapshot.javaHome,
                cwd: snapshot.cwd,
                port: Number(process?.httpPort) || Number(snapshot.systemProperties?.['server.port']) || 0,
                debugPort: snapshot.systemProperties?.['jdwp'] ? Number(snapshot.systemProperties.jdwp) : 0,
                module: inferMavenModule(snapshot.classPath),
            };
        }
        try {
            const project = this.projectStore.saveJava(cwd, recipe);
            return {
                ok: true,
                id: recipe.id,
                message: `已保存 ${recipe.id}（${recipe.module?.artifactId || '未识别模块'}）。以后不用先在 IDEA 里启动，直接在「已保存」里点启动。`.replace('（未识别模块）', ''),
                saved: (project.saved || []).map((item) => this._savedView(item)),
            };
        } catch (error) {
            return { ok: false, code: 'SAVE_FAILED', message: error.message };
        }
    }

    /** 从 argv 里取 -classpath 的下一个元素（老记录没单独存 classPath 时兜底） */
    _classPathFromArgv(argv) {
        if (!Array.isArray(argv)) return '';
        const index = argv.findIndex((item) => item === '-classpath' || item === '-cp' || item === '--class-path');
        return index >= 0 ? String(argv[index + 1] || '') : '';
    }

    deleteSavedJava(cwd, id) {
        if (!this.projectStore) return { ok: false, code: 'NO_STORE', message: '面板配置存储不可用' };
        try {
            const project = this.projectStore.deleteJava(cwd, String(id || ''));
            return { ok: true, message: `已删除已保存的服务 ${id}`, saved: (project.saved || []).map((item) => this._savedView(item)) };
        } catch (error) {
            return { ok: false, code: 'UNSAVE_FAILED', message: error.message };
        }
    }

    /** 用保存的配方启动（不需要现有进程） */
    async startSavedJava(cwd, id, options = {}) {
        if (!this.projectStore) return { ok: false, code: 'NO_STORE', message: '面板配置存储不可用' };
        if (!this.javaRunner) return { ok: false, code: 'NO_RUNNER', message: 'Java 托管不可用' };
        const saved = this.projectStore.savedJava(cwd, id);
        if (!saved) return { ok: false, code: 'NOT_SAVED', message: `没有保存的服务 ${id}` };
        return this.javaRunner.startSaved(cwd, saved, options);
    }

    /**
     * 一键启动：把「已保存」里的服务批量拉起来。
     *
     * 为什么要串行而不是 Promise.all：
     *   1. Maven 编译在同一个模块上是互斥的（都写 target/），并发跑会互相覆盖，
     *      出现「编译成功但产物是半成品」这种最难查的错；
     *   2. 一个服务起不来通常意味着环境有问题（端口、依赖、编译），
     *      这时候继续把剩下的全拉起来，用户看到的是满屏报错而不是一个明确原因。
     * 所以默认**逐个启动、遇错继续**：每个失败单独记账，最后一起汇报，
     * 用户既能看到哪个成功，也能看到哪个为什么失败。
     *
     * 已经在跑的跳过（除非 options.restart 为 true），避免把正在调试的进程踢掉。
     *
     * @param {string} cwd - 项目目录
     * @param {string[]} ids - 要启动的服务 id；空数组表示「已保存里的全部」
     * @param {{compile?:boolean, restart?:boolean, timeoutMs?:number, compileTimeoutMs?:number, onProgress?:Function}} options
     */
    async startAllSavedJava(cwd, ids = [], options = {}) {
        if (!this.projectStore) return { ok: false, code: 'NO_STORE', message: '面板配置存储不可用' };
        if (!this.javaRunner) return { ok: false, code: 'NO_RUNNER', message: 'Java 托管不可用' };

        const all = this.projectStore.savedJava(cwd) || [];
        const wanted = Array.isArray(ids) && ids.length > 0
            ? ids.map((id) => String(id))
            : all.map((item) => String(item.id));
        if (wanted.length === 0) {
            return { ok: false, code: 'NOTHING_SAVED', message: '还没有保存的服务。先在「运行中」里对一个服务点「保存」，之后才能一键启动。' };
        }

        const aliveIds = new Set((this.javaRunner.runs(cwd) || []).filter((run) => run.alive).map((run) => String(run.id)));
        const items = [];
        let started = 0;
        let skipped = 0;
        let failed = 0;

        for (const id of wanted) {
            const saved = all.find((item) => String(item.id) === id);
            if (!saved) {
                items.push({ id, ok: false, code: 'NOT_SAVED', message: `没有保存的服务 ${id}` });
                failed += 1;
                if (typeof options.onProgress === 'function') {
                    try {
                        options.onProgress(items[items.length - 1], items.length, wanted.length);
                    } catch {
                        /* 进度回调出错不影响启动 */
                    }
                }
                continue;
            }
            if (aliveIds.has(id) && options.restart !== true) {
                items.push({ id, ok: true, skipped: true, note: `${id} 已在运行，跳过` });
                skipped += 1;
                if (typeof options.onProgress === 'function') {
                    try {
                        options.onProgress(items[items.length - 1], items.length, wanted.length);
                    } catch {
                        /* 进度回调出错不影响启动 */
                    }
                }
                continue;
            }
            try {
                const result = await this.javaRunner.startSaved(cwd, saved, {
                    compile: options.compile !== false,
                    timeoutMs: options.timeoutMs,
                    compileTimeoutMs: options.compileTimeoutMs,
                });
                items.push({
                    id,
                    ok: result.ok === true,
                    code: result.code,
                    pid: result.pid || 0,
                    port: result.port || 0,
                    logPath: result.logPath || '',
                    compile: result.compile,
                    message: result.message,
                    note: result.note,
                });
                if (result.ok) {
                    started += 1;
                    aliveIds.add(id);
                } else {
                    failed += 1;
                }
            } catch (error) {
                items.push({ id, ok: false, code: 'UNEXPECTED', message: String(error?.message || error) });
                failed += 1;
            }
            if (typeof options.onProgress === 'function') {
                try {
                    options.onProgress(items[items.length - 1], items.length, wanted.length);
                } catch {
                    /* 进度回调出错不影响启动 */
                }
            }
        }

        const lines = items.map((item) => {
            if (item.skipped) return `- ${item.id}：已在运行，跳过`;
            if (item.ok) return `- ${item.id}：已启动${item.port ? `（端口 ${item.port}）` : ''}`;
            return `- ${item.id}：失败 —— ${item.message || item.code || '未知原因'}`;
        });
        return {
            ok: failed === 0,
            code: failed === 0 ? undefined : 'PARTIAL',
            started,
            skipped,
            failed,
            total: wanted.length,
            items,
            message: `一键启动完成：成功 ${started} 个，跳过 ${skipped} 个，失败 ${failed} 个。\n${lines.join('\n')}`,
        };
    }

    /**
     * 在后台跑一次一键启动，立刻返回批次 id。
     *
     * 面板拿到 id 后每 1 秒拉一次 `startBatchStatus`，直到 `finished`。
     * 这样编译期间的几分钟里页面是可交互的，也能看到「3/8 正在编译」这类进度。
     */
    startSavedJavaBatch(cwd, ids = [], options = {}) {
        if (!this.projectStore) return { ok: false, code: 'NO_STORE', message: '面板配置存储不可用' };
        if (!this.javaRunner) return { ok: false, code: 'NO_RUNNER', message: 'Java 托管不可用' };
        const all = this.projectStore.savedJava(cwd) || [];
        const wanted = Array.isArray(ids) && ids.length > 0 ? ids.map((id) => String(id)) : all.map((item) => String(item.id));
        if (wanted.length === 0) {
            return { ok: false, code: 'NOTHING_SAVED', message: '还没有保存的服务。先在「运行中」里对一个服务点「保存」，之后才能一键启动。' };
        }

        this._batchSeq += 1;
        const batchId = `batch-${Date.now()}-${this._batchSeq}`;
        const batch = {
            id: batchId,
            cwd,
            startedAt: new Date().toISOString(),
            done: 0,
            total: wanted.length,
            items: [],
            finished: false,
            result: null,
            current: '',
        };
        this.startBatches.set(batchId, batch);

        // 只保留最近 10 个批次，避免长时间运行的进程内存里堆一堆历史
        if (this.startBatches.size > 10) {
            const oldest = [...this.startBatches.values()].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
            for (const item of oldest.slice(0, this.startBatches.size - 10)) this.startBatches.delete(item.id);
        }

        // 不 await：立刻把批次 id 还给面板
        Promise.resolve()
            .then(() => this.startAllSavedJava(cwd, wanted, {
                ...options,
                onProgress: (item, done, total) => {
                    batch.done = done;
                    batch.total = total;
                    batch.current = item.id;
                    batch.items.push(item);
                },
            }))
            .then((result) => {
                batch.result = result;
                batch.finished = true;
                batch.done = result.total;
                batch.current = '';
            })
            .catch((error) => {
                batch.finished = true;
                batch.current = '';
                batch.result = { ok: false, code: 'UNEXPECTED', message: String(error?.message || error) };
            });

        return { ok: true, batchId, total: wanted.length, message: `已开始一键启动 ${wanted.length} 个服务` };
    }

    /** 读一键启动批次进度；id 省略时返回最近一个批次 */
    startBatchStatus(batchId = '') {
        const key = String(batchId || '');
        const batch = key
            ? this.startBatches.get(key)
            : [...this.startBatches.values()].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).pop();
        if (!batch) return { ok: false, code: 'NO_BATCH', message: '没有这个启动批次（可能已经过期，或 DSH 重启过）' };
        return {
            ok: true,
            batchId: batch.id,
            finished: batch.finished,
            done: batch.done,
            total: batch.total,
            current: batch.current,
            startedAt: batch.startedAt,
            items: batch.items,
            result: batch.result,
        };
    }

    /** 插件级设置（数据目录 / 默认工作区 / Maven 主路径） */
    settings() {
        if (!this.settingsStore) {
            return { ok: false, code: 'NO_SETTINGS', message: '设置存储不可用' };
        }
        return { ok: true, ...this.settingsStore.read() };
    }

    saveSettings(patch = {}) {
        if (!this.settingsStore) return { ok: false, code: 'NO_SETTINGS', message: '设置存储不可用' };
        try {
            const next = this.settingsStore.set(patch);
            // 数据目录变了要立刻生效，否则日志还写到老位置
            if (this.javaRunner) this.javaRunner.refreshDataDir();
            return { ok: true, ...next };
        } catch (error) {
            return { ok: false, code: 'SETTINGS_FAILED', message: error.message };
        }
    }

    /** 托管记录的统一视图（面板与工具共用） */
    _runView(run) {
        // 回填过的记录有 httpPort/ports；没回填时退回 port，保证面板至少有一个端口可看
        const httpPort = Number(run.httpPort) || Number(run.port) || 0;
        const ports = Array.isArray(run.ports) && run.ports.length > 0 ? run.ports : httpPort ? [httpPort] : [];
        return {
            pid: run.pid,
            mainClass: run.mainClass,
            name: run.id,
            kind: 'spring',
            owner: 'plugin',
            fromIdea: false,
            profiles: [],
            debugPort: run.debugPort || 0,
            ideaProject: '',
            serverPort: httpPort,
            ports,
            primaryPort: Number(run.primaryPort) || httpPort,
            httpPort,
            sentinelPort: Number(run.sentinelPort) || 0,
            systemProperties: {},
            bound: false,
            ignored: false,
            baseUrl: httpPort ? `http://127.0.0.1:${httpPort}` : '',
            runId: run.id,
            managedLogPath: run.logPath,
            module: run.module ? run.module.artifactId || '' : '',
            restartable: true,
            stoppable: run.alive,
            alive: run.alive,
            startedAt: run.startedAt || '',
            stoppedAt: run.stoppedAt || '',
        };
    }

    async _mavenHint() {
        try {
            const { resolveMaven } = await import('./restart.js');
            // 与编译时保持一致：设置里配了 Maven 主路径就以它为准，
            // 否则面板会显示「IDEA 自带 Maven」，与实际编译用的不是同一个，容易误导。
            const preferred = this.javaRunner ? this.javaRunner.configuredMaven('') : '';
            const mvn = await resolveMaven(preferred);
            return { available: Boolean(mvn), path: mvn, source: preferred ? 'settings' : 'auto' };
        } catch {
            return { available: false, path: '', source: 'auto' };
        }
    }

    /**
     * 接管一个 IDEA 起的进程：按快照编译 → 杀旧进程 → 插件拉起新进程。
     * 这是「写完代码后重启」的入口；成功后该服务 owner 变成 plugin。
     */
    async startJava(cwd, options = {}) {
        if (!this.javaRunner) return { ok: false, code: 'NO_RUNNER', message: 'Java 托管不可用' };
        const result = await this.javaRunner.start(cwd, options);
        if (result.ok) this.javaProcesses(cwd).catch(() => {});
        return result;
    }

    async stopJava(cwd, idOrPid) {
        if (!this.javaRunner) return { ok: false, code: 'NO_RUNNER', message: 'Java 托管不可用' };
        return this.javaRunner.stop(cwd, idOrPid);
    }

    async restartJava(cwd, idOrPid, options = {}) {
        if (!this.javaRunner) return { ok: false, code: 'NO_RUNNER', message: 'Java 托管不可用' };
        return this.javaRunner.restart(cwd, idOrPid, options);
    }

    /**
     * 忘掉一条接管记录（不杀进程）。
     * 用于清掉「IDE 里已经关了、但面板上还留着」的幽灵条目。
     */
    async forgetJava(cwd, idOrPid) {
        if (!this.javaRunner) return { ok: false, code: 'NO_RUNNER', message: 'Java 托管不可用' };
        return this.javaRunner.forget(cwd, idOrPid);
    }

    javaLogs(cwd, id, options = {}) {
        if (!this.javaRunner) return { ok: false, code: 'NO_RUNNER', message: 'Java 托管不可用' };
        return this.javaRunner.logs(cwd, id, options);
    }

    /**
     * 服务详情：进程信息 + 可读日志文件清单 + 首屏日志。
     *
     * 日志来源分两种：
     *   - 插件托管的进程：`${DSH_HOME}/java-logs/<id>.log`（我们自己的 stdout 落盘）
     *   - IDEA 起的进程：读它自己的 logback 文件 `<user.dir>/logs/<服务名>/info.log`
     *     （IDEA 控制台不是文件，拿不到；但应用日志内容是一样的）
     */
    async javaDetail(cwd, target, options = {}) {
        const idOrPid = String(target || '');
        if (!idOrPid) return { ok: false, code: 'MISSING_ARGUMENT', message: '需要 id 或 pid' };

        const runs = this.javaRunner ? this.javaRunner.runs(cwd) : [];
        const run = runs.find((item) => String(item.id) === idOrPid || String(item.pid) === idOrPid);
        const list = await this.javaProcesses(cwd);
        const numeric = Number(idOrPid);
        // pid 之外也允许用服务名（UserService）或主类定位，模型和人都更顺手
        const process = (list.processes || []).find((item) => (
            (Number.isFinite(numeric) && numeric > 0 && Number(item.pid) === numeric)
            || (!run && String(item.name) === idOrPid)
            || (!run && String(item.mainClass) === idOrPid)
        )) || null;
        const pid = run ? Number(run.pid) : (process ? Number(process.pid) : numeric);

        if (!run && !process) {
            return { ok: false, code: 'NOT_FOUND', message: `找不到服务 ${idOrPid}（可能已经退出，或 pid 不对）` };
        }

        const name = process?.name || run?.id || idOrPid;
        const mainClass = process?.mainClass || run?.mainClass || '';
        // 有托管记录就以记录的 alive 为准（进程已退出时 jps 里也没有它）
        const alive = run ? Boolean(run.alive) : Boolean(process);

        // 候选日志文件：插件日志优先（顺序更接近启动过程），再是应用日志
        const sources = [];
        if (run) {
            // 每次启动一个日志文件，默认给最新的，历史启动可以切过去对比
            const segments = this.javaRunner ? this.javaRunner.logSegmentsOf(run.id) : [];
            for (const segment of segments.slice(0, 8)) {
                const current = run.logPath === segment.path;
                sources.push({
                    key: `plugin:${segment.path}`,
                    label: `插件输出 ${segment.name.replace(/\.log$/i, '')}${current ? '（当前）' : ''}`,
                    path: segment.path,
                    kind: 'plugin',
                    size: segment.size,
                    updatedAt: segment.updatedAt,
                });
            }
        }
        let discovered = { ok: false, cwd: '', files: [], note: '' };
        if (!run) {
            discovered = await discoverLogs(pid, name);
            for (const file of discovered.files || []) {
                sources.push({ key: `app:${file.path}`, label: `应用日志 ${file.name}`, path: file.path, kind: 'app', size: file.size, updatedAt: file.updatedAt });
            }
        } else {
            // 托管进程也能看应用日志（logback 照样写文件），只是默认展示插件输出
            discovered = await discoverLogs(pid, name);
            for (const file of (discovered.files || []).slice(0, 3)) {
                sources.push({ key: `app:${file.path}`, label: `应用日志 ${file.name}`, path: file.path, kind: 'app', size: file.size, updatedAt: file.updatedAt });
            }
        }

        const wanted = options.source ? sources.find((item) => item.key === options.source || item.path === options.source) : undefined;
        const chosen = wanted || sources[0] || undefined;
        let log = { ok: true, logPath: '', size: 0, fromOffset: 0, nextOffset: 0, text: '', note: '没有可读的日志文件' };
        if (chosen) {
            // 没给偏移 = 打开页面看首屏：按行取末尾（和 IDEA 控制台一样先看最近的），
            // 给了偏移 = 轮询增量，继续按字节读。
            const hasFrom = Number.isFinite(Number(options.fromOffset)) && Number(options.fromOffset) >= 0;
            log = hasFrom
                ? readFileChunk(chosen.path, { fromOffset: Number(options.fromOffset), maxBytes: options.maxBytes })
                : readFileTail(chosen.path, { lines: options.lines });
            log.source = chosen.key;
        }

        return {
            ok: true,
            id: process?.runId || run?.id || name,
            pid,
            name,
            mainClass,
            owner: process?.owner || 'plugin',
            alive,
            port: process?.httpPort || run?.port || 0,
            ports: process?.portList || [],
            debugPort: process?.debugPort || run?.debugPort || 0,
            profiles: process?.profiles || [],
            module: process?.module || (run?.module ? run.module.artifactId || '' : ''),
            startedAt: run?.startedAt || '',
            stoppedAt: run?.stoppedAt || '',
            cwd: discovered.cwd || '',
            sources,
            source: chosen?.key || '',
            log,
            note: sources.length === 0
                ? (discovered.note || '没有找到日志文件（IDEA 控制台输出不落盘，需要应用自己写 logback 文件）')
                : '',
        };
    }

    ignoreJava(cwd, target) {
        if (!this.projectStore) return { ok: false, code: 'NO_STORE', message: '面板配置存储不可用' };
        const key = javaKeyOf(target);
        if (!key) return { ok: false, code: 'MISSING_ARGUMENT', message: '缺少 mainClass 或 name' };
        try {
            this.projectStore.ignoreJava(cwd, target);
            return { ok: true, message: `已忽略 ${target.name || key}` };
        } catch (error) {
            return { ok: false, code: 'IGNORE_FAILED', message: error.message };
        }
    }

    unignoreJava(cwd, target) {
        if (!this.projectStore) return { ok: false, code: 'NO_STORE', message: '面板配置存储不可用' };
        this.projectStore.unignoreJava(cwd, target);
        return { ok: true, message: `已取消忽略 ${target.name || javaKeyOf(target)}` };
    }

    bindJava(cwd, binding) {
        if (!this.projectStore) return { ok: false, code: 'NO_STORE', message: '面板配置存储不可用' };
        try {
            this.projectStore.bindJava(cwd, binding);
            return { ok: true, message: `已关联 pid ${binding.pid}` };
        } catch (error) {
            return { ok: false, code: 'BIND_FAILED', message: error.message };
        }
    }

    unbindJava(cwd, pid) {
        if (!this.projectStore) return { ok: false, code: 'NO_STORE', message: '面板配置存储不可用' };
        this.projectStore.unbindJava(cwd, pid);
        return { ok: true, message: `已取消关联 pid ${pid}` };
    }

    // ---- 数据库（从 dsh-db-tool 合并进来的能力） ----
    /**
     * 数据库连接是**跨项目**的：同一套库通常被多个项目共用，
     * 按项目归档反而每次换项目都要重配。所以这里不接 cwd 参数。
     */
    dbConnections() {
        if (!this.dbManager) return { ok: false, code: 'NO_DB', message: '数据库模块不可用' };
        try {
            const connections = this.dbManager.listConnections();
            return { ok: true, connections, total: connections.length };
        } catch (error) {
            return { ok: false, code: 'DB_ERROR', message: String(error?.message || error) };
        }
    }

    async dbTest(target, options = {}) {
        if (!this.dbManager) return { ok: false, code: 'NO_DB', message: '数据库模块不可用' };
        return this.dbManager.testConnection(target, options);
    }

    /** 驱动自检：面板上一键查看各驱动是否可用 */
    async dbDiagnose() {
        if (!this.dbManager) return { ok: false, code: 'NO_DB', message: '数据库模块不可用' };
        return this.dbManager.diagnose();
    }

    dbSave(patch) {
        if (!this.dbManager) return { ok: false, code: 'NO_DB', message: '数据库模块不可用' };
        return this.dbManager.saveConnection(patch);
    }

    dbDelete(id) {
        if (!this.dbManager) return { ok: false, code: 'NO_DB', message: '数据库模块不可用' };
        return this.dbManager.deleteConnection(id);
    }

    async dbQuery(id, sql, params = [], options = {}) {
        if (!this.dbManager) return { ok: false, code: 'NO_DB', message: '数据库模块不可用' };
        return this.dbManager.query(id, sql, params, options);
    }

    async dbDatabases(id, options = {}) {
        if (!this.dbManager) return { ok: false, code: 'NO_DB', message: '数据库模块不可用' };
        return this.dbManager.listDatabases(id, options);
    }

    async dbTables(id, database = '', options = {}) {
        if (!this.dbManager) return { ok: false, code: 'NO_DB', message: '数据库模块不可用' };
        return this.dbManager.listTables(id, database, options);
    }

    async dbDescribeTable(id, table, options = {}) {
        if (!this.dbManager) return { ok: false, code: 'NO_DB', message: '数据库模块不可用' };
        return this.dbManager.describeTable(id, table, options);
    }

    // ---- 数据库项目授权（默认拒绝，必须显式授权） ----
    dbAccess(projectKey) {
        if (!this.dbManager) return { ok: false, code: 'NO_DB', message: '数据库模块不可用' };
        return this.dbManager.accessView(projectKey);
    }

    dbSetAccess(projectKey, connectionId, level) {
        if (!this.dbManager) return { ok: false, code: 'NO_DB', message: '数据库模块不可用' };
        return this.dbManager.setAccess(projectKey, connectionId, level);
    }

    /**
     * 查某项目对某连接的授权等级：'none' | 'readonly' | 'readwrite'。
     *
     * 模型侧的读写能力由这个等级决定（见 main.js 的 db_action=query），
     * 而不是写死只读。数据库模块不可用时按 'none' 处理，最保守。
     */
    dbAccessLevel(projectKey, connectionId) {
        if (!this.dbManager) return 'none';
        const row = this.dbManager.accessOf(projectKey);
        return row[String(connectionId)] || 'none';
    }

    dispose() {
        this.logReader.dispose();
        this.serviceManager.dispose();
        // 数据库连接池也要关，否则插件卸载后连接泄漏
        if (this.dbManager) this.dbManager.dispose();
    }
}

/** 步骤失败时给出可读原因，而不是只回一个阶段名 */
function describeFailure(step) {
    if (step.stage === 'log') {
        if (step.pattern) return `等待日志特征 ${step.pattern} 超时（${step.waitedMs}ms）：${step.path}`;
        return `读取日志失败：${step.path}`;
    }
    if (step.stage === 'call') {
        return step.error ? `接口调用失败：${step.error}` : `接口返回 HTTP ${step.status}`;
    }
    if (step.stage === 'wait') {
        return `服务在超时内未通过健康检查：${(step.checks || []).map((item) => `${item.kind}=${item.ok ? 'ok' : item.detail}`).join('; ')}`;
    }
    return step.message || `${step.stage} 步骤失败`;
}

/** 展示用的完整地址：baseUrl + url，保留 {占位符} 让模型知道路径形状 */
function displayUrl(api) {
    const raw = String(api.url || '');
    if (!api.baseUrl) return raw;
    if (/^https?:\/\//i.test(raw)) return raw;
    const base = api.baseUrl.endsWith('/') ? api.baseUrl.slice(0, -1) : api.baseUrl;
    return `${base}/${raw.replace(/^\//, '')}`;
}

/** 从 api 定义里推断可用占位符，帮助模型知道要传什么参数 */
function collectParams(api) {
    const names = new Set();
    const scan = (text) => {
        if (typeof text !== 'string') return;
        for (const match of text.matchAll(/\{([A-Za-z_][A-Za-z0-9_.-]*)\}/g)) names.add(match[1]);
    };
    scan(api.url);
    const walk = (value) => {
        if (typeof value === 'string') scan(value);
        else if (Array.isArray(value)) value.forEach(walk);
        else if (isPlainObject(value)) Object.values(value).forEach(walk);
    };
    walk(api.query);
    walk(api.body);
    Object.keys(api.query || {}).forEach((key) => names.add(key));
    return [...names];
}

/**
 * 在登录响应里找像 token 的字段路径，用于 tokenPath 配错时给出可操作提示。
 * 只递归三层，避免大响应里遍历过多。
 */
function tokenCandidates(value, prefix = '', depth = 0) {
    if (depth > 3 || !isPlainObject(value)) return [];
    const out = [];
    for (const [key, item] of Object.entries(value)) {
        const pathText = prefix ? `${prefix}.${key}` : key;
        if (typeof item === 'string' && /token/i.test(key) && item.length >= 8) {
            out.push(pathText);
        } else if (isPlainObject(item)) {
            out.push(...tokenCandidates(item, pathText, depth + 1));
        }
    }
    return out;
}

function fileExists(file) {
    try {
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}

function fileSize(file) {
    try {
        return fs.statSync(file).size;
    } catch {
        return 0;
    }
}

/** 工具输出统一渲染成文本：优先 JSON，过长则截断 */
export function toText(payload, maxBytes = 24 * 1024) {
    let text;
    try {
        text = JSON.stringify(payload, null, 2);
    } catch {
        text = String(payload);
    }
    return truncateText(text, maxBytes);
}

/** 供 HTTP API 与调试使用：把未知输入规整成对象 */
export function asObject(value) {
    if (isPlainObject(value)) return value;
    if (typeof value === 'string') {
        const parsed = tryJson(value);
        return isPlainObject(parsed) ? parsed : {};
    }
    return {};
}

export { expandDeep, normalizeProjectKey };
