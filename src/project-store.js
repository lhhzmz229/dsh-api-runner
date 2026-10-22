/**
 * 图形界面维护的配置存储（与 YAML 配置分开）。
 *
 * YAML 配置是「手写种子」，本文件是「面板里点出来的配置」，两者按 id 合并，
 * 面板里的同 id 定义覆盖 YAML。存在 ${DSH_HOME}/api-runner-ui.json。
 *
 * 结构：
 * {
 *   version: 1,
 *   projects: {
 *     "<normalizeProjectKey(cwd)>": {
 *       updatedAt, baseUrl,
 *       apis: [ApiDef],           // 面板新建/编辑的接口
 *       logins: [LoginDef],       // 由某个接口派生出来的登录定义
 *       tokens: { <loginId>: { value, masked, savedAt } },   // 登录得到的 token（明文，本机）
 *       bindings: [JavaBinding]   // 关联的本机 Java 服务（pid/端口/主类）
 *     }
 *   }
 * }
 */
import fs from 'node:fs';
import path from 'node:path';
import { isPlainObject, maskSecret, normalizeProjectKey } from './util.js';

const EMPTY_PROJECT = () => ({
    updatedAt: '',
    baseUrl: '',
    apis: [],
    logins: [],
    tokens: {},
    bindings: [],
    ignored: [],
    saved: [],
});

export class ProjectStore {
    constructor(options = {}) {
        this.homeDir = options.homeDir || process.env.DSH_HOME || path.join(process.cwd(), '.dsh');
        this.file = path.join(this.homeDir, 'api-runner-ui.json');
        this._doc = undefined;
        this._mtimeMs = -1;
    }

    /** 项目键：会话工作目录归一化；没有会话时用 default */
    keyOf(cwd) {
        return normalizeProjectKey(cwd) || 'default';
    }

    _load() {
        let stat;
        try {
            stat = fs.statSync(this.file);
        } catch {
            this._doc = { version: 1, projects: {} };
            this._mtimeMs = -1;
            return this._doc;
        }
        if (this._doc !== undefined && stat.mtimeMs === this._mtimeMs) return this._doc;
        try {
            const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            this._doc = isPlainObject(parsed) && isPlainObject(parsed.projects) ? parsed : { version: 1, projects: {} };
        } catch {
            this._doc = { version: 1, projects: {} };
        }
        this._mtimeMs = stat.mtimeMs;
        return this._doc;
    }

