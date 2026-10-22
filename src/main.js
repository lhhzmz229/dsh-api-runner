/**
 * dsh-api-runner 插件入口。
 *
 * 形态对齐 dsh-db-tool：`export const inject` + `export function apply(ctx)`，
 * **不提供 default export**（cordis-plugin-loader 的 unwrapExports() 会取
 * exports.default，裸函数形态会丢掉 inject，报
 * "cannot get property \"webServer\" without inject"）。
 *
 * 提供三件事：
 *  1. 按配置调用后端 HTTP 接口（{param} 占位、JSON/form body、超时、响应截断）；
 *  2. 本地服务启停/重启（managed 托管进程 / observe 只观测 IDEA 起的进程）；
 *  3. 日志增量读取与"等某个日志特征出现"，让模型能改完自己验证。
 *
 * 配置默认读 ${DSH_HOME}/api-runner.yml，项目内可用 <cwd>/.dsh/api-runner.yml 覆盖；
 * 每次调用重新解析（带 mtime 缓存），改配置不需要重启 DSH。
 */
import path from 'node:path';
import { ApiRunnerService, asObject, toText } from './ops.js';
import { ProjectStore } from './project-store.js';
import { JavaRunner } from './java-runner.js';
import { SettingsStore } from './settings.js';

export const inject = ['webServer', 'sessions', 'tools', 'connection', 'systemPrompt'];

const TOOL_DESCRIPTION = `开发联调工具（dsh-api-runner）：按配置调用后端 HTTP 接口、启停本地服务、增量读取日志。

典型用法（改完后端代码后自测）：
1. action=describe —— 先看有哪些接口/服务/日志可用（含每个接口需要的参数名）。
2. action=service + service_action=restart —— 重启本地服务（managed 模式由插件托管进程；
   observe 模式下插件不托管，需你到 IDEA 里重启，然后用 service_action=wait 等就绪）。
3. action=log + pattern —— 增量读日志；或 action=wait_log 等启动完成/报错特征出现。
4. action=call —— 调用接口，params 里的键会替换 URL 里的 {name} 并拼进 query/body。
5. action=verify —— 一条命令串起「重启 → 读日志 → 调接口」，适合改完后端后自检。

注意：
- 日志游标按 logId 持久化，第一次读只取文件末尾一段；要全量请传 reset=true。
- 服务重启会 kill 整个进程树后重新拉起（managed）；失败时返回 exit code 与健康检查明细。
- 接口响应体默认截断到 32KB，可用 max_bytes 调整；请求头在返回里已脱敏。`;

