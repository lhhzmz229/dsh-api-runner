/**
 * dsh-api-runner 侧边栏面板（Client half）。
 *
 * 这是给 DSH Web 前端加载的**经典脚本**（不是 ESM）：由 client-modules 注入
 * window.__ModuleLoader__，我们把自己的 factory 注册进去，由它提供 require。
 * 导出 inject / apply，与 host half 的 ESM 形态不同，不要混用。
 *
 * 视觉：与 dsh-db-tool 一致的「inset grouped / iOS 分段控件」风格——
 *   · 顶部整条分段控件（接口 / 服务 / 设置）
 *   · 卡片用半透明灰膜 + 大圆角，不用描边
 *   · 输入框无边框、填充式；按钮为胶囊填充
 *   · 列表一张卡片多行，行间 hairline
 * 颜色：中性色用 rgba 灰膜（明暗主题都成立），强调色/状态色优先取
 * --dsw-alias-* 主题 token，取不到时回落到固定色；不写死正文文字色，直接继承。
 */
window.__ModuleLoader__.load({
    id: 'dsh-api-runner',
    factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;

        const React = require('react');
        const h = React.createElement;

        const TAB_ID = 'dsh-api-runner';
        const API = '/dsh-api-runner/api';
        const STYLE_ID = 'dsh-api-runner-style';
        const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];

        // ---------------------------------------------------------------- 样式
        const CSS = `
.ar-root { display: flex; flex-direction: column; height: 100%; min-height: 0; min-width: 0; box-sizing: border-box;
  font-size: 13px; line-height: 1.45; -webkit-font-smoothing: antialiased;
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif;
  --ar-accent: var(--dsw-alias-brand-primary, #0a84ff);
  --ar-surface: rgba(120, 120, 128, .12);
  --ar-surface-strong: rgba(120, 120, 128, .18);
  --ar-sep: rgba(120, 120, 128, .22);
  --ar-danger: var(--dsw-alias-state-error-primary, #ff453a);
  --ar-success: var(--dsw-alias-state-success-primary, #30d158);
  --ar-warn: var(--dsw-alias-state-warn-primary, #ffd60a);
  --ar-r-card: 12px;
  --ar-r-ctrl: 8px;
  --ar-r-pill: 6px;
  --ar-mono: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  --ar-ease: cubic-bezier(.25, .1, .25, 1);
}
@media (prefers-color-scheme: light) {
  .ar-root { --ar-surface: rgba(120, 120, 128, .09); --ar-surface-strong: rgba(120, 120, 128, .15);
    --ar-sep: rgba(60, 60, 67, .16);
    --ar-danger: var(--dsw-alias-state-error-primary, #ff3b30);
    --ar-success: var(--dsw-alias-state-success-primary, #34c759);
    --ar-warn: var(--dsw-alias-state-warn-primary, #ff9f0a); }
}

/* ---- 顶部：整条分段控件 ---- */
.ar-top { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; padding: 10px 12px 8px; }
.ar-tabs { flex: 1 1 auto; display: flex; gap: 2px; padding: 2px; min-width: 0;
  background: var(--ar-surface); border-radius: var(--ar-r-ctrl); }
.ar-tab { flex: 1 1 0; min-width: 0; display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  border: 0; background: transparent; color: inherit; cursor: pointer; padding: 5px 8px; font: inherit; font-size: 12.5px;
  border-radius: var(--ar-r-pill); white-space: nowrap; opacity: .68;
  transition: background-color .18s var(--ar-ease), opacity .18s var(--ar-ease), box-shadow .18s var(--ar-ease); }
.ar-tab:hover { opacity: .9; }
.ar-tab.on { opacity: 1; font-weight: 600; background: var(--ar-surface-strong); box-shadow: 0 1px 3px rgba(0, 0, 0, .12); }
.ar-count { font-size: 10px; font-weight: 600; line-height: 1; padding: 2px 4px; border-radius: 4px;
  background: var(--ar-surface-strong); opacity: .85; }
.ar-tab.on .ar-count { background: var(--ar-accent); color: #fff; opacity: 1; }

.ar-body { flex: 1 1 auto; min-height: 0; min-width: 0; overflow-y: auto; padding: 2px 12px 24px;
  display: flex; flex-direction: column; gap: 10px; }
.ar-pane { display: flex; flex-direction: column; gap: 10px; min-width: 0; }

/* ---- 排版 ---- */
.ar-mono { font-family: var(--ar-mono); }
.ar-muted { opacity: .6; }
.ar-faint { opacity: .45; }
.ar-cut { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ar-spacer { flex: 1 1 auto; min-width: 0; }
.ar-row { display: flex; align-items: center; gap: 6px; }

/* 分组标题：一行小标题 + 右延细线 */
.ar-sec { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
.ar-sec .t { font-size: 12.5px; font-weight: 600; letter-spacing: .01em; opacity: .72; white-space: nowrap; }
.ar-sec::after { content: ''; flex: 1 1 auto; height: 1px; background: var(--ar-sep); }

/* 二级页签：和顶部同一套分段控件，但用颜色区分层级——
   顶部（接口/服务/设置）是灰底 + 灰白选中块，二级（已接管/运行中/…、项目分类）去掉灰底容器、
   选中态用品牌色实心块。这样一眼能看出「当前在哪一层」，不会和顶部混成同一排。
   注意：选中态用实心 accent 而不是半透明混合，避免依赖 color-mix，浅色/深色主题都稳。 */
.ar-tabs.sub { flex: none; background: transparent; padding: 0; gap: 4px; }
.ar-tabs.sub .ar-tab { padding: 4px 8px; font-size: 12px; background: var(--ar-surface); opacity: .72; }
.ar-tabs.sub .ar-tab:hover { opacity: .95; }
.ar-tabs.sub .ar-tab.on {
  background: var(--ar-accent); color: #fff; opacity: 1; font-weight: 600;
  box-shadow: 0 1px 3px rgba(0, 0, 0, .18);
}
.ar-tabs.sub .ar-count { font-size: 9.5px; padding: 1px 4px; background: var(--ar-surface-strong); opacity: .9; }
.ar-tabs.sub .ar-tab.on .ar-count { background: rgba(255, 255, 255, .26); color: #fff; opacity: 1; }
/* 项目多的时候横向滚动，不换行、不压扁页签 */
.ar-tabs.ar-projects { overflow-x: auto; scrollbar-width: none; }
.ar-tabs.ar-projects::-webkit-scrollbar { display: none; }
.ar-tabs.ar-projects .ar-tab { flex: 0 0 auto; max-width: 132px; }
.ar-tabs.ar-projects .ar-tab .l { min-width: 0; overflow: hidden; text-overflow: ellipsis; }

/* ---- inset grouped 卡片 ---- */
.ar-card { display: flex; flex-direction: column; gap: 9px; padding: 12px;
  background: var(--ar-surface); border: 0; border-radius: var(--ar-r-card); }
.ar-group { display: flex; flex-direction: column; background: var(--ar-surface);
  border-radius: var(--ar-r-card); overflow: hidden; }
.ar-item { display: flex; flex-direction: column; gap: 6px; padding: 11px 12px;
  transition: background-color .15s var(--ar-ease); }
.ar-item + .ar-item { border-top: 1px solid var(--ar-sep); }
.ar-head { display: flex; align-items: flex-start; gap: 8px; }
.ar-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.ar-name { font-size: 13px; font-weight: 600; }

/* ---- 徽章 / 方法标 ---- */
.ar-badge { display: inline-flex; align-items: center; height: 18px; padding: 0 6px; border-radius: var(--ar-r-pill);
  font-size: 11px; font-weight: 500; white-space: nowrap; line-height: 1;
  background: var(--ar-surface-strong); opacity: .9; }
.ar-badge.ok { color: var(--ar-success); background: rgba(48, 209, 88, .14); opacity: 1; }
.ar-badge.warn { color: var(--ar-warn); background: rgba(255, 214, 10, .14); opacity: 1; }
.ar-badge.err { color: var(--ar-danger); background: rgba(255, 69, 58, .14); opacity: 1; }
.ar-badge.brand { color: var(--ar-accent); background: rgba(10, 132, 255, .14); opacity: 1; }
.ar-m { display: inline-flex; align-items: center; justify-content: center; flex: none;
  min-width: 46px; height: 19px; padding: 0 5px; border-radius: 5px;
  font-family: var(--ar-mono); font-size: 10.5px; font-weight: 700; letter-spacing: .02em; }
.ar-m.get { color: #0a84ff; background: rgba(10, 132, 255, .14); }
.ar-m.post { color: #34c759; background: rgba(52, 199, 89, .16); }
.ar-m.put, .ar-m.patch { color: #ff9f0a; background: rgba(255, 159, 10, .16); }
.ar-m.del { color: #ff3b30; background: rgba(255, 59, 48, .14); }

/* ---- 地址：host 弱、path 强 ---- */
.ar-url { font-family: var(--ar-mono); font-size: 11.5px; overflow-wrap: anywhere; }
.ar-url .h { opacity: .5; }
.ar-url .p { opacity: .95; }

/* ---- 按钮：胶囊填充 ---- */
.ar-btn { display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  border: 0; border-radius: var(--ar-r-ctrl); padding: 5px 12px; font: inherit; font-size: 12.5px; font-weight: 500;
  cursor: pointer; white-space: nowrap; color: inherit; background: var(--ar-surface);
  transition: background-color .18s var(--ar-ease), filter .18s var(--ar-ease), transform .18s var(--ar-ease), opacity .18s var(--ar-ease); }
.ar-btn:active:not(:disabled) { transform: scale(.97); }
.ar-btn:disabled { opacity: .38; cursor: default; transform: none; }
.ar-btn.primary { background: var(--ar-accent); color: #fff; }
.ar-btn.tonal { background: var(--ar-surface-strong); }
.ar-btn.ghost { background: transparent; opacity: .62; padding: 5px 9px; }
.ar-btn.danger { color: var(--ar-danger); }
.ar-btn.icon { padding: 5px; width: 28px; }
@media (hover: hover) and (pointer: fine) {
  .ar-btn:hover:not(:disabled) { background: var(--ar-surface-strong); }
  .ar-btn.primary:hover:not(:disabled) { filter: brightness(1.08); background: var(--ar-accent); }
  .ar-btn.ghost:hover:not(:disabled) { background: var(--ar-surface); opacity: .95; }
  .ar-btn.danger:hover:not(:disabled) { background: rgba(255, 69, 58, .12); }
  .ar-item:hover { background: var(--ar-surface-strong); }
}

/* ---- 表单：无边框填充 ---- */
.ar-field { display: grid; grid-template-columns: 58px minmax(0, 1fr); gap: 8px; align-items: center; }
.ar-field.top { align-items: start; }
.ar-field > label { font-size: 12px; opacity: .62; }
.ar-field.top > label { padding-top: 7px; }
.ar-in, .ar-sel, .ar-ta { width: 100%; box-sizing: border-box; font: inherit; font-size: 13px;
  color: inherit; background: var(--ar-surface-strong); border: 0; border-radius: var(--ar-r-ctrl);
  padding: 6px 10px; outline: 2px solid transparent; outline-offset: -1px;
  transition: outline-color .18s var(--ar-ease); }
.ar-in, .ar-sel { height: 30px; padding-top: 0; padding-bottom: 0; }
.ar-sel { cursor: pointer; }
.ar-ta { min-height: 60px; resize: vertical; font-family: var(--ar-mono); font-size: 12px; line-height: 1.5; }
.ar-in:focus, .ar-sel:focus, .ar-ta:focus { outline-color: var(--ar-accent); }
.ar-in::placeholder, .ar-ta::placeholder { color: inherit; opacity: .38; }
.ar-check { display: flex; align-items: center; gap: 7px; cursor: pointer; font-size: 13px; }
.ar-check input { width: 15px; height: 15px; margin: 0; accent-color: var(--ar-accent); cursor: pointer; flex: none; }
.ar-hint { font-size: 11.5px; opacity: .55; line-height: 1.55; }

/* ---- 提示条 ---- */
.ar-banner { display: flex; align-items: flex-start; gap: 7px; padding: 8px 11px;
  border-radius: var(--ar-r-ctrl); font-size: 12.5px; line-height: 1.5;
  background: var(--ar-surface); }
.ar-banner > span { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
/* 关闭按钮做成「纯文字 ×」：无边框无底色，颜色跟着提示条走，位置钉在最后一行右侧 */
.ar-banner > .ar-x { flex: none; margin-left: auto; align-self: center;
  appearance: none; -webkit-appearance: none; border: 0 none; background: none; box-shadow: none;
  color: inherit; cursor: pointer; font-family: inherit; font-size: 15px; line-height: 1;
  padding: 0 1px 2px; border-radius: 4px; opacity: .55;
  transition: opacity .16s var(--ar-ease); }
.ar-banner > .ar-x:hover { opacity: .95; }
.ar-banner > .ar-x:focus-visible { outline: 1px solid currentColor; outline-offset: 1px; opacity: .95; }
.ar-banner.err { color: var(--ar-danger); background: rgba(255, 69, 58, .12); }
.ar-banner.ok { color: var(--ar-success); background: rgba(52, 199, 89, .12); }

/* ---- 响应查看 ---- */
.ar-pre { margin: 0; padding: 10px 11px; border-radius: var(--ar-r-ctrl);
  background: var(--ar-surface-strong); font-family: var(--ar-mono); font-size: 12px; line-height: 1.55;
  white-space: pre-wrap; overflow-wrap: anywhere; max-height: 320px; overflow: auto; }
.ar-seg { display: flex; gap: 2px; padding: 2px; background: var(--ar-surface); border-radius: var(--ar-r-pill); }
.ar-seg > button { border: 0; background: transparent; color: inherit; cursor: pointer; font: inherit; font-size: 11.5px;
  padding: 3px 9px; border-radius: 5px; opacity: .62; transition: background-color .18s var(--ar-ease), opacity .18s var(--ar-ease); }
.ar-seg > button:hover { opacity: .9; }
.ar-seg > button.on { opacity: 1; font-weight: 600; background: var(--ar-surface-strong); }

/* ---- 空态 ---- */
.ar-empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 30px 16px; text-align: center; }
.ar-empty-icon { font-size: 22px; opacity: .3; line-height: 1; }
.ar-empty-title { font-size: 13px; font-weight: 600; }
.ar-empty-hint { font-size: 12px; opacity: .55; line-height: 1.6; max-width: 230px; }

/* ---- 键值行 ---- */
.ar-kv { display: flex; align-items: baseline; gap: 8px; font-size: 12px; }
.ar-kv > .k { flex: 0 0 55px; opacity: .55; }
.ar-kv > .v { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }

/* ---- 服务详情 / 实时日志 ---- */
.ar-detail { display: flex; flex-direction: column; gap: 9px; min-width: 0; }
.ar-detail-head { display: flex; align-items: center; gap: 7px; min-width: 0; }
.ar-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--ar-success); }
.ar-dot.off { background: var(--ar-danger); }
/* 已忽略的服务整体压暗，但仍可操作（取消忽略） */
.ar-ignored { opacity: .55; }
/* 日志容器：宽度必须被父级约束住，否则 flex 的 min-width:auto 会让它按内容撑开，
   看起来就像「不换行」（踩过：只设 white-space:pre-wrap 但父级没 min-width:0 时无效）。 */
.ar-log { margin: 0; padding: 10px 11px; border-radius: var(--ar-r-ctrl); width: 100%; box-sizing: border-box;
  background: var(--ar-surface-strong); font-family: var(--ar-mono); font-size: 11.5px; line-height: 1.62;
  white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word;
  max-height: 58vh; min-height: 140px; overflow-y: auto; overflow-x: hidden; tab-size: 4; }
.ar-log.nowrap { white-space: pre; overflow-wrap: normal; word-break: normal; overflow-x: auto; }
.ar-log:empty::before { content: '（暂无日志输出）'; opacity: .45; }

@media (prefers-reduced-motion: reduce) {
  .ar-root * { transition: none !important; animation: none !important; }
}
`;

        /**
         * 插入样式表。
         * 优先用宿主给动态 Client half 的 styles.insert（由 DSH 管理生命周期、
         * 保证插到正确的文档根）；取不到才退回 document.head，与 dsh-db-tool 同法。
         */
        function installStyles(ctx) {
            let api;
            if (typeof styles !== 'undefined' && styles && typeof styles.insert === 'function') api = styles;
            else if (ctx && typeof ctx.get === 'function') api = ctx.get('styles');
            if (api && typeof api.insert === 'function') {
                api.insert(CSS);
                return;
            }
            if (document.getElementById(STYLE_ID)) return;
            const el = document.createElement('style');
            el.id = STYLE_ID;
            el.textContent = CSS;
            (document.head || document.documentElement).appendChild(el);
        }

        // ---------------------------------------------------------------- 工具
        async function request(path, init) {
            const res = await fetch(`${API}/${path}`, init);
            let data;
            try {
                data = await res.json();
            } catch {
                data = undefined;
            }
            if (res.status === 401) throw new Error('需要先登录 DSH 网页端（请求未通过鉴权）');
            if (!data) throw new Error(`接口无 JSON 响应（HTTP ${res.status}）`);
            return data;
        }

        async function copyText(text) {
            try {
                await navigator.clipboard.writeText(text);
                return true;
            } catch {
                return false;
            }
        }

        function pretty(value) {
            try {
                return JSON.stringify(value, null, 2);
            } catch {
                return String(value);
            }
        }

        function byteSize(value) {
            try {
                const text = typeof value === 'string' ? value : JSON.stringify(value);
                const bytes = new TextEncoder().encode(text || '').length;
                return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
            } catch {
                return '';
            }
        }

        function splitUrl(url) {
            const text = String(url || '');
            const match = /^([a-z]+:\/\/[^/]+)([\s\S]*)$/i.exec(text);
            if (!match) return { host: '', path: text };
            return { host: match[1], path: match[2] || '/' };
        }

        function methodClass(method) {
            const m = String(method || 'GET').toLowerCase();
            if (m === 'get' || m === 'head') return 'ar-m get';
            if (m === 'post') return 'ar-m post';
            if (m === 'put' || m === 'patch') return 'ar-m put';
            if (m === 'delete') return 'ar-m del';
            return 'ar-m';
        }

        function emptyForm(baseUrl) {
            return {
                id: '', name: '', method: 'GET', url: '', baseUrl: baseUrl || '', description: '',
                headersText: '', bodyText: '', sampleText: '', useToken: '',
                isLogin: false, tokenPath: 'token', authHeader: 'Authorization', prefix: 'Bearer ',
                timeoutMs: 30000,
            };
        }

        function formFromApi(api) {
            return {
                id: api.id,
                name: api.name || api.id,
                method: api.method || 'GET',
                url: api.url || '',
                baseUrl: api.baseUrl || '',
                description: api.description || '',
                headersText: api.headersText || '',
                bodyText: api.bodyText || '',
                sampleText: api.sampleText || '',
                useToken: api.useToken || '',
                isLogin: Boolean(api.isLogin),
                tokenPath: api.tokenPath || 'token',
                authHeader: api.header || 'Authorization',
                prefix: api.prefix === undefined ? 'Bearer ' : api.prefix,
                timeoutMs: api.timeoutMs || 30000,
                source: api.source,
            };
        }

        function parseJsonField(text, label) {
            const trimmed = String(text || '').trim();
            if (trimmed === '') return undefined;
            try {
                return JSON.parse(trimmed);
            } catch (error) {
                throw new Error(`${label} 不是合法 JSON：${error.message}`);
            }
        }

        function placeholderNames(api) {
            const out = new Set(Array.isArray(api.params) ? api.params : []);
            const scan = (value) => {
                if (typeof value === 'string') {
                    for (const match of value.matchAll(/\{([A-Za-z_][A-Za-z0-9_.-]*)\}/g)) out.add(match[1]);
                } else if (Array.isArray(value)) value.forEach(scan);
                else if (value && typeof value === 'object') Object.values(value).forEach(scan);
            };
            scan(api.url);
            scan(api.bodyText);
            return [...out];
        }

        // ---------------------------------------------------------------- 组件
        function Field(props) {
            return h('div', { className: props.top ? 'ar-field top' : 'ar-field' },
                h('label', {}, props.label), props.children);
        }

        /** 提示条：err/ok 用色区分，点 × 可关掉（提示不该一直占着版面） */
        function Banner(props) {
            const { kind, text, onClose } = props;
            if (!text) return null;
            // 用 span 而不是 button：button 会带上浏览器/主题的默认边框底色，跟提示条融不进去
            const close = onClose
                ? h('span', {
                    className: 'ar-x',
                    role: 'button',
                    tabIndex: 0,
                    title: '关闭',
                    'aria-label': '关闭',
                    onClick: onClose,
                    onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClose(); } },
                }, '×')
                : null;
            return h('div', { className: kind ? `ar-banner ${kind}` : 'ar-banner' }, h('span', {}, text), close);
        }

        function Empty(props) {
            return h('div', { className: 'ar-empty' },
                props.icon ? h('div', { className: 'ar-empty-icon' }, props.icon) : null,
                h('div', { className: 'ar-empty-title' }, props.title),
                props.hint ? h('div', { className: 'ar-empty-hint' }, props.hint) : null,
                props.action || null);
        }

        function Url(props) {
            const parts = splitUrl(props.value);
            return h('div', { className: 'ar-url', title: props.value },
                parts.host ? h('span', { className: 'h' }, parts.host) : null,
                h('span', { className: 'p' }, parts.path));
        }

        /**
         * 项目 key 是归一化后的绝对路径，页签上只给末段目录名，够区分又不占地方。
         * 末段撞车（两个都叫 api）时退回上一级，避免两个页签长一样。
         */
        function projectLabel(key, allKeys) {
            const parts = String(key || '').split('/').filter(Boolean);
            if (parts.length === 0) return key || 'default';
            const last = parts[parts.length - 1];
            const dup = (allKeys || []).filter((item) => {
                const other = String(item || '').split('/').filter(Boolean);
                return other.length > 0 && other[other.length - 1] === last;
            });
            return dup.length > 1 && parts.length > 1 ? `${parts[parts.length - 2]}/${last}` : last;
        }

        function ApiRow(props) {
            const { api, tokens, busy, onTest, onLogin, onEdit, onDelete, onClearToken } = props;
            const tokenId = api.tokenFrom || '';
            const token = tokenId ? tokens[tokenId] : undefined;
            const params = Array.isArray(api.params) ? api.params : [];
            return h('div', { className: 'ar-item' },
                h('div', { className: 'ar-head' },
                    h('span', { className: methodClass(api.method) }, api.method),
                    h('div', { className: 'ar-main' },
                        h('div', { className: 'ar-row', style: { flexWrap: 'wrap', gap: '5px' } },
                            h('span', { className: 'ar-name ar-cut' }, api.name || api.id),
                            api.source === 'file' ? h('span', { className: 'ar-badge', title: '来自 .dsh/api-runner.yml，请在文件里修改' }, 'YAML') : null,
                            api.isLogin ? h('span', { className: 'ar-badge warn' }, '登录') : null,
                            token ? h('span', { className: 'ar-badge ok', title: '调用时会自动带上这个 token' }, token.masked) : null),
                        h(Url, { value: api.url }),
                        api.description ? h('div', { className: 'ar-hint ar-cut', title: api.description }, api.description) : null,
                        params.length > 0 ? h('div', { className: 'ar-hint ar-mono' }, `参数 ${params.join(' · ')}`) : null)),
                // 项目页签切过去之后，行内的测试/登录/编辑/删除都作用于那个项目自己的配置
                // （请求带 project，后端按项目桶读写），所以这里不再有只读分支。
                h('div', { className: 'ar-row' },
                    h('button', { className: 'ar-btn primary', disabled: Boolean(busy), title: '用「示例参数」调用一次', onClick: () => onTest(api) }, '测试'),
                    api.isLogin ? h('button', { className: 'ar-btn tonal', disabled: Boolean(busy), title: '调登录接口并把 token 存起来', onClick: () => onLogin(api) }, '登录并保存') : null,
                    h('span', { className: 'ar-spacer' }),
                    h('button', { className: 'ar-btn ghost icon', title: '复制完整地址', onClick: () => copyText(api.url) }, '⧉'),
                    token ? h('button', { className: 'ar-btn ghost', title: `忘掉 ${tokenId} 的 token`, onClick: () => onClearToken(tokenId) }, '清除 token') : null,
                    h('button', { className: 'ar-btn ghost', onClick: () => onEdit(api) }, '编辑'),
                    api.source === 'file' ? null : h('button', { className: 'ar-btn ghost danger', onClick: () => onDelete(api) }, '删除')),
            );
        }

        function EditForm(props) {
            const { value, onChange, onSave, onCancel, tokens, busy } = props;
            const set = (key, next) => onChange({ ...value, [key]: next });
            const placeholders = placeholderNames(value);
            return h('div', { className: 'ar-card' },
                h('div', { className: 'ar-name' }, value.id ? `编辑 ${value.id}` : '新增接口'),
                h(Field, { label: 'id' }, h('input', { className: 'ar-in', value: value.id, placeholder: '唯一标识，如 login', onChange: (e) => set('id', e.target.value) })),
                h(Field, { label: '名称' }, h('input', { className: 'ar-in', value: value.name, placeholder: '显示名，留空则用 id', onChange: (e) => set('name', e.target.value) })),
                h(Field, { label: '方法' }, h('select', { className: 'ar-sel', value: value.method, onChange: (e) => set('method', e.target.value) },
                    METHODS.map((m) => h('option', { key: m, value: m }, m)))),
                h(Field, { label: '路径' }, h('input', { className: 'ar-in', value: value.url, placeholder: '/auth/login 或完整地址，支持 {id}', onChange: (e) => set('url', e.target.value) })),
                h(Field, { label: 'baseUrl' }, h('input', { className: 'ar-in', value: value.baseUrl, placeholder: '留空则用「设置」里的 baseUrl', onChange: (e) => set('baseUrl', e.target.value) })),
                h(Field, { label: '说明' }, h('input', { className: 'ar-in', value: value.description, onChange: (e) => set('description', e.target.value) })),
                h(Field, { label: '请求头', top: true }, h('textarea', { className: 'ar-ta', value: value.headersText, placeholder: '{"X-Token":"${DEMO_TOKEN}"}', onChange: (e) => set('headersText', e.target.value) })),
                h(Field, { label: 'body', top: true }, h('textarea', { className: 'ar-ta', value: value.bodyText, placeholder: '{"username":"{user}","password":"{pwd}"}', onChange: (e) => set('bodyText', e.target.value) })),
                h(Field, { label: '示例参数', top: true }, h('textarea', { className: 'ar-ta', value: value.sampleText, placeholder: '「测试」按钮用它填 {占位}，如 {"user":"alice"}', onChange: (e) => set('sampleText', e.target.value) })),
                placeholders.length > 0 ? h('div', { className: 'ar-hint ar-mono' }, `占位参数：${placeholders.join(' · ')}`) : null,
                h(Field, { label: '用 token' }, h('select', { className: 'ar-sel', value: value.useToken, onChange: (e) => set('useToken', e.target.value) },
                    h('option', { value: '' }, '自动（项目里只有一个 token 时用它）'),
                    Object.keys(tokens || {}).map((id) => h('option', { key: id, value: id }, `${id}（${tokens[id].masked}）`)))),
                h('label', { className: 'ar-check' },
                    h('input', { type: 'checkbox', checked: value.isLogin, onChange: (e) => set('isLogin', e.target.checked) }),
                    h('span', {}, '这是登录接口，调用成功后保存 token')),
                value.isLogin
                    ? h('div', { className: 'ar-card', style: { background: 'var(--ar-surface-strong)' } },
                        h(Field, { label: 'token 路径' }, h('input', { className: 'ar-in', value: value.tokenPath, placeholder: '响应 JSON 路径，如 data.token', onChange: (e) => set('tokenPath', e.target.value) })),
                        h(Field, { label: '注入头' }, h('input', { className: 'ar-in', value: value.authHeader, placeholder: 'Authorization', onChange: (e) => set('authHeader', e.target.value) })),
                        h(Field, { label: '前缀' }, h('input', { className: 'ar-in', value: value.prefix, placeholder: 'Bearer （不需要就留空）', onChange: (e) => set('prefix', e.target.value) })),
                        h('div', { className: 'ar-hint' }, '留空 token 路径时，会在响应里找形如 *token* 的字段，只有一个就直接用。'))
                    : null,
                h('div', { className: 'ar-row' },
                    h('button', { className: 'ar-btn primary', disabled: Boolean(busy), onClick: () => onSave(value) }, '保存'),
                    h('button', { className: 'ar-btn ghost', onClick: onCancel }, '取消')));
        }

        /**
         * 端口只有一个数字时用户会问「为什么这个服务显示监听两个端口」——
         * 所以每个端口都标上角色：HTTP 业务端口 / 私有协议端口 / 调试端口。
         */
        function Ports(props) {
            const { item } = props;
            const list = Array.isArray(item.portList) ? item.portList : [];
            if (list.length === 0) {
                if (!item.primaryPort) return h('span', { className: 'ar-hint' }, ' · 未监听端口');
                return h('span', { className: 'ar-hint' }, ` · 监听 ${item.primaryPort}`);
            }
            return h('span', { className: 'ar-hint' },
                ' · ',
                list.map((port, index) => h('span', { key: port.port },
                    index > 0 ? ' / ' : '',
                    h('span', {
                        className: port.role === 'http' ? 'ar-mono' : 'ar-mono ar-muted',
                        title: port.reason ? `${port.label}（${port.reason}）` : port.label,
                        style: { fontWeight: port.role === 'http' ? 600 : 400 },
                    }, port.port),
                    h('span', { className: 'ar-muted' }, ` ${port.role === 'http' ? 'HTTP' : port.role === 'sentinel' ? '私有协议' : port.role === 'debug' ? 'debug' : ''}`))));
        }

        function JavaRow(props) {
            const { item, onUseBaseUrl, onTakeOver, onStop, onRestart, onDetail, onIgnore, onUnignore, onSave, busy, muted } = props;
            const profiles = Array.isArray(item.profiles) ? item.profiles : [];
            const managed = item.owner === 'plugin';
            const running = managed ? Boolean(item.alive) : true;
            /** 只有探测到「真的讲 HTTP」的端口才能当接口地址，私有协议/调试端口不能点 */
            const httpPort = item.httpPort || (managed ? item.primaryPort : 0);
            const ignored = Boolean(item.ignored);
            return h('div', { className: muted ? 'ar-item ar-ignored' : 'ar-item' },
                h('div', { className: 'ar-row', style: { flexWrap: 'wrap', gap: '5px' } },
                    httpPort ? h('span', { className: 'ar-badge brand ar-mono' }, `:${httpPort}`) : null,
                    h('span', { className: 'ar-name ar-cut', style: { flex: '0 1 auto' } }, item.name),
                    managed
                        ? h('span', { className: `ar-badge ${running ? 'ok' : ''}`, title: '由插件启动（可停止、可看日志）' }, running ? '插件启动' : '已停止')
                        : item.owner === 'idea'
                            ? h('span', { className: 'ar-badge warn', title: '由 IDEA 启动；插件不能直接重启它，只能「接管」' }, 'IDEA 启动')
                            : h('span', { className: 'ar-badge', title: '不是 IDEA 起的，也不是插件起的' }, '其它'),
                    ignored ? h('span', { className: 'ar-badge', title: '已忽略：在「正在运行」里不显示' }, '已忽略') : null,
                    item.debugPort ? h('span', { className: 'ar-badge', title: '调试端口（jdwp）' }, `debug ${item.debugPort}`) : null,
                    profiles.map((p) => h('span', { key: p, className: 'ar-badge' }, p))),
                h('div', { className: 'ar-hint ar-mono ar-cut', title: item.mainClass || '' }, item.mainClass || ''),
                h('div', { style: { fontSize: '12px' } },
                    h('span', { className: 'ar-hint ar-mono' }, `pid ${item.pid}`),
                    h(Ports, { item }),
                    managed && item.startedAt ? h('span', { className: 'ar-hint' }, ` · 启动于 ${String(item.startedAt).slice(11, 19)}`) : null),
                h('div', { className: 'ar-row', style: { flexWrap: 'wrap' } },
                    httpPort ? h('button', { className: 'ar-btn ghost icon', title: `把项目 baseUrl 设为 http://127.0.0.1:${httpPort}`, onClick: () => onUseBaseUrl(item) }, '⌁') : null,
                    // 「查询详情」= 日志页：托管进程读插件输出，IDEA 进程读它自己的 logback 文件
                    h('button', { className: 'ar-btn tonal', disabled: busy !== '', title: '查看进程信息与日志', onClick: () => onDetail(item) }, '查询详情'),
                    // 被忽略的服务只留「取消忽略」：它不在正常列表里，给启动/停止按钮容易误操作
                    ignored
                        ? null
                        : (managed
                            ? (running
                                ? h('button', { className: 'ar-btn', disabled: busy !== '', onClick: () => onRestart(item) }, '重启')
                                : h('button', { className: 'ar-btn', disabled: busy !== '', onClick: () => onRestart(item) }, '启动'))
                            : h('button', { className: 'ar-btn primary', disabled: busy !== '', title: '结束 IDEA 起的进程，改用插件启动（会先编译，再拉起）；之后就能在插件里停止/重启/看日志', onClick: () => onTakeOver(item) }, '接管启动')),
                    !ignored && managed && running ? h('button', { className: 'ar-btn ghost danger', disabled: busy !== '', onClick: () => onStop(item) }, '停止') : null,
                    // 保存配方：之后即使 IDEA 里没跑，也能直接从这里启动
                    !ignored && onSave && running ? h('button', { className: 'ar-btn ghost', disabled: busy !== '', title: '把这套启动参数（classpath/主类/JVM 参数）存下来，以后不用先在 IDEA 里跑也能启动', onClick: () => onSave(item) }, '保存') : null,
                    h('span', { className: 'ar-spacer' }),
                    ignored
                        ? h('button', { className: 'ar-btn ghost', title: '重新显示在「正在运行」里', onClick: () => onUnignore(item) }, '取消忽略')
                        : h('button', { className: 'ar-btn ghost', title: '不再显示在「正在运行」里（不影响进程本身）', onClick: () => onIgnore(item) }, '忽略')));
        }

        /** 已保存的服务：不需要现有进程，按配方直接启动 */
        function SavedRow(props) {
            const { item, busy, onStart, onDelete } = props;
            return h('div', { className: 'ar-item' },
                h('div', { className: 'ar-row', style: { flexWrap: 'wrap', gap: '5px' } },
                    item.port ? h('span', { className: 'ar-badge brand ar-mono' }, `:${item.port}`) : null,
                    h('span', { className: 'ar-name ar-cut', style: { flex: '0 1 auto' } }, item.name || item.id),
                    h('span', { className: 'ar-badge', title: '启动参数已保存' }, '已保存')),
                h('div', { className: 'ar-hint ar-mono ar-cut', title: item.mainClass || '' }, item.mainClass || ''),
                h('div', { className: 'ar-hint ar-mono ar-cut', title: item.module?.rootDir || '' },
                    `${item.module?.artifactId || '未识别模块'}${item.savedAt ? ` · 保存于 ${String(item.savedAt).slice(5, 16).replace('T', ' ')}` : ''}`),
                h('div', { className: 'ar-row', style: { flexWrap: 'wrap' } },
                    h('button', { className: 'ar-btn primary', disabled: busy !== '', title: '编译后按保存的参数拉起（不需要 IDEA 里先有进程）', onClick: () => onStart(item) }, '启动'),
                    h('span', { className: 'ar-spacer' }),
                    h('button', { className: 'ar-btn ghost danger', disabled: busy !== '', onClick: () => onDelete(item) }, '删除')));
        }

        /**
         * 服务详情 = 日志页。
         *
         * 日志来源：
         *   插件托管的进程 → `<数据目录>/java-logs/<服务名>/<时间戳>.log`（插件写的 stdout，
         *                   每次启动一个文件，最接近 IDEA 控制台，也能翻历史几次启动）
         *   IDEA 起的进程 → 它自己的 logback 文件 `<user.dir>/logs/<服务名>/info.log`
         *                   （IDEA 控制台不是文件，拿不到；应用日志内容一样）
         * 按字节偏移增量拉，只在可见时轮询，切走就停。
         */
        function ServiceDetail(props) {
            const { item, visible, get, onClose, onStop, onRestart, onTakeOver, onIgnore, onUnignore, busy } = props;
            const [detail, setDetail] = React.useState(null);
            const [text, setText] = React.useState('');
            const [source, setSource] = React.useState('');
            const [auto, setAuto] = React.useState(true);
            const [wrap, setWrap] = React.useState(true);
            /** 首屏行数：和 IDEA 控制台一样先给最近一段，不够再加 */
            const [lines, setLines] = React.useState(200);
            /** 自定义行数输入框的草稿（回车/失焦生效） */
            const [linesText, setLinesText] = React.useState('');
            const [error, setError] = React.useState('');
            const [loading, setLoading] = React.useState(false);
            const boxRef = React.useRef(null);
            const offsetRef = React.useRef(0);
            const sourceRef = React.useRef('');

            const target = item.runId || item.pid;
            const alive = detail ? detail.alive : Boolean(item.alive) || item.owner !== 'plugin';

            /** 首屏：拿详情（进程信息 + 日志文件清单）并从文件末尾读一段 */
            const load = React.useCallback(async (nextSource, nextLines) => {
                try {
                    setLoading(true);
                    const key = nextSource !== undefined ? nextSource : sourceRef.current || '';
                    const size = Number(nextLines) || lines;
                    const query = `java/detail?id=${encodeURIComponent(target)}&lines=${size}&max_bytes=65536${key ? `&source=${encodeURIComponent(key)}` : ''}`;
                    const data = await get(query);
                    if (!data.ok) {
                        setError(data.message || '读取详情失败');
                        return;
                    }
                    setError('');
                    const log = data.log || {};
                    sourceRef.current = data.source || '';
                    offsetRef.current = log.nextOffset || 0;
                    setSource(data.source || '');
                    setDetail(data);
                    setText(log.text || '');
                } catch (e) {
                    setError(e.message);
                } finally {
                    setLoading(false);
                }
            }, [get, target, lines]);

            /** 增量：只取 offset 之后的新内容，追加到已有文本 */
            const follow = React.useCallback(async () => {
                if (!sourceRef.current) return;
                try {
                    const data = await get(`java/detail?id=${encodeURIComponent(target)}&from=${offsetRef.current}&source=${encodeURIComponent(sourceRef.current)}&max_bytes=262144`);
                    if (!data.ok) return;
                    const log = data.log || {};
                    if (typeof log.nextOffset === 'number') {
                        // 变小说明文件被轮转/截断了，这时整段重来
                        if (log.nextOffset < offsetRef.current) {
                            setText(log.text || '');
                        } else if (log.text) {
                            setText((prev) => (prev + log.text).slice(-400_000));
                        }
                        offsetRef.current = log.nextOffset;
                    }
                    setDetail((prev) => (prev ? { ...data, log: undefined } : data));
                } catch {
                    // 轮询失败不打断阅读，下一轮再试
                }
            }, [get, target]);

            /** 自定义行数：1–5000，回车或失焦时生效 */
            const applyLines = React.useCallback(() => {
                const wanted = Number(String(linesText || '').trim());
                if (!Number.isFinite(wanted) || wanted <= 0) return;
                const size = Math.min(5000, Math.max(1, Math.round(wanted)));
                setLines(size);
                setLinesText('');
                load(sourceRef.current, size);
            }, [linesText, load]);

            React.useEffect(() => {
                offsetRef.current = 0;
                sourceRef.current = '';
                setText('');
                setDetail(null);
                setSource('');
                load('');
            }, [target]);
            React.useEffect(() => {
                if (!visible || !auto || !sourceRef.current) return undefined;
                const timer = setInterval(() => { follow(); }, 1500);
                return () => clearInterval(timer);
            }, [visible, auto, follow, source]);

            // 新内容进来自动滚到底，除非用户往上翻了
            React.useEffect(() => {
                const box = boxRef.current;
                if (!box) return;
                const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
                if (nearBottom) box.scrollTop = box.scrollHeight;
            }, [text]);

            const shown = text.length > 400_000 ? text.slice(-400_000) : text;
            const sources = (detail && Array.isArray(detail.sources) && detail.sources) || [];
            const ports = [detail && detail.portList, detail && detail.ports, item.portList].find((value) => Array.isArray(value)) || [];

            return h('div', { className: 'ar-detail' },
                h('div', { className: 'ar-row' },
                    h('button', { className: 'ar-btn ghost icon', title: '返回列表', onClick: onClose }, '‹'),
                    h('div', { className: 'ar-detail-head', style: { flex: '1 1 auto', minWidth: 0 } },
                        h('span', { className: `ar-dot ${alive ? '' : 'off'}` }),
                        h('span', { className: 'ar-name ar-cut' }, item.name),
                        h('span', { className: 'ar-hint ar-mono' }, alive ? `pid ${detail ? detail.pid : item.pid}` : '已停止')),
                    h('button', { className: 'ar-btn ghost', disabled: loading, onClick: () => load(source) }, '刷新')),
                h('div', { className: 'ar-row', style: { flexWrap: 'wrap' } },
                    (detail && detail.port ? h('span', { className: 'ar-badge brand ar-mono' }, `:${detail.port}`) : null),
                    ports.map((p) => h('span', {
                        key: p.port,
                        className: `ar-badge ${p.role === 'http' ? 'brand' : ''}`,
                        title: p.reason ? `${p.label}（${p.reason}）` : p.label,
                    }, `${p.port} ${p.role === 'http' ? 'HTTP' : p.role === 'sentinel' ? '私有协议' : p.role === 'debug' ? 'debug' : ''}`)),
                    (detail && detail.debugPort ? h('span', { className: 'ar-badge' }, `debug ${detail.debugPort}`) : null),
                    (Array.isArray(detail && detail.profiles) ? detail.profiles : []).map((p) => h('span', { key: p, className: 'ar-badge' }, p)),
                    h('span', { className: 'ar-spacer' }),
                    h('button', { className: `ar-btn ${auto ? 'tonal' : 'ghost'}`, title: '每 1.5 秒增量拉取新日志', onClick: () => setAuto(!auto) }, auto ? '自动刷新 开' : '自动刷新 关')),
                // 有多个日志文件（info.log / error.log / 插件输出）时让用户切换
                sources.length > 1
                    ? h('div', { className: 'ar-row', style: { flexWrap: 'wrap' } },
                        sources.map((s) => h('button', {
                            key: s.key,
                            className: `ar-btn ${s.key === source ? 'tonal' : 'ghost'}`,
                            title: s.path,
                            onClick: () => { setText(''); offsetRef.current = 0; sourceRef.current = s.key; load(s.key); },
                        }, s.label)))
                    : null,
                h('div', { className: 'ar-row', style: { flexWrap: 'wrap' } },
                    item.owner === 'plugin'
                        ? (alive
                            ? h('span', null,
                                h('button', { className: 'ar-btn', disabled: busy !== '', onClick: () => onRestart(item) }, '重启'),
                                h('button', { className: 'ar-btn ghost danger', disabled: busy !== '', onClick: () => onStop(item) }, '停止'))
                            : h('button', { className: 'ar-btn primary', disabled: busy !== '', onClick: () => onRestart(item) }, '启动'))
                        : h('span', null,
                            // 已忽略的服务只提供「取消忽略」：它不在正常列表里，直接给「接管启动」容易误点
                            item.ignored
                                ? h('button', { className: 'ar-btn ghost', onClick: () => onUnignore(item) }, '取消忽略')
                                : h('span', null,
                                    h('button', { className: 'ar-btn primary', disabled: busy !== '', onClick: () => onTakeOver(item) }, '接管启动'),
                                    h('button', { className: 'ar-btn ghost', onClick: () => onIgnore(item) }, '忽略'))),
                    h('span', { className: 'ar-spacer' }),
                    detail && detail.cwd ? h('span', { className: 'ar-hint ar-mono ar-cut', title: detail.cwd }, detail.cwd) : null),
                // 日志视图开关：行数（首屏读多少）与自动换行，尽量贴近 IDEA 控制台
                h('div', { className: 'ar-row', style: { flexWrap: 'wrap' } },
                    h('span', { className: 'ar-hint' }, '行数'),
                    [100, 200, 500, 1000].map((n) => h('button', {
                        key: n,
                        className: `ar-btn ${lines === n ? 'tonal' : 'ghost'}`,
                        title: `从文件末尾读最近 ${n} 行`,
                        onClick: () => { setLines(n); load(sourceRef.current, n); },
                    }, String(n))),
                    h('input', {
                        className: 'ar-in ar-mono',
                        style: { width: '64px', flex: 'none' },
                        value: linesText,
                        placeholder: '自定义',
                        title: '自己填行数，回车生效（1–5000）',
                        onChange: (e) => setLinesText(e.target.value.replace(/[^\d]/g, '')),
                        onKeyDown: (e) => { if (e.key === 'Enter') applyLines(); },
                        onBlur: applyLines,
                    }),
                    h('span', { className: 'ar-spacer' }),
                    h('button', {
                        className: `ar-btn ${wrap ? 'tonal' : 'ghost'}`,
                        title: '长日志行是否折行显示（关闭后横向滚动，更接近 IDEA 的竖排对齐）',
                        onClick: () => setWrap(!wrap),
                    }, wrap ? '自动换行 开' : '自动换行 关')),
                h(Banner, { kind: error ? 'err' : '', text: error, onClose: () => setError('') }),
                h(Banner, { text: detail && detail.note ? detail.note : '' }),
                loading && !detail ? h('div', { className: 'ar-hint' }, '读取中…') : null,
                h('pre', { className: wrap ? 'ar-log' : 'ar-log nowrap', ref: boxRef }, shown),
                h('div', { className: 'ar-hint ar-mono ar-cut', title: (detail && detail.log && detail.log.logPath) || '' },
                    detail && detail.log && detail.log.logPath
                        ? `${detail.log.logPath}${detail.log.size ? ` · ${(detail.log.size / 1024).toFixed(1)} KB` : ''}`
                        : '没有可读的日志文件'));
        }

        function ResultCard(props) {
            const { result, onClose } = props;
            const payload = result.payload;
            const [view, setView] = React.useState('body');
            const ok = Boolean(payload.ok);
            const json = payload.json !== undefined ? payload.json : payload.body;
            const views = [
                { id: 'body', label: '响应' },
                { id: 'headers', label: '响应头' },
                { id: 'request', label: '请求' },
            ];
            const content = view === 'headers'
                ? pretty(payload.headers || {})
                : view === 'request'
                    ? pretty({ method: payload.request?.method || '', url: payload.request?.url || payload.url || '', headers: payload.request?.headers || {} })
                    : payload.error
                        ? String(payload.error)
                        : json !== undefined ? pretty(json) : String(payload.body || '');
            return h('div', { className: 'ar-card' },
                h('div', { className: 'ar-row', style: { flexWrap: 'wrap' } },
                    h('span', { className: `ar-badge ${ok ? 'ok' : 'err'}` }, ok ? `HTTP ${payload.status}` : '失败'),
                    typeof payload.durationMs === 'number' ? h('span', { className: 'ar-hint ar-mono' }, `${payload.durationMs} ms`) : null,
                    h('span', { className: 'ar-hint ar-mono' }, byteSize(json !== undefined ? json : payload.body)),
                    h('span', { className: 'ar-spacer' }),
                    h('div', { className: 'ar-seg' }, views.map((v) => h('button', { key: v.id, className: view === v.id ? 'on' : '', onClick: () => setView(v.id) }, v.label))),
                    h('button', { className: 'ar-btn ghost icon', title: '复制这段内容', onClick: () => copyText(content) }, '⧉'),
                    h('button', { className: 'ar-btn ghost icon', title: '关闭', onClick: onClose }, '×')),
                h('div', { className: 'ar-row', style: { minWidth: 0 } },
                    h('span', { className: methodClass(payload.method) }, payload.method || 'GET'),
                    h('div', { style: { flex: '1 1 auto', minWidth: 0 } }, h(Url, { value: payload.url || payload.request?.url || '' })),
                    h('span', { className: 'ar-hint' }, result.apiId)),
                payload.message ? h('div', { className: `ar-banner ${payload.ok ? 'ok' : 'err'}` }, payload.message) : null,
                payload.token ? h('div', { className: 'ar-hint ar-mono' }, `token ${payload.token.masked} · 来自 ${payload.token.from} · 注入 ${payload.token.header}`) : null,
                h('pre', { className: 'ar-pre' }, content));
        }

        // ---------------------------------------------------------------- 面板
        function Panel(props) {
            const scope = props.scope || {};
            const visible = props.visible !== false;
            const cwd = scope.cwd || scope.workspacePath || '';
            const sessionId = scope.sessionId || '';

            const [tab, setTab] = React.useState('apis');
            const [state, setState] = React.useState(null);
            const [java, setJava] = React.useState(null);
            const [error, setError] = React.useState('');
            const [notice, setNotice] = React.useState('');
            const [busy, setBusy] = React.useState('');
            const [form, setForm] = React.useState(null);
            const [result, setResult] = React.useState(null);
            const [baseUrl, setBaseUrl] = React.useState('');
            const [draft, setDraft] = React.useState('');
            const [filter, setFilter] = React.useState('');
            const [detail, setDetail] = React.useState(null);
            /** 接口页二级页签选中的项目：'' 表示跟着会话工作区走 */
            const [projectTab, setProjectTab] = React.useState('');
            /** 服务页二级页签：已接管 / 运行中 / 已保存 / 已忽略 */
            const [group, setGroup] = React.useState('managed');
            /** 用户点过页签之后就不要自动跳了 */
            const groupTouched = React.useRef(false);
            const [settings, setSettings] = React.useState(null);
            const [dataDirDraft, setDataDirDraft] = React.useState('');
            const [workspaceDraft, setWorkspaceDraft] = React.useState('');
            const [mavenHomeDraft, setMavenHomeDraft] = React.useState('');

            const headers = React.useMemo(() => ({ 'Content-Type': 'application/json', 'x-dsh-session-id': sessionId }), [sessionId]);
            const get = React.useCallback(async (path) => {
                const sep = path.includes('?') ? '&' : '?';
                return request(`${path}${sep}cwd=${encodeURIComponent(cwd)}`, { headers });
            }, [cwd, headers]);
            const post = React.useCallback(async (path, body) => {
                return request(path, { method: 'POST', headers, body: JSON.stringify({ ...(body || {}), cwd }) });
            }, [cwd, headers]);

            /**
             * 接口相关的请求带上「接口页」选中的项目。
             *
             * 只有接口这套（ui / call / login）跟项目走；服务与设置永远是会话工作区的事，
             * 否则切到别的项目时「服务」页会突然变空、「设置」也会读到别的项目的值。
             */
            const withProject = (path) => {
                if (!projectTab) return path;
                const sep = path.includes('?') ? '&' : '?';
                return `${path}${sep}project=${encodeURIComponent(projectTab)}`;
            };
            const getApi = React.useCallback(async (path) => {
                const sep = path.includes('?') ? '&' : '?';
                return request(withProject(`${path}${sep}cwd=${encodeURIComponent(cwd)}`), { headers });
            }, [cwd, headers, projectTab]);
            const postApi = React.useCallback(async (path, body) => {
                const extra = projectTab ? { project: projectTab } : {};
                return request(path, { method: 'POST', headers, body: JSON.stringify({ ...(body || {}), ...extra, cwd }) });
            }, [cwd, headers, projectTab]);

            const refresh = React.useCallback(async () => {
                try {
                    const data = await getApi('ui');
                    setState(data);
                    setBaseUrl(data.baseUrl || '');
                    setDraft(data.baseUrl || '');
                    setError('');
                } catch (e) {
                    setError(e.message);
                }
            }, [getApi]);

            const refreshJava = React.useCallback(async () => {
                try {
                    const data = await get('java');
                    setJava(data);
                    return data;
                } catch (e) {
                    setJava({ ok: false, message: e.message, processes: [] });
                    return null;
                }
            }, [get]);

            const refreshSettings = React.useCallback(async () => {
                try {
                    const data = await get('settings');
                    setSettings(data);
                    setDataDirDraft(data.dataDir || '');
                    setWorkspaceDraft(data.workspace || '');
                    setMavenHomeDraft(data.mavenHome || '');
                } catch (e) {
                    setSettings({ ok: false, message: e.message });
                }
            }, [get]);

            React.useEffect(() => {
                if (!visible) return undefined;
                refresh();
                refreshJava();
                refreshSettings();
                const timer = setInterval(() => { refreshJava(); }, 5000);
                return () => clearInterval(timer);
            }, [visible, refresh, refreshJava, refreshSettings]);

            // 成功提示过几秒自己消失，别一直挂在顶上；出错提示留着，等用户处理或手动关掉
            React.useEffect(() => {
                if (!notice) return undefined;
                const timer = setTimeout(() => setNotice(''), 6000);
                return () => clearTimeout(timer);
            }, [notice]);

            const apis = (state && state.apis) || [];
            const tokens = (state && state.tokens) || {};
            const processes = (java && java.processes) || [];
            /** 已保存的配方：没有进程也能启动 */
            const savedList = (java && java.saved) || [];
            const keyword = filter.trim().toLowerCase();
            const shown = keyword === '' ? apis : apis.filter((api) => `${api.id} ${api.name || ''} ${api.url}`.toLowerCase().includes(keyword));
            /**
             * 接口页按项目分类：页签列的是所有已知项目（会话工作区、设置里的默认工作区、
             * 配过接口的项目），切过去就是真的切过去——接口、token、baseUrl 都换，
             * 在那边点测试/登录/新增/编辑/删除也作用于那个项目自己的配置。
             */
            const allProjects = (state && Array.isArray(state.projects)) ? state.projects : [];
            const cwdProjectKey = (state && state.cwdProjectKey) || '';
            /** '' 表示跟随会话工作区；有选中就以选中为准 */
            const activeKey = projectTab || cwdProjectKey;
            /** 选中的项目从清单里消失（目录删了、配置清了）就退回跟随工作区 */
            React.useEffect(() => {
                if (projectTab !== '' && !allProjects.some((item) => item.key === projectTab)) setProjectTab('');
            }, [projectTab, allProjects.length]);
            /** 服务分三组：插件接管过的 / 正在运行的（IDEA 或其它）/ 已忽略的 */
            const managedList = processes.filter((item) => item.owner === 'plugin');
            const ignoredList = processes.filter((item) => item.ignored);
            const runningList = processes.filter((item) => item.owner !== 'plugin' && !item.ignored);

            // 一进来「已接管」是空的、但确实有进程在跑，就直接落在「运行中」，省一次点击；
            // 用户自己点过页签之后就不再干预。
            React.useEffect(() => {
                if (groupTouched.current) return;
                if (managedList.length === 0 && runningList.length > 0) setGroup('running');
            }, [managedList.length, runningList.length]);

            const saveApi = async (value) => {
                setBusy('save');
                setError('');
                try {
                    const api = {
                        id: value.id.trim(),
                        name: value.name.trim() || value.id.trim(),
                        method: value.method,
                        url: value.url.trim(),
                        baseUrl: value.baseUrl.trim(),
                        description: value.description.trim(),
                        headers: parseJsonField(value.headersText, '请求头') || {},
                        body: parseJsonField(value.bodyText, 'body'),
                        sampleParams: parseJsonField(value.sampleText, '示例参数') || {},
                        useToken: value.useToken,
                        timeoutMs: Number(value.timeoutMs) || 30000,
                        login: value.isLogin
                            ? { tokenPath: value.tokenPath.trim() || 'token', header: value.authHeader.trim() || 'Authorization', prefix: value.prefix }
                            : undefined,
                    };
                    if (!api.id) throw new Error('id 不能为空');
                    if (!api.url) throw new Error('url 不能为空');
                    const res = await postApi('ui/api', { api });
                    if (res.ok === false) throw new Error(res.message || '保存失败');
                    setForm(null);
                    setNotice(res.message || '已保存');
                    await refresh();
                } catch (e) {
                    setError(e.message);
                } finally {
                    setBusy('');
                }
            };

            const deleteApi = async (api) => {
                if (!window.confirm(`删除接口 ${api.id}？`)) return;
                setBusy('delete');
                try {
                    const res = await postApi('ui/api/delete', { id: api.id });
                    if (res.ok === false) throw new Error(res.message || '删除失败');
                    if (result && result.apiId === api.id) setResult(null);
                    setNotice(`已删除 ${api.id}`);
                    await refresh();
                } catch (e) {
                    setError(e.message);
                } finally {
                    setBusy('');
                }
            };

            const doCall = async (api, mode) => {
                setBusy(mode === 'login' ? 'login' : 'call');
                setError('');
                setNotice('');
                try {
                    const params = parseJsonField(api.sampleText, '示例参数') || {};
                    const payload = mode === 'login'
                        ? await postApi('login', { api_id: api.id, params })
                        : await postApi('call', { api_id: api.id, params });
                    setResult({ apiId: api.id, mode, payload });
                    if (payload.ok && mode === 'login') {
                        setNotice(payload.message || '已保存 token');
                        await refresh();
                    }
                } catch (e) {
                    setError(e.message);
                } finally {
                    setBusy('');
                }
            };

            const clearToken = async (loginId) => {
                try {
                    await postApi('ui/token/clear', { login_id: loginId });
                    setNotice(`已清除 ${loginId} 的 token`);
                    await refresh();
                } catch (e) {
                    setError(e.message);
                }
            };

            const saveBaseUrl = async () => {
                try {
                    await postApi('ui/base-url', { baseUrl: draft });
                    setNotice('baseUrl 已保存');
                    await refresh();
                } catch (e) {
                    setError(e.message);
                }
            };

            const useBaseUrl = async (item) => {
                try {
                    await postApi('ui/base-url', { baseUrl: item.baseUrl });
                    setNotice(`baseUrl 已设为 ${item.baseUrl}`);
                    await refresh();
                } catch (e) {
                    setError(e.message);
                }
            };

            /** 接管：结束 IDEA 的进程，编译后由插件拉起；之后这个服务就归插件管 */
            const takeOver = async (item) => {
                const ok = window.confirm(
                    `接管 ${item.name}？\n\n` +
                    `1. 先编译（mvn compile，可能要几十秒；失败则不动原进程）\n` +
                    `2. 结束 IDEA 起的进程 pid ${item.pid}\n` +
                    `3. 由插件用同样的启动参数重新拉起，日志写到 ${item.managedLogPath || '本地文件'}\n\n` +
                    `之后这个服务在 IDEA 里会显示为已退出，停止/重启请在插件里操作。`,
                );
                if (!ok) return;
                setBusy('takeover');
                setError('');
                setNotice('');
                try {
                    const payload = await post('java/start', { pid: item.pid, port: item.httpPort || item.primaryPort || 0, compile: true });
                    if (payload.ok) {
                        setNotice(payload.note || `已接管 ${item.name}`);
                        await refreshJava();
                        setDetail({ runId: payload.id || item.name, name: item.name, pid: payload.pid, owner: 'plugin', alive: true });
                    } else {
                        setError(payload.message || '接管失败');
                    }
                    await refresh();
                } catch (e) {
                    setError(e.message);
                } finally {
                    setBusy('');
                }
            };

            const stopRun = async (item) => {
                if (!window.confirm(`停止 ${item.name}（pid ${item.pid}）？之后再启动请回这里点「启动」。`)) return;
                setBusy('stop');
                try {
                    const payload = await post('java/stop', { id: item.runId || item.pid });
                    if (payload.ok) setNotice(payload.message || '已停止');
                    else setError(payload.message || '停止失败');
                    await refreshJava();
                } catch (e) {
                    setError(e.message);
                } finally {
                    setBusy('');
                }
            };

            const restartRun = async (item) => {
                setBusy('restart');
                setError('');
                try {
                    const payload = await post('java/restart', { id: item.runId || item.pid, compile: true });
                    if (payload.ok) setNotice(`已重启 ${item.name}（pid ${payload.pid}）`);
                    else setError(payload.message || '重启失败');
                    await refreshJava();
                } catch (e) {
                    setError(e.message);
                } finally {
                    setBusy('');
                }
            };

            /** 忽略：只记进项目配置，不动进程本身 */
            const ignoreJava = async (item) => {
                try {
                    const payload = await post('java/ignore', { item: { mainClass: item.mainClass, name: item.name, kind: item.kind } });
                    if (payload.ok) setNotice(payload.message || `已忽略 ${item.name}`);
                    else setError(payload.message || '忽略失败');
                    await refreshJava();
                    await refresh();
                } catch (e) {
                    setError(e.message);
                }
            };

            const unignoreJava = async (item) => {
                try {
                    const payload = await post('java/unignore', { item: { mainClass: item.mainClass, name: item.name, kind: item.kind } });
                    if (payload.ok) setNotice(payload.message || `已取消忽略 ${item.name}`);
                    else setError(payload.message || '取消忽略失败');
                    await refreshJava();
                    await refresh();
                } catch (e) {
                    setError(e.message);
                }
            };

            /** 保存配方：把这套启动参数记下来，以后不用先在 IDEA 里跑 */
            const saveJava = async (item) => {
                setBusy('save');
                setError('');
                try {
                    const payload = await post('java/save', { id: item.runId || item.pid, pid: item.pid });
                    if (payload.ok) setNotice(payload.message || '已保存');
                    else setError(payload.message || '保存失败');
                    await refreshJava();
                } catch (e) {
                    setError(e.message);
                } finally {
                    setBusy('');
                }
            };

            const startSaved = async (item) => {
                setBusy('start-saved');
                setError('');
                setNotice('');
                try {
                    const payload = await post('java/start-saved', { id: item.id });
                    if (payload.ok) {
                        setNotice(payload.note || `已启动 ${item.id}（pid ${payload.pid}）`);
                        await refreshJava();
                    } else {
                        setError(payload.message || '启动失败');
                    }
                } catch (e) {
                    setError(e.message);
                } finally {
                    setBusy('');
                }
            };

            const deleteSaved = async (item) => {
                if (!window.confirm(`删除已保存的服务 ${item.id}？（只删除启动配方，不影响正在运行的进程）`)) return;
                setBusy('delete-saved');
                try {
                    const payload = await post('java/unsave', { id: item.id });
                    if (payload.ok) setNotice(`已删除 ${item.id}`);
                    else setError(payload.message || '删除失败');
                    await refreshJava();
                } catch (e) {
                    setError(e.message);
                } finally {
                    setBusy('');
                }
            };

            const saveSettings = async (patch, okText) => {
                setBusy('settings');
                setError('');
                try {
                    const payload = await post('settings', patch);
                    if (!payload.ok) throw new Error(payload.message || '保存失败');
                    setNotice(okText);
                    await refreshSettings();
                    await refreshJava();
                } catch (e) {
                    setError(e.message);
                } finally {
                    setBusy('');
                }
            };

            const tabs = [
                { id: 'apis', label: '接口', count: apis.length },
                { id: 'services', label: '服务', count: runningList.length },
                { id: 'settings', label: '设置', count: 0 },
            ];

            const apisPane = h('div', { className: 'ar-pane' },
                // 项目分段控件：只有一个项目时没有分类的意义，整排省掉，别白占一行
                allProjects.length > 1
                    ? h('div', { className: 'ar-tabs sub ar-projects' },
                        allProjects.map((item) => {
                            const isCurrent = item.key === activeKey;
                            const label = projectLabel(item.key, allProjects.map((p) => p.key));
                            const title = `${item.key}${item.key === cwdProjectKey ? '（会话当前工作区）' : ''}`;
                            return h('button', {
                                key: item.key,
                                className: isCurrent ? 'ar-tab on' : 'ar-tab',
                                title,
                                onClick: () => { setForm(null); setProjectTab(item.key === cwdProjectKey ? '' : item.key); },
                            }, h('span', { className: 'l' }, label), item.apiCount > 0 ? h('span', { className: 'ar-count' }, item.apiCount) : null);
                        }))
                    : null,
                h('div', { className: 'ar-row' },
                    h('input', { className: 'ar-in', value: filter, placeholder: '筛选接口…', onChange: (e) => setFilter(e.target.value) }),
                    form ? null : h('button', { className: 'ar-btn tonal', onClick: () => setForm(emptyForm(baseUrl)) }, '新增')),
                form ? h(EditForm, { value: form, onChange: setForm, onSave: saveApi, onCancel: () => setForm(null), tokens, busy }) : null,
                apis.length === 0 && !form
                    ? h(Empty, {
                        icon: '⌁',
                        title: '还没有接口',
                        hint: '点「新增」在面板里配一个，或在 .dsh/api-runner.yml 里写（YAML 里的接口只能改文件）。',
                        action: h('button', { className: 'ar-btn primary', style: { marginTop: '2px' }, onClick: () => setForm(emptyForm(baseUrl)) }, '新增接口'),
                    })
                    : shown.length === 0
                        ? h('div', { className: 'ar-hint', style: { padding: '8px 2px' } }, `没有匹配「${filter}」的接口。`)
                        : h('div', { className: 'ar-group' }, shown.map((api) => h(ApiRow, {
                            key: api.id, api, tokens, busy,
                            onTest: (item) => doCall(item, 'call'),
                            onLogin: (item) => doCall(item, 'login'),
                            onEdit: (item) => setForm(formFromApi(item)),
                            onDelete: deleteApi,
                            onClearToken: clearToken,
                        }))),
                result ? h(ResultCard, { result, onClose: () => setResult(null) }) : null);

            const servicesPane = detail
                ? h(ServiceDetail, {
                    item: detail,
                    visible,
                    get,
                    busy,
                    onClose: () => { setDetail(null); refreshJava(); },
                    onStop: async (item) => { await stopRun(item); await refreshJava(); },
                    onRestart: async (item) => { await restartRun(item); },
                    onTakeOver: takeOver,
                    onIgnore: ignoreJava,
                    onUnignore: unignoreJava,
                })
                : h('div', { className: 'ar-pane' },
                h('div', { className: 'ar-row' },
                    // 二级页签：和顶部「接口/服务/设置」同一套分段控件，只是小一号
                    h('div', { className: 'ar-tabs sub' }, [
                        { id: 'managed', label: '已接管', count: managedList.length },
                        { id: 'running', label: '运行中', count: runningList.length },
                        { id: 'saved', label: '已保存', count: savedList.length },
                        { id: 'ignored', label: '已忽略', count: ignoredList.length },
                    ].map((item) => h('button', {
                        key: item.id,
                        className: item.id === group ? 'ar-tab on' : 'ar-tab',
                        onClick: () => { groupTouched.current = true; setGroup(item.id); },
                    }, item.label, item.count > 0 ? h('span', { className: 'ar-count' }, item.count) : null))),
                    h('button', { className: 'ar-btn ghost icon', disabled: busy !== '', title: '重新扫描 Java 进程', onClick: refreshJava }, '↻')),
                h(Banner, { kind: 'err', text: java && java.ok === false ? (java.message || '无法读取 Java 进程') : '' }),

                group === 'managed'
                    ? (managedList.length === 0
                        ? h(Empty, {
                            icon: '☕',
                            title: '还没有接管任何服务',
                            hint: '在「正在运行」里选一个 IDEA 起的服务，点「接管启动」，之后就能在这里停止、重启、看日志。',
                            action: h('button', { className: 'ar-btn tonal', style: { marginTop: '2px' }, onClick: () => setGroup('running') }, '去看正在运行的服务'),
                        })
                        : h('div', { className: 'ar-group' }, managedList.map((item) => h(JavaRow, {
                            key: `plugin-${item.runId || item.pid}`,
                            item,
                            busy,
                            onUseBaseUrl: useBaseUrl,
                            onTakeOver: takeOver,
                            onStop: stopRun,
                            onRestart: restartRun,
                            onDetail: (target) => setDetail(target),
                            onIgnore: ignoreJava,
                            onUnignore: unignoreJava,
                            onSave: saveJava,
                        }))))
                    : null,

                group === 'running'
                    ? (runningList.length === 0
                        ? h(Empty, {
                            icon: '☕',
                            title: '没有运行中的 Java 服务',
                            hint: '在 IDEA 里启动一个 Spring Boot 应用，再回来看；已经保存过启动参数的服务可以在「已保存」里直接启动。',
                        })
                        : h('div', { className: 'ar-group' }, runningList.map((item) => h(JavaRow, {
                            key: `run-${item.owner}-${item.runId || item.pid}`,
                            item,
                            busy,
                            onUseBaseUrl: useBaseUrl,
                            onTakeOver: takeOver,
                            onStop: stopRun,
                            onRestart: restartRun,
                            onDetail: (target) => setDetail(target),
                            onIgnore: ignoreJava,
                            onUnignore: unignoreJava,
                            onSave: saveJava,
                        }))))
                    : null,

                group === 'saved'
                    ? (savedList.length === 0
                        ? h(Empty, {
                            icon: '☕',
                            title: '还没有保存的服务',
                            hint: '在「正在运行」里选一个服务点「保存」，把它那套启动参数（classpath/主类/JVM 参数）记下来。以后不用先在 IDEA 里跑，直接在这里启动。',
                            action: h('button', { className: 'ar-btn tonal', style: { marginTop: '2px' }, onClick: () => setGroup('running') }, '去看正在运行的服务'),
                        })
                        : h('div', { className: 'ar-group' }, savedList.map((item) => h(SavedRow, {
                            key: `saved-${item.id}`,
                            item,
                            busy,
                            onStart: startSaved,
                            onDelete: deleteSaved,
                        }))))
                    : null,

                group === 'ignored'
                    ? (ignoredList.length === 0
                        ? h(Empty, { icon: '•', title: '没有已忽略的服务', hint: '不想在「正在运行」里看到的服务，点它右边的「忽略」就会挪到这里，不影响进程本身。' })
                        : h('div', { className: 'ar-group' }, ignoredList.map((item) => h(JavaRow, {
                            key: `ignored-${item.owner}-${item.runId || item.pid}`,
                            item,
                            muted: true,
                            busy,
                            onUseBaseUrl: useBaseUrl,
                            onTakeOver: takeOver,
                            onStop: stopRun,
                            onRestart: restartRun,
                            onDetail: (target) => setDetail(target),
                            onIgnore: ignoreJava,
                            onUnignore: unignoreJava,
                            onSave: saveJava,
                        }))))
                    : null);

            const settingsPane = h('div', { className: 'ar-pane' },
                h('div', null,
                    h('div', { className: 'ar-sec' }, h('span', {}, '数据目录')),
                    h('div', { className: 'ar-card' },
                        h('div', { className: 'ar-hint' },
                            '插件自己的东西（服务日志、状态、面板配置）放这里。默认在 DSH_HOME 下，想换盘就填个绝对路径，保存后新日志立刻写过去。'),
                        h('div', { className: 'ar-row' },
                            h('input', {
                                className: 'ar-in ar-mono',
                                value: dataDirDraft,
                                placeholder: settings?.effectiveDataDir || '绝对路径，例如 <你的目录>/dsh-api-runner-data',
                                onChange: (e) => setDataDirDraft(e.target.value),
                            }),
                            h('button', {
                                className: 'ar-btn primary',
                                disabled: busy !== '' || dataDirDraft === (settings?.dataDir || ''),
                                onClick: () => saveSettings({ dataDir: dataDirDraft }, '数据目录已保存'),
                            }, '保存'),
                            dataDirDraft ? h('button', {
                                className: 'ar-btn ghost',
                                title: '改回默认（DSH_HOME 下）',
                                onClick: () => { setDataDirDraft(''); saveSettings({ dataDir: '' }, '已改回默认数据目录'); },
                            }, '默认') : null),
                        settings && settings.effectiveDataDir
                            ? h('div', { className: 'ar-kv' }, h('span', { className: 'k' }, '当前'), h('span', { className: 'v ar-mono ar-muted ar-cut', title: settings.effectiveDataDir }, settings.effectiveDataDir))
                            : null,
                        settings && settings.settingsFile
                            ? h('div', { className: 'ar-kv' }, h('span', { className: 'k' }, '设置文件'), h('span', { className: 'v ar-mono ar-muted ar-cut', title: settings.settingsFile }, settings.settingsFile))
                            : null)),
                h('div', null,
                    h('div', { className: 'ar-sec' }, h('span', {}, '默认工作区')),
                    h('div', { className: 'ar-card' },
                        h('div', { className: 'ar-hint' },
                            '在没有会话上下文时（比如直接调接口、从工具里启动服务）用它当项目目录。填你的项目根目录，日志和面板配置就会按它归档。'),
                        h('div', { className: 'ar-row' },
                            h('input', {
                                className: 'ar-in ar-mono',
                                value: workspaceDraft,
                                placeholder: '你的项目根目录的绝对路径',
                                onChange: (e) => setWorkspaceDraft(e.target.value),
                            }),
                            h('button', {
                                className: 'ar-btn primary',
                                disabled: busy !== '' || workspaceDraft === (settings?.workspace || ''),
                                onClick: () => saveSettings({ workspace: workspaceDraft }, '默认工作区已保存'),
                            }, '保存')))),
                h('div', null,
                    h('div', { className: 'ar-sec' }, h('span', {}, 'Maven 主路径')),
                    h('div', { className: 'ar-card' },
                        h('div', { className: 'ar-hint' },
                            '接管启动前编译 Java 服务用。留空会自动探测：MAVEN_HOME → PATH → IDEA 自带 Maven（并读取 .idea 里的 settings.xml 和本地仓库）。'),
                        h('div', { className: 'ar-row' },
                            h('input', {
                                className: 'ar-in ar-mono',
                                value: mavenHomeDraft,
                                placeholder: 'Maven 安装目录（到根为止，不含 bin）',
                                onChange: (e) => setMavenHomeDraft(e.target.value),
                            }),
                            h('button', {
                                className: 'ar-btn primary',
                                disabled: busy !== '' || mavenHomeDraft === (settings?.mavenHome || ''),
                                onClick: () => saveSettings({ mavenHome: mavenHomeDraft }, 'Maven 主路径已保存'),
                            }, '保存'),
                            mavenHomeDraft ? h('button', {
                                className: 'ar-btn ghost',
                                title: '清空后恢复自动探测',
                                onClick: () => { setMavenHomeDraft(''); saveSettings({ mavenHome: '' }, '已改回自动探测'); },
                            }, '自动') : null))),
                h('div', null,
                    h('div', { className: 'ar-sec' }, h('span', {}, '接口基地址')),
                    h('div', { className: 'ar-card' },
                        h('div', { className: 'ar-hint' }, '接口自己没填 baseUrl 时用它。在「服务」页签点一下，就能直接设成某个 Java 服务的端口。'),
                        h('div', { className: 'ar-row' },
                            h('input', { className: 'ar-in ar-mono', value: draft, placeholder: 'http://127.0.0.1:8080', onChange: (e) => setDraft(e.target.value) }),
                            h('button', { className: 'ar-btn primary', disabled: draft === baseUrl, onClick: saveBaseUrl }, '保存')))),
                h('div', null,
                    h('div', { className: 'ar-sec' }, h('span', {}, `已保存 token · ${Object.keys(tokens).length}`)),
                    h('div', { className: 'ar-card' },
                        Object.keys(tokens).length === 0
                            ? h('div', { className: 'ar-hint' }, '还没有 token。把登录接口勾成「登录接口」，再点「登录并保存」。')
                            : Object.entries(tokens).map(([id, item]) => h('div', { key: id, className: 'ar-row' },
                                h('span', { className: 'ar-name', style: { flex: '0 0 auto' } }, id),
                                h('span', { className: 'ar-mono ar-muted ar-cut', style: { flex: '1 1 auto', fontSize: '12px' } }, item.masked),
                                h('button', { className: 'ar-btn ghost danger', onClick: () => clearToken(id) }, '清除'))))),
                h('div', null,
                    h('div', { className: 'ar-sec' }, h('span', {}, '配置来源')),
                    h('div', { className: 'ar-card' },
                        h('div', { className: 'ar-kv' }, h('span', { className: 'k' }, '项目'), h('span', { className: 'v ar-mono ar-muted ar-cut', title: cwd }, cwd || '（未取到项目路径，回落到 default）')),
                        state && state.projectKey ? h('div', { className: 'ar-kv' }, h('span', { className: 'k' }, 'key'), h('span', { className: 'v ar-mono ar-muted ar-cut' }, state.projectKey)) : null,
                        state && state.sources && state.sources.length > 0
                            ? state.sources.map((s) => h('div', { key: s, className: 'ar-kv' }, h('span', { className: 'k' }, '来源'), h('span', { className: 'v ar-mono ar-muted ar-cut', title: s }, s)))
                            : h('div', { className: 'ar-kv' }, h('span', { className: 'k' }, '来源'), h('span', { className: 'v ar-muted' }, '暂无 YAML 文件，接口全部来自面板')))));

            return h('div', { className: 'ar-root' },
                h('div', { className: 'ar-top' },
                    h('div', { className: 'ar-tabs' }, tabs.map((item) => h('button', {
                        key: item.id,
                        className: item.id === tab ? 'ar-tab on' : 'ar-tab',
                        onClick: () => setTab(item.id),
                    }, item.label, item.count > 0 ? h('span', { className: 'ar-count' }, item.count) : null))),
                    h('button', { className: 'ar-btn ghost icon', disabled: busy !== '', title: '重新读取配置与进程列表', onClick: () => { refresh(); refreshJava(); } }, '↻')),
                h('div', { className: 'ar-body' },
                    h(Banner, { kind: 'err', text: error, onClose: () => setError('') }),
                    h(Banner, { kind: 'ok', text: error ? '' : notice, onClose: () => setNotice('') }),
                    tab === 'apis' ? apisPane : null,
                    tab === 'services' ? servicesPane : null,
                    tab === 'settings' ? settingsPane : null));
        }

        /**
         * 设置里的插件主页面。
         *
         * 侧边栏那个页签是「干活的地方」，这里只放全局项：默认工作区与数据目录。
         * 没有会话上下文，cwd 传空串，host 会回落到设置里的默认工作区。
         */
        function SettingsPage() {
            const [settings, setSettings] = React.useState(null);
            const [error, setError] = React.useState('');
            const [notice, setNotice] = React.useState('');
            const [busy, setBusy] = React.useState('');
            const [workspace, setWorkspace] = React.useState('');
            const [dataDir, setDataDir] = React.useState('');

            const load = React.useCallback(async () => {
                try {
                    const data = await request('settings', { headers: { 'Content-Type': 'application/json' } });
                    if (data.ok === false) throw new Error(data.message || '读取设置失败');
                    setSettings(data);
                    setWorkspace(data.workspace || '');
                    setDataDir(data.dataDir || '');
                    setError('');
                } catch (e) {
                    setError(e.message);
                }
            }, []);

            React.useEffect(() => { load(); }, [load]);

            const save = async (patch, message) => {
                setBusy('save');
                setError('');
                setNotice('');
                try {
                    const data = await request('settings', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ settings: patch }),
                    });
                    if (data.ok === false) throw new Error(data.message || '保存失败');
                    setSettings(data);
                    setWorkspace(data.workspace || '');
                    setDataDir(data.dataDir || '');
                    setNotice(message);
                } catch (e) {
                    setError(e.message);
                } finally {
                    setBusy('');
                }
            };

            return h('div', { className: 'ar-root' },
                h('div', { className: 'ar-body' },
                    h(Banner, { kind: 'err', text: error, onClose: () => setError('') }),
                    h(Banner, { kind: 'ok', text: error ? '' : notice, onClose: () => setNotice('') }),
                    h('div', null,
                        h('div', { className: 'ar-sec' }, h('span', { className: 't' }, '默认工作区')),
                        h('div', { className: 'ar-card' },
                            h('div', { className: 'ar-hint' },
                                '没有会话上下文时（直接调接口、从工具里启动服务）用它当项目目录。填你的项目根目录的绝对路径。'),
                            h('div', { className: 'ar-row' },
                                h('input', {
                                    className: 'ar-in ar-mono',
                                    value: workspace,
                                    placeholder: '你的项目根目录的绝对路径',
                                    onChange: (e) => setWorkspace(e.target.value),
                                }),
                                h('button', {
                                    className: 'ar-btn primary',
                                    disabled: busy !== '' || workspace === (settings?.workspace || ''),
                                    onClick: () => save({ workspace }, '默认工作区已保存'),
                                }, '保存')))),
                    h('div', null,
                        h('div', { className: 'ar-sec' }, h('span', { className: 't' }, '数据目录')),
                        h('div', { className: 'ar-card' },
                            h('div', { className: 'ar-hint' },
                                '插件自己产生的东西（服务日志、状态文件、面板配置）放这里。默认在 DSH_HOME 下；想换盘就填绝对路径，保存后新的日志立刻写过去。'),
                            h('div', { className: 'ar-row' },
                                h('input', {
                                    className: 'ar-in ar-mono',
                                    value: dataDir,
                                    placeholder: settings?.effectiveDataDir || '绝对路径，例如 <你的目录>/dsh-api-runner-data',
                                    onChange: (e) => setDataDir(e.target.value),
                                }),
                                h('button', {
                                    className: 'ar-btn primary',
                                    disabled: busy !== '' || dataDir === (settings?.dataDir || ''),
                                    onClick: () => save({ dataDir }, '数据目录已保存'),
                                }, '保存'),
                                h('button', {
                                    className: 'ar-btn ghost',
                                    disabled: busy !== '' || (settings?.dataDir || '') === '',
                                    onClick: () => save({ dataDir: '' }, '已改回默认数据目录'),
                                }, '恢复默认')),
                            settings && settings.effectiveDataDir
                                ? h('div', { className: 'ar-kv' }, h('span', { className: 'k' }, '当前生效'), h('span', { className: 'v ar-mono ar-muted ar-cut', title: settings.effectiveDataDir }, settings.effectiveDataDir))
                                : null,
                            settings && settings.settingsFile
                                ? h('div', { className: 'ar-kv' }, h('span', { className: 'k' }, '设置文件'), h('span', { className: 'v ar-mono ar-muted ar-cut', title: settings.settingsFile }, settings.settingsFile))
                                : null)),
                    h('div', null,
                        h('div', { className: 'ar-sec' }, h('span', { className: 't' }, '说明')),
                        h('div', { className: 'ar-card' },
                            h('div', { className: 'ar-hint' },
                                '接口、token、已保存的服务都按项目归档，在侧边栏「接口调试」页签里配。这里只放跨项目的全局项。')))));
        }

        // ---------------------------------------------------------------- 注册
        //
        // inject 只写 betterSidebar：侧边栏页签是本插件的主入口。
        // 设置页（settings.section）属于可选通道，用 ctx.get('slots') 取——
        // cordis 的 ctx 是 Proxy，直接读 ctx.slots 在没 inject 时会抛错。
        const inject = ['betterSidebar'];

        function apply(ctx) {
            installStyles(ctx);
            if (!ctx.betterSidebar) return;
            ctx.effect(() => ctx.betterSidebar.registerTab({
                id: TAB_ID,
                title: () => '接口调试',
                description: '配置接口、登录保存 token、调用测试、查看本机 Java 服务',
                icon: h('span', { style: { fontSize: '13px' } }, '⚡'),
                order: 42,
                single: true,
                component: (props) => h(Panel, { ctx, visible: props.visible, scope: props.scope }),
            }), 'dsh-api-runner: register tab');

            ctx.effect(() => {
                const slots = typeof ctx.get === 'function' ? ctx.get('slots') : undefined;
                if (!slots || typeof slots.register !== 'function') return () => {};
                const register = () => slots.register({
                    name: 'settings.section',
                    id: TAB_ID,
                    order: 80,
                    label: () => '接口调试',
                }, () => h(SettingsPage, {}));
                const dispose = typeof slots.inject === 'function' ? slots.inject('settings.section', register) : register();
                return typeof dispose === 'function' ? dispose : () => {};
            }, 'dsh-api-runner: settings section');
        }

        exports.inject = inject;
        exports.apply = apply;
        return module.exports;
    },
});