    _save(doc) {
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            const tmp = `${this.file}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
            fs.renameSync(tmp, this.file);
            this._doc = doc;
            this._mtimeMs = fs.statSync(this.file).mtimeMs;
        } catch (error) {
            throw new Error(`保存面板配置失败：${error.message}`);
        }
    }

    /** 读一个项目的面板配置（永远返回完整结构，不返回 undefined） */
    project(cwd) {
        const doc = this._load();
        const key = this.keyOf(cwd);
        const raw = doc.projects[key];
        const project = isPlainObject(raw) ? raw : EMPTY_PROJECT();
        return {
            key,
            updatedAt: String(project.updatedAt || ''),
            baseUrl: String(project.baseUrl || ''),
            apis: Array.isArray(project.apis) ? project.apis.filter(isPlainObject) : [],
            logins: Array.isArray(project.logins) ? project.logins.filter(isPlainObject) : [],
            tokens: isPlainObject(project.tokens) ? project.tokens : {},
            bindings: Array.isArray(project.bindings) ? project.bindings.filter(isPlainObject) : [],
            ignored: Array.isArray(project.ignored) ? project.ignored.filter(isPlainObject) : [],
            saved: Array.isArray(project.saved) ? project.saved.filter(isPlainObject) : [],
        };
    }

    /**
     * 所有项目的原始配置（含接口列表）。
     *
     * 面板要按项目列出接口时用这个；调用方负责裁剪字段，
     * 不要把 token 明文往响应里带（这里只带 tokens 的脱敏记录，取明文走 tokenValue）。
     */
    allProjects() {
        const doc = this._load();
        return Object.keys(doc.projects || {}).map((key) => {
            const project = isPlainObject(doc.projects[key]) ? doc.projects[key] : {};
            return {
                key,
                updatedAt: String(project.updatedAt || ''),
                baseUrl: String(project.baseUrl || ''),
                apis: Array.isArray(project.apis) ? project.apis.filter(isPlainObject) : [],
                saved: Array.isArray(project.saved) ? project.saved.filter(isPlainObject) : [],
                tokens: isPlainObject(project.tokens) ? project.tokens : {},
            };
        }).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    }

    /** 在项目上做一次原子修改：mutate(project) 直接改副本，返回结果写回 */
    update(cwd, mutate) {
        const doc = this._load();
        const key = this.keyOf(cwd);
        const current = this.project(cwd);
        const project = { ...current };
        delete project.key;
        mutate(project);
        project.updatedAt = new Date().toISOString();
        doc.version = 1;
        doc.projects[key] = project;
        this._save(doc);
        return this.project(cwd);
    }

    // ---- 接口 ----
    /** 项目级 baseUrl：面板顶部一个输入框，接口没单独填时用它 */
    setBaseUrl(cwd, baseUrl) {
        const value = String(baseUrl || '').trim();
        return this.update(cwd, (project) => {
            project.baseUrl = value.replace(/\/+$/, '');
        });
    }

    saveApi(cwd, api) {
        const id = String(api.id || '').trim();
        if (!id) throw new Error('接口 id 不能为空');
        return this.update(cwd, (project) => {
            const list = project.apis.filter((item) => String(item.id) !== id);
            list.push({ ...api, id, source: 'ui' });
            project.apis = list;
        });
    }

    /**
     * 面板接口的 login.tokenPath 自动纠正：登录成功但配置的 tokenPath 取不到值时，
     * 把探测到的真实路径写回接口定义，避免每次登录都重复警告。
     */
    setApiTokenPath(cwd, id, tokenPath) {
        return this.update(cwd, (project) => {
            project.apis = project.apis.map((item) => (
                String(item.id) === String(id)
                    ? { ...item, login: { ...(item.login || {}), tokenPath } }
                    : item
            ));
        });
    }

    deleteApi(cwd, id) {
        return this.update(cwd, (project) => {
            project.apis = project.apis.filter((item) => String(item.id) !== String(id));
        });
    }

    // ---- 登录定义 ----
    saveLogin(cwd, login) {
        const id = String(login.id || '').trim();
        if (!id) throw new Error('登录 id 不能为空');
        return this.update(cwd, (project) => {
            const list = project.logins.filter((item) => String(item.id) !== id);
            list.push({ ...login, id });
            project.logins = list;
        });
    }

    deleteLogin(cwd, id) {
        return this.update(cwd, (project) => {
            project.logins = project.logins.filter((item) => String(item.id) !== String(id));
            delete project.tokens[String(id)];
        });
    }

    // ---- token ----
    /** 保存 token（只在这里落明文；对外一律给脱敏值） */
    saveToken(cwd, loginId, token) {
        const value = String(token || '');
        return this.update(cwd, (project) => {
            project.tokens[String(loginId)] = {
                value,
                masked: maskSecret(value),
                savedAt: new Date().toISOString(),
            };
        });
    }

    clearToken(cwd, loginId) {
        return this.update(cwd, (project) => {
            delete project.tokens[String(loginId)];
        });
    }

    /** 对外展示用的 token 状态：绝不返回明文 */
    tokenStatus(cwd) {
        const project = this.project(cwd);
        const out = {};
        for (const [id, record] of Object.entries(project.tokens)) {
            out[id] = { hasToken: true, masked: record?.masked || '', savedAt: record?.savedAt || '' };
        }
        return out;
    }

    /** 内部用：取 token 明文（只在真正发请求时调用，不要往响应里带） */
    tokenValue(cwd, loginId) {
        const project = this.project(cwd);
        const record = project.tokens[String(loginId)];
        return record?.value ? String(record.value) : '';
    }

    /** 当前已保存 token 的登录 id 列表 */
    tokenIds(cwd) {
        return Object.keys(this.project(cwd).tokens);
    }

    // ---- Java 服务关联 ----
    bindJava(cwd, binding) {
        const pid = Number(binding.pid);
        if (!Number.isInteger(pid) || pid <= 0) throw new Error('pid 非法');
        return this.update(cwd, (project) => {
            const list = project.bindings.filter((item) => Number(item.pid) !== pid);
            list.push({
                pid,
                port: Number(binding.port) || 0,
                mainClass: String(binding.mainClass || ''),
                commandLine: String(binding.commandLine || ''),
                boundAt: new Date().toISOString(),
            });
            project.bindings = list;
        });
    }

    unbindJava(cwd, pid) {
        return this.update(cwd, (project) => {
            project.bindings = project.bindings.filter((item) => Number(item.pid) !== Number(pid));
        });
    }

    // ---- 保存的服务（不依赖 IDEA 也能启动） ----
    //
    // 存的是「怎么把这个服务拉起来」的完整配方：javaExe / classpath / 主类 /
    // JVM 参数 / 程序参数 / 工作目录 / 模块。有了它，插件不必先等 IDEA 起一个进程
    // 才能接管——直接按配方编译 + 拉起就行。
    saveJava(cwd, recipe = {}) {
        const id = String(recipe.id || '').trim();
        if (!id) throw new Error('保存服务需要 id');
        if (!recipe.mainClass || !recipe.classPath) throw new Error('保存服务需要主类与 classpath（先接管一次再保存）');
        return this.update(cwd, (project) => {
            const list = project.saved.filter((item) => String(item.id) !== id);
            list.push({
                id,
                name: String(recipe.name || id),
                mainClass: String(recipe.mainClass),
                classPath: String(recipe.classPath),
                jvmArgs: Array.isArray(recipe.jvmArgs) ? recipe.jvmArgs.map(String) : [],
                programArgs: Array.isArray(recipe.programArgs) ? recipe.programArgs.map(String) : [],
                javaExe: String(recipe.javaExe || ''),
                javaHome: String(recipe.javaHome || ''),
                cwd: String(recipe.cwd || ''),
                port: Number(recipe.port) || 0,
                debugPort: Number(recipe.debugPort) || 0,
                module: isPlainObject(recipe.module) ? {
                    rootDir: String(recipe.module.rootDir || ''),
                    artifactId: String(recipe.module.artifactId || ''),
                } : null,
                savedAt: new Date().toISOString(),
            });
            project.saved = list;
        });
    }

    deleteJava(cwd, id) {
        return this.update(cwd, (project) => {
            project.saved = project.saved.filter((item) => String(item.id) !== String(id));
        });
    }

    savedJava(cwd, id) {
        const list = this.project(cwd).saved;
        if (id === undefined) return list;
        return list.find((item) => String(item.id) === String(id));
    }

    // ---- 忽略的服务 ----
    //
    // 按 mainClass（拿不到时用名字）记，pid 每次重启都会变，不能拿 pid 当 key。
    // 忽略只是「不在列表里显示」，不影响进程本身。
    ignoreJava(cwd, target) {
        const key = javaKeyOf(target);
        if (!key) throw new Error('缺少服务标识');
        return this.update(cwd, (project) => {
            const list = project.ignored.filter((item) => javaKeyOf(item) !== key);
            list.push({
                key,
                name: String(target.name || ''),
                mainClass: String(target.mainClass || ''),
                kind: String(target.kind || ''),
                ignoredAt: new Date().toISOString(),
            });
            project.ignored = list;
        });
    }

    unignoreJava(cwd, target) {
        const key = javaKeyOf(target);
        return this.update(cwd, (project) => {
            project.ignored = project.ignored.filter((item) => javaKeyOf(item) !== key);
        });
    }
}

/** 忽略项的身份键：主类优先，其次名字（两者都能跨重启保持不变） */
export function javaKeyOf(target = {}) {
    return String(target.mainClass || target.name || target.key || '').trim();
}