const PARAMETERS = {
    type: 'object',
    properties: {
        action: {
            type: 'string',
            enum: ['describe', 'call', 'login', 'service', 'log', 'wait_log', 'reset_log', 'verify', 'java'],
            description: '要执行的操作',
        },
        api_id: { type: 'string', description: '接口 id 或 name（call、login、verify 用）' },
        params: {
            type: 'object',
            additionalProperties: true,
            description: '接口参数：键会替换 URL/body 里的 {key} 占位，未用到的键拼进 query',
        },
        token_from: { type: 'string', description: 'call 时用哪个登录接口保存的 token（省略则自动判断）' },
        service_id: { type: 'string', description: '服务 id 或 name（service、verify 用；省略时取第一个服务）' },
        service_action: {
            type: 'string',
            enum: ['start', 'stop', 'restart', 'wait', 'status'],
            description: '服务动作（action=service 用）',
        },
        log_id: { type: 'string', description: '日志 id 或 name（log、wait_log、reset_log 用；省略时取第一个日志）' },
        java_action: {
            type: 'string',
            enum: ['list', 'start', 'stop', 'restart', 'log', 'status', 'detail', 'ignore', 'unignore', 'save', 'unsave', 'start_saved', 'start_all', 'settings'],
            description: 'Java 服务动作（action=java 用）：list 列出；detail 服务详情+日志；start 接管启动（先编译再杀旧进程）；stop/restart 只对插件启动的生效；log 读日志；ignore/unignore 在面板列表中隐藏/恢复；save 把当前进程的启动配方向保存下来（之后不用 IDEA 也能起）；unsave 删除保存；start_saved 按保存的配置启动一个；start_all 一键启动所有已保存的服务（已运行的跳过，单个失败不影响其余，返回每个的成败）；settings 读写插件设置（数据目录/默认工作区）',
        },
        java_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'java_action=start_all 时只启动这些服务（省略则启动全部已保存的）',
        },
        pid: { type: 'number', description: '要接管的 Java 进程 pid（java_action=start 用）' },
        java_id: { type: 'string', description: '插件托管的服务名或 pid（java_action=stop/restart/log/save/unsave/start_saved 用）' },
        port: { type: 'number', description: '服务端口（java_action=start 用；省略则从进程参数推断）' },
        debug: { type: 'string', enum: ['port', 'none', 'keep'], description: '重启后的调试端口处理（默认 port：自己开 y 端口等连接）' },
        from_offset: { type: 'number', description: 'java_action=log 时的起始字节偏移（增量读）' },
        log_source: { type: 'string', description: 'java_action=detail 时选哪个日志文件（取 detail 返回的 sources[].key；省略用第一个）' },
        compile: { type: 'boolean', description: 'java_action=start/restart/start_saved 前是否先 mvn 编译（默认 true）' },
        settings: {
            type: 'object',
            description: 'java_action=settings 且要写入时传：{ dataDir?: "/abs/path（绝对路径，空字符串恢复默认）", workspace?: "默认项目根", mavenHome?: "Maven 主路径（安装目录，空表示自动探测）" }',
            properties: {
                dataDir: { type: 'string' },
                workspace: { type: 'string' },
                mavenHome: { type: 'string' },
            },
        },
        pattern: { type: 'string', description: '正则过滤：只返回匹配行（log）；wait_log 时等匹配行出现' },
        ignore_case: { type: 'boolean', description: 'pattern 是否忽略大小写' },
        max_bytes: { type: 'number', description: '单次最多读取的字节数（默认 65536）' },
        max_lines: { type: 'number', description: '返回行数上限（默认 400，超出保留最后 N 行）' },
        reset: { type: 'boolean', description: '日志从头读（忽略游标与历史）' },
        timeout_ms: { type: 'number', description: '超时：接口请求 / 等待日志 / 等待健康检查（毫秒）' },
        restart: { type: 'boolean', description: 'verify 时是否先重启服务（默认 true）' },
    },
    required: ['action'],
};

/** 服务/日志动作的统一入口 */
async function runTool(service, args, projectPath) {
    const action = String(args.action || '');
    const timeoutMs = args.timeout_ms ? Number(args.timeout_ms) : undefined;

    switch (action) {
        case 'describe':
            return service.describe(projectPath);
        case 'call': {
            if (!args.api_id) return { ok: false, code: 'MISSING_ARGUMENT', message: 'call 需要 api_id' };
            return service.call(projectPath, String(args.api_id), asObject(args.params), {
                maxBodyBytes: args.max_bytes ? Number(args.max_bytes) : undefined,
                timeoutMs,
                tokenFrom: args.token_from ? String(args.token_from) : '',
            });
        }
        case 'login': {
            if (!args.api_id) return { ok: false, code: 'MISSING_ARGUMENT', message: 'login 需要 api_id（登录接口的 id）' };
            return service.login(projectPath, String(args.api_id), asObject(args.params), {
                maxBodyBytes: args.max_bytes ? Number(args.max_bytes) : undefined,
                timeoutMs,
            });
        }
        case 'java': {
            const javaAction = String(args.java_action || 'list');
            if (javaAction === 'list') return service.javaProcesses(projectPath);
            if (javaAction === 'start') {
                if (!args.pid) return { ok: false, code: 'MISSING_ARGUMENT', message: 'java_action=start 需要 pid（要接管的 Java 进程）' };
                return service.startJava(projectPath, {
                    pid: Number(args.pid),
                    id: args.java_id ? String(args.java_id) : '',
                    port: args.port ? Number(args.port) : 0,
                    compile: args.compile !== false,
                    debug: args.debug ? String(args.debug) : 'port',
                    timeoutMs,
                });
            }
            if (javaAction === 'stop') {
                const target = args.java_id || args.pid;
                if (!target) return { ok: false, code: 'MISSING_ARGUMENT', message: 'java_action=stop 需要 java_id 或 pid' };
                return service.stopJava(projectPath, target);
            }
            if (javaAction === 'restart') {
                const target = args.java_id || args.pid;
                if (!target) return { ok: false, code: 'MISSING_ARGUMENT', message: 'java_action=restart 需要 java_id 或 pid' };
                return service.restartJava(projectPath, target, { compile: args.compile !== false, timeoutMs });
            }
            if (javaAction === 'log') {
                const target = args.java_id || args.pid;
                if (!target) return { ok: false, code: 'MISSING_ARGUMENT', message: 'java_action=log 需要 java_id 或 pid' };
                return service.javaLogs(projectPath, target, {
                    fromOffset: args.from_offset !== undefined ? Number(args.from_offset) : undefined,
                    maxBytes: args.max_bytes ? Number(args.max_bytes) : undefined,
                });
            }
            if (javaAction === 'status') {
                const list = await service.javaProcesses(projectPath);
                return { ...list, javaAction: 'status' };
            }
            if (javaAction === 'detail') {
                const target = args.java_id || args.pid;
                if (!target) return { ok: false, code: 'MISSING_ARGUMENT', message: 'java_action=detail 需要 java_id 或 pid' };
                return service.javaDetail(projectPath, target, {
                    fromOffset: args.from_offset !== undefined ? Number(args.from_offset) : undefined,
                    maxBytes: args.max_bytes ? Number(args.max_bytes) : undefined,
                    source: args.log_source ? String(args.log_source) : '',
                });
            }
            if (javaAction === 'ignore' || javaAction === 'unignore') {
                const target = args.java_id || args.pid;
                if (!target) return { ok: false, code: 'MISSING_ARGUMENT', message: `java_action=${javaAction} 需要 java_id 或 pid` };
                const list = await service.javaProcesses(projectPath);
                const found = (list.processes || []).find((item) => String(item.runId) === String(target) || String(item.pid) === String(target) || String(item.name) === String(target));
                if (!found) return { ok: false, code: 'NOT_FOUND', message: `找不到服务 ${target}` };
                return javaAction === 'ignore' ? service.ignoreJava(projectPath, found) : service.unignoreJava(projectPath, found);
            }
            if (javaAction === 'save') {
                const target = args.java_id || args.pid;
                if (!target) return { ok: false, code: 'MISSING_ARGUMENT', message: 'java_action=save 需要 java_id 或 pid' };
                return service.saveJava(projectPath, { id: String(target), pid: Number(args.pid) || 0 });
            }
            if (javaAction === 'unsave') {
                const target = args.java_id || args.pid;
                if (!target) return { ok: false, code: 'MISSING_ARGUMENT', message: 'java_action=unsave 需要 java_id' };
                return service.deleteSavedJava(projectPath, String(target));
            }
            if (javaAction === 'start_saved') {
                const target = args.java_id;
                if (!target) return { ok: false, code: 'MISSING_ARGUMENT', message: 'java_action=start_saved 需要 java_id（已保存的服务名）' };
                return service.startSavedJava(projectPath, String(target), {
                    compile: args.compile !== false,
                    port: args.port ? Number(args.port) : 0,
                    debug: args.debug ? String(args.debug) : 'port',
                    timeoutMs,
                });
            }
            // 一键启动：把「已保存」里的服务全拉起来（或只拉 java_ids 列的那几个）
            if (javaAction === 'start_all') {
                const ids = Array.isArray(args.java_ids)
                    ? args.java_ids.map((id) => String(id))
                    : (args.java_id ? [String(args.java_id)] : []);
                return service.startAllSavedJava(projectPath, ids, {
                    compile: args.compile !== false,
                    restart: args.restart === true,
                    timeoutMs,
                    compileTimeoutMs: args.timeout_ms ? Number(args.timeout_ms) : undefined,
                });
            }
            if (javaAction === 'settings') {
                if (args.settings && typeof args.settings === 'object') return service.saveSettings(asObject(args.settings));
                return service.settings();
            }
            return { ok: false, code: 'BAD_ACTION', message: `不支持的 java_action: ${javaAction}` };
        }
        case 'service': {
            const serviceAction = String(args.service_action || 'status');
            if (!args.service_id && serviceAction !== 'status') {
                return { ok: false, code: 'MISSING_ARGUMENT', message: 'service 动作需要 service_id' };
            }
            if (serviceAction === 'status') return service.serviceStatus(projectPath, args.service_id ? String(args.service_id) : '');
            return service.serviceAction(projectPath, String(args.service_id), serviceAction, { timeoutMs });
        }
        case 'log':
            return service.readLog(projectPath, args.log_id ? String(args.log_id) : '', {
                pattern: args.pattern ? String(args.pattern) : '',
                ignoreCase: Boolean(args.ignore_case),
                maxBytes: args.max_bytes ? Number(args.max_bytes) : undefined,
                maxLines: args.max_lines ? Number(args.max_lines) : undefined,
                reset: Boolean(args.reset),
            });
        case 'wait_log':
            return service.waitLog(projectPath, args.log_id ? String(args.log_id) : '', {
                pattern: args.pattern ? String(args.pattern) : '',
                ignoreCase: Boolean(args.ignore_case),
                timeoutMs: timeoutMs || 60_000,
                maxBytes: args.max_bytes ? Number(args.max_bytes) : undefined,
                maxLines: args.max_lines ? Number(args.max_lines) : undefined,
                reset: Boolean(args.reset),
            });
        case 'reset_log':
            return service.resetLog(projectPath, args.log_id ? String(args.log_id) : '');
        case 'verify':
            return service.verify(projectPath, {
                service: args.service_id ? String(args.service_id) : '',
                apiId: args.api_id ? String(args.api_id) : '',
                logId: args.log_id ? String(args.log_id) : '',
                params: asObject(args.params),
                pattern: args.pattern ? String(args.pattern) : '',
                restart: args.restart !== false,
                maxLines: args.max_lines ? Number(args.max_lines) : undefined,
                startupTimeoutMs: timeoutMs,
            });
        default:
            return { ok: false, code: 'BAD_ACTION', message: `不支持的 action: ${action}` };
    }
}

export function apply(ctx) {
    const log = ctx.logger ?? { info: () => {}, error: () => {} };
    const homeDir = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.cwd(), '.dsh');
    // 插件 Config 可选提供 configPath（相对 DSH_HOME）；无 Config 时用默认约定
    const configPath = (() => {
        try {
            return String(ctx.config?.configPath || '');
        } catch {
            return '';
        }
    })();
    const projectStore = new ProjectStore({ homeDir });
    const settingsStore = new SettingsStore({ homeDir });
    const javaRunner = new JavaRunner({ homeDir, settingsStore });
    const service = new ApiRunnerService({ homeDir, configPath, projectStore, javaRunner, settingsStore });

    // 项目路径权威解析：会话 header.cwd 优先，绝不信任模型自报
    const projectOf = (sessionId) => {
        try {
            return sessionId !== '' ? ctx.sessions?.get?.(sessionId)?.header?.cwd ?? '' : '';
        } catch {
            return '';
        }
    };

    // ---- HTTP API：同源前端/脚本可读配置、调接口、读日志 ----
    ctx.effect?.(
        () =>
            ctx.webServer?.register({
                kind: 'prefix',
                path: '/dsh-api-runner/api',
                handler: async (req, res) => {
                    // 0.2.0-rc.1 起插件前缀路由不经宿主鉴权，这里显式应用请求栅栏
                    const rejection = ctx.connection?.requestRejection?.(req);
                    if (rejection !== undefined) {
                        res.statusCode = rejection;
                        res.setHeader('Content-Type', 'application/json; charset=utf-8');
                        res.end(
                            JSON.stringify({
                                ok: false,
                                code: rejection === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN',
                                error: rejection === 401 ? 'browser authentication required' : 'untrusted request',
                            }),
                        );
                        return;
                    }
                    try {
                        await handleHttp(req, res, service, projectOf);
                    } catch (error) {
                        if (!res.headersSent) res.statusCode = 500;
                        res.setHeader('Content-Type', 'application/json; charset=utf-8');
                        res.end(JSON.stringify({ ok: false, code: 'INTERNAL', message: String(error?.message || error) }));
                    }
                },
            }) ?? (() => {}),
        'api-runner-http',
    );

    // ---- 系统提示：把可用接口清单注入，模型不用先 describe 也知道能调什么 ----
    ctx.effect?.(() => {
        // systemPrompt 已列入 inject：cordis 的 ctx 是 Proxy，访问未 inject 的服务
        // 会直接抛 `cannot get property "xxx" without inject`，所以不能用可选链兜底。
        const prompt = ctx.systemPrompt;
        if (!prompt?.section) return () => {};
        // section 的 order 用较大值，排在通用规范之后
        return (
            prompt.section({
                name: 'api-runner',
                order: 900,
                text: () => {
                    try {
                        const info = service.describe('');
                        const apis = info.apis.map((api) => `- ${api.id}（${api.method} ${api.url}）${api.params.length ? ` 参数: ${api.params.join(', ')}` : ''}`).join('\n');
                        const services = info.services.map((item) => `- ${item.id}（${item.mode}）${item.name}`).join('\n');
                        const logs = info.logs.map((item) => `- ${item.id} → ${item.path}`).join('\n');
                        if (!apis && !services && !logs) return '';
                        return [
                            '# 本地开发联调（dsh-api-runner）',
                            '可用工具 ApiRunner 已配置以下资源；改完后端代码后可用它重启服务、读日志、直接调接口验证。',
                            apis ? `\n接口：\n${apis}` : '',
                            services ? `\n服务：\n${services}` : '',
                            logs ? `\n日志：\n${logs}` : '',
                        ].join('\n');
                    } catch {
                        return '';
                    }
                },
            }) ?? (() => {})
        );
    }, 'api-runner-prompt');

    // ---- 模型工具 ----
    ctx.tools?.register({
        name: 'ApiRunner',
        timeoutMs: 120_000,
        description: TOOL_DESCRIPTION,
        parameters: PARAMETERS,
        output: {
            schema: {
                type: 'object',
                properties: {
                    text: { type: 'string', description: 'JSON 结果文本' },
                    isError: { type: 'boolean', description: 'true 表示操作失败' },
                },
                required: ['text'],
            },
            render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        execute: async (args, exec) => {
            const sid = exec.agent?.session?.id ?? '';
            // 会话 cwd 优先；拿不到时退回「设置」里的默认工作区，避免落到 default 桶里
            const cwd = projectOf(sid) || defaultWorkspace(service);
            let payload;
            try {
                payload = await runTool(service, args ?? {}, cwd);
            } catch (error) {
                payload = { ok: false, code: 'UNEXPECTED', message: String(error?.message || error), stack: error?.stack };
            }
            return { text: toText(payload), isError: payload?.ok === false };
        },
    });

    // ---- 卸载收尾：保存日志游标与服务状态，但不杀托管进程 ----
    ctx.effect?.(() => () => service.dispose(), 'api-runner-dispose');

    log.info?.('[api-runner] 插件已加载（ApiRunner 工具 + /dsh-api-runner/api）');
}

/**
 * 面板传来的项目路径：优先 session 头解析出的 cwd；
 * 面板可能直传 cwd（浏览器里没有会话上下文时），但只作为兜底，
 * 且必须是绝对路径，避免被随意指向别处。
 */
function pickCwdRaw(cwd, url, body) {
    if (cwd) return cwd;
    const hint = (body && typeof body.cwd === 'string' && body.cwd) || url.searchParams.get('cwd') || '';
    if (hint === '') return '';
    return path.isAbsolute(hint) ? path.resolve(hint) : '';
}

/**
 * 面板「接口」页二级页签里显式选中的项目。
 *
 * 值是 ProjectStore 的 key（归一化后的绝对路径）。它必须优先于会话 cwd：
 * 面板在某个会话里打开时，会话 cwd 永远存在，否则切到别的项目会被它盖掉，
 * 页签点了没反应。只接受两种值——store 里真实存在的 key，或绝对路径。
 */
function pickProject(service, url, body) {
    const hint = (body && typeof body.project === 'string' && body.project) || url.searchParams.get('project') || '';
    if (!hint) return '';
    try {
        const store = service.projectStore;
        if (store && typeof store.allProjects === 'function' && store.allProjects().some((item) => item.key === hint)) {
            return hint;
        }
    } catch {
        /* store 读失败就退回绝对路径判断 */
    }
    return path.isAbsolute(hint) ? path.resolve(hint) : '';
}

/** 没有会话上下文时，用「设置」里配的默认工作区（只接受绝对路径） */
function defaultWorkspace(service) {
    try {
        const current = service.settings?.();
        const value = current && current.ok !== false ? String(current.workspace || '') : '';
        return value && path.isAbsolute(value) ? path.resolve(value) : '';
    } catch {
        return '';
    }
}

/** HTTP 路由分发（前缀 /dsh-api-runner/api） */
async function handleHttp(req, res, service, projectOf) {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const route = url.pathname.replace(/^\/dsh-api-runner\/api\/?/, '');
    const sessionId = req.headers['x-dsh-session-id'] ? String(req.headers['x-dsh-session-id']) : '';
    const cwd = projectOf(sessionId);
    /**
     * 项目目录优先级：显式选中的项目 > 会话 cwd > 请求里显式给的 cwd（必须是绝对路径）> 设置里的默认工作区。
     * 面板切到别的项目时靠第一档生效——否则会话 cwd 永远压着它。
     */
    const workspace = defaultWorkspace(service);
    const pickCwd = (base, urlObj, body) => pickProject(service, urlObj, body) || pickCwdRaw(base, urlObj, body) || workspace;
    const send = (status, payload) => {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(payload));
    };
    const readBody = async () => {
        if (req.method === 'GET' || req.method === 'HEAD') return {};
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const text = Buffer.concat(chunks).toString('utf8');
        if (text.trim() === '') return {};
        try {
            return JSON.parse(text);
        } catch {
            return {};
        }
    };

    if (route === 'config' || route === '') return send(200, service.describe(cwd));

    // ---- 侧边栏面板：配置读写 ----
    if (route === 'ui' && req.method === 'GET') {
        // sessionCwd 单独传：切了项目之后 pickCwd 已是目标项目，「当前工作区」要靠会话 cwd 推
        return send(200, await service.uiState(pickCwd(cwd, url, {}), { sessionCwd: cwd || workspace }));
    }
    if (route === 'ui/api' && req.method === 'POST') {
        const body = await readBody();
        return send(200, service.saveApiUi(pickCwd(cwd, url, body), asObject(body.api)));
    }
    if (route === 'ui/api/delete' && req.method === 'POST') {
        const body = await readBody();
        return send(200, service.deleteApiUi(pickCwd(cwd, url, body), String(body.id || '')));
    }
    if (route === 'ui/base-url' && req.method === 'POST') {
        const body = await readBody();
        const target = pickCwd(cwd, url, body);
        service.projectStore?.setBaseUrl(target, String(body.baseUrl || ''));
        return send(200, { ok: true });
    }
    if (route === 'ui/token/clear' && req.method === 'POST') {
        const body = await readBody();
        return send(200, service.clearTokenUi(pickCwd(cwd, url, body), String(body.login_id || body.id || '')));
    }

    // ---- 登录并保存 token ----
    if (route === 'login' && req.method === 'POST') {
        const body = await readBody();
        return send(200, await service.login(pickCwd(cwd, url, body), String(body.api_id || ''), asObject(body.params), {
            timeoutMs: body.timeout_ms ? Number(body.timeout_ms) : undefined,
        }));
    }

    // ---- 本机 Java 服务 ----
    if (route === 'java' && req.method === 'GET') {
        return send(200, await service.javaProcesses(pickCwd(cwd, url, {})));
    }
    if (route === 'java/bind' && req.method === 'POST') {
        const body = await readBody();
        return send(200, service.bindJava(pickCwd(cwd, url, body), asObject(body.binding ?? body)));
    }
    if (route === 'java/unbind' && req.method === 'POST') {
        const body = await readBody();
        return send(200, service.unbindJava(pickCwd(cwd, url, body), Number(body.pid || 0)));
    }
    // 接管启动：先编译再杀旧进程（耗时可能几十秒，故不受前端短轮询限制）
    if (route === 'java/start' && req.method === 'POST') {
        const body = await readBody();
        return send(200, await service.startJava(pickCwd(cwd, url, body), {
            pid: Number(body.pid || 0),
            id: body.id ? String(body.id) : '',
            port: body.port ? Number(body.port) : 0,
            compile: body.compile !== false,
            debug: body.debug ? String(body.debug) : 'port',
            timeoutMs: body.timeout_ms ? Number(body.timeout_ms) : undefined,
        }));
    }
    if (route === 'java/stop' && req.method === 'POST') {
        const body = await readBody();
        return send(200, await service.stopJava(pickCwd(cwd, url, body), String(body.id || body.run_id || body.pid || '')));
    }
    if (route === 'java/restart' && req.method === 'POST') {
        const body = await readBody();
        return send(200, await service.restartJava(pickCwd(cwd, url, body), String(body.id || body.run_id || body.pid || ''), {
            compile: body.compile !== false,
            timeoutMs: body.timeout_ms ? Number(body.timeout_ms) : undefined,
        }));
    }
    if (route === 'java/log' && req.method === 'GET') {
        return send(200, service.javaLogs(pickCwd(cwd, url, {}), String(url.searchParams.get('id') || url.searchParams.get('pid') || ''), {
            fromOffset: url.searchParams.has('from') ? Number(url.searchParams.get('from')) : undefined,
            maxBytes: url.searchParams.has('max_bytes') ? Number(url.searchParams.get('max_bytes')) : undefined,
        }));
    }
    // 服务详情：进程信息 + 日志文件清单 + 首屏日志（IDEA 起的进程读它自己的 logback 文件）
    if (route === 'java/detail' && req.method === 'GET') {
        return send(200, await service.javaDetail(pickCwd(cwd, url, {}), String(url.searchParams.get('id') || url.searchParams.get('pid') || ''), {
            fromOffset: url.searchParams.has('from') ? Number(url.searchParams.get('from')) : undefined,
            maxBytes: url.searchParams.has('max_bytes') ? Number(url.searchParams.get('max_bytes')) : undefined,
            lines: url.searchParams.has('lines') ? Number(url.searchParams.get('lines')) : undefined,
            source: url.searchParams.get('source') || '',
        }));
    }
    if (route === 'java/ignore' && req.method === 'POST') {
        const body = await readBody();
        return send(200, service.ignoreJava(pickCwd(cwd, url, body), asObject(body.item || body)));
    }
    if (route === 'java/unignore' && req.method === 'POST') {
        const body = await readBody();
        return send(200, service.unignoreJava(pickCwd(cwd, url, body), asObject(body.item || body)));
    }
    // 保存服务配方：之后不需要先在 IDEA 里跑一个进程也能启动
    if (route === 'java/save' && req.method === 'POST') {
        const body = await readBody();
        return send(200, await service.saveJava(pickCwd(cwd, url, body), { id: String(body.id || body.pid || ''), pid: Number(body.pid) || 0 }));
    }
    if (route === 'java/unsave' && req.method === 'POST') {
        const body = await readBody();
        return send(200, service.deleteSavedJava(pickCwd(cwd, url, body), String(body.id || '')));
    }
    if (route === 'java/start-saved' && req.method === 'POST') {
        const body = await readBody();
        return send(200, await service.startSavedJava(pickCwd(cwd, url, body), String(body.id || ''), {
            compile: body.compile !== false,
            port: Number(body.port) || 0,
            timeoutMs: body.timeout_ms ? Number(body.timeout_ms) : undefined,
        }));
    }
    // 一键启动：后台跑，立刻返回批次 id；面板轮询 java/start-all/status 看进度
    if (route === 'java/start-all' && req.method === 'POST') {
        const body = await readBody();
        return send(200, service.startSavedJavaBatch(pickCwd(cwd, url, body), Array.isArray(body.ids) ? body.ids : [], {
            compile: body.compile !== false,
            restart: body.restart === true,
            timeoutMs: body.timeout_ms ? Number(body.timeout_ms) : undefined,
        }));
    }
    if (route === 'java/start-all/status' && req.method === 'GET') {
        return send(200, service.startBatchStatus(url.searchParams.get('batch') || ''));
    }
    if (route === 'settings' && req.method === 'GET') {
        return send(200, service.settings());
    }
    if (route === 'settings' && req.method === 'POST') {
        const body = await readBody();
        return send(200, service.saveSettings(asObject(body.settings || body)));
    }

    if (route === 'call' && req.method === 'POST') {
        const body = await readBody();
        // 用 pickCwd：面板切到别的项目后，「测试」也要调那个项目的接口
        return send(200, await service.call(pickCwd(cwd, url, body), String(body.api_id || ''), asObject(body.params), {}));
    }

    if (route === 'service' && req.method === 'POST') {
        const body = await readBody();
        const action = String(body.action || 'status');
        const result = action === 'status'
            ? await service.serviceStatus(cwd, body.service_id ? String(body.service_id) : '')
            : await service.serviceAction(cwd, String(body.service_id || ''), action, { timeoutMs: body.timeout_ms });
        return send(200, result);
    }

    if (route === 'log' && req.method === 'GET') {
        const query = Object.fromEntries(url.searchParams.entries());
        return send(200, service.readLog(cwd, query.log_id || '', {
            pattern: query.pattern || '',
            maxLines: query.max_lines ? Number(query.max_lines) : undefined,
            maxBytes: query.max_bytes ? Number(query.max_bytes) : undefined,
            reset: query.reset === 'true' || query.reset === '1',
        }));
    }

    return send(404, { ok: false, code: 'NOT_FOUND', message: `未知路由 ${route}` });
}

// 注意：不要提供 default export（原因见文件头注释）。
