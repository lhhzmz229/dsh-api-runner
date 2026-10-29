/**
 * client/client.js 的形态测试。
 *
 * 客户端 bundle 是「经典脚本」：加载时立刻调用 window.__ModuleLoader__.load(...)，
 * 由 DSH 前端注入的 loader 提供 require。这里用最小桩模拟这套环境，校验：
 *   ① 注册的 id 与包名一致；
 *   ② 导出 inject/apply，且 inject 里**没有**第三方侧边栏（本插件是独立的）；
 *   ③ apply 只往宿主自带的 slot 席位注册（panellist / main / 右栏页签 / 设置页）；
 *   ④ 面板组件在缺少 scope 时也能渲染不崩；
 *   ⑤ 宿主没提供 slots 时安静退出，不抛异常。
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'client', 'client.js'), 'utf8');

let recorded;
/** 极简 React 桩：只够执行 createElement 与 hooks */
const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children: children.length > 1 ? children : children[0] } }),
    Fragment: 'Fragment',
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useCallback: (fn) => fn,
    useRef: (initial) => ({ current: initial }),
};
const requireStub = (name) => {
    if (name === 'react') return React;
    throw new Error(`客户端 bundle 请求了未桩的模块：${name}`);
};

const windowStub = {
    __ModuleLoader__: {
        load: (entry) => {
            recorded = entry;
            recorded.exports = entry.factory(requireStub);
        },
    },
    confirm: () => true,
    document: {
        getElementById: () => null,
        querySelectorAll: () => [],
        createElement: () => ({ set textContent(v) {}, id: '', remove() {} }),
        head: { appendChild: () => {} },
        documentElement: { appendChild: () => {} },
    },
};
// bundle 里会读 document / window，通过函数参数作用域注入
const run = new Function('window', 'document', 'setInterval', 'clearInterval', 'fetch', source);
run(windowStub, windowStub.document, () => 0, () => {}, () => { throw new Error('测试里不应真的发请求'); });

assert.ok(recorded, '应当调用 window.__ModuleLoader__.load');
assert.equal(recorded.id, 'dsh-api-runner', 'bundle id 必须与包名一致');
assert.deepEqual(recorded.exports.inject, ['slots'], 'client half 只硬依赖 slots，不依赖任何第三方侧边栏');
assert.equal(typeof recorded.exports.apply, 'function');

/**
 * 造一个记录注册的 slots 服务桩。
 * @param {{withInject?: boolean}} options - 是否提供 inject（宿主一定有，缺省时走直注册分支）
 */
function makeSlots(options = {}) {
    const registrations = [];
    const injected = [];
    const slots = {
        register: (descriptor, render) => {
            registrations.push({ descriptor, render });
            return () => {};
        },
    };
    if (options.withInject !== false) {
        slots.inject = (slot, callback) => {
            injected.push(slot);
            callback();
            return () => {};
        };
    }
    return { slots, registrations, injected };
}

// apply：提供 slots + sidebarRightTabs，断言右侧栏页签类型和 slot 都注册上
const first = makeSlots();
const effects = [];
const tabTypes = [];
const ctx = {
    /**
     * 必须提供 `sidebarRightTabs`。
     *
     * 我从 DSH 的 app.asar 里确认过：右侧栏引导页的卡片来自**页签类型定义的
     * `guide` 数组**（`guideEntries = cached.flatMap(d => d.guide ?? [])`），
     * 不是来自 `sidebar.right.tab.guide.entry` 这个 slot。
     * 只注册 slot 的话卡片不会出现在引导页上（踩过这个坑）。
     *
     * 服务由 `ctx.reflect.provide("sidebarRightTabs", tabs)` 提供，
     * cordis 的 `ctx.get` 能读到，但要求提供方 fiber 已激活——
     * 所以插件必须等它就绪，不能只查一次。
     */
    get: (name) => {
        if (name === 'slots') return first.slots;
        if (name === 'sidebarRightTabs') {
            return {
                register: (definition) => {
                    tabTypes.push(definition);
                    return () => {};
                },
            };
        }
        return undefined;
    },
    on: () => () => {},
    effect: (callback, label) => {
        effects.push(label);
        return callback();
    },
};
recorded.exports.apply(ctx);

assert.deepEqual(
    first.injected,
    ['sidebar.panellist', 'main', 'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title', 'settings.section'],
    '每个席位都要通过 slots.inject 等待声明就绪（右侧栏是正文+标题两个 slot，卡片靠页签类型）',
);

const byName = (name) => first.registrations.filter((item) => item.descriptor.name === name);
const panellist = byName('sidebar.panellist');
assert.equal(panellist.length, 1, '应注册一个左栏图标');
assert.equal(panellist[0].descriptor.id, 'dsh-api-runner');
assert.equal(panellist[0].descriptor.label(), '接口调试');

const main = byName('main');
assert.equal(main.length, 1, '应注册一个中栏整页');
assert.equal(main[0].descriptor.key, 'dsh-api-runner', 'main 的 key 必须与 panellist 的 id 一致，点图标才切得过去');

assert.equal(byName('sidebar.right.pane.tab').length, 1, '应注册一个右侧栏页签正文');
assert.equal(byName('sidebar.right.pane.tab')[0].descriptor.key, 'dsh-api-runner');
assert.equal(byName('sidebar.right.pane.tab.title').length, 1, '应注册一个右侧栏页签标题');

const sections = byName('settings.section');
assert.equal(sections.length, 1, '应注册一个设置页');
assert.equal(sections[0].descriptor.id, 'dsh-api-runner');
assert.equal(sections[0].descriptor.label(), '接口调试');

/**
 * 右侧栏：页签类型（含 guide 卡片）+ 正文 slot + 标题 slot。
 *
 * 用户报过的 bug：右侧栏只注册了正文和标题、没注册页签类型，
 * 结果引导页上根本没有「接口调试」卡片，左侧却有入口。
 *
 * 关键：卡片来自**页签类型的 `guide` 数组**（DSH 的 guideEntries
 * 就是 flatMap 各个 definition.guide），不是 guide.entry slot。
 */
assert.equal(tabTypes.length, 1, '应向 sidebarRightTabs 注册一个页签类型');
const tabType = tabTypes[0];
assert.equal(tabType.id, 'dsh-api-runner');
assert.equal(tabType.kind, 'dsh-api-runner');
assert.equal(tabType.title(), '接口调试');
assert.ok(Array.isArray(tabType.guide) && tabType.guide.length > 0, '页签类型必须带 guide 卡片定义');
const card = tabType.guide[0];
assert.equal(card.id, 'dsh-api-runner');
assert.equal(card.title(), '接口调试');
assert.equal(typeof card.description, 'function');
assert.ok(card.description().length > 0, '卡片应有描述文字');

// 正文和标题 slot
for (const slotName of ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title']) {
    const entries = byName(slotName);
    assert.equal(entries.length, 1, `应注册 ${slotName}`);
    assert.equal(entries[0].descriptor.key, 'dsh-api-runner', `${slotName} 的 key 应是 dsh-api-runner`);
    assert.ok(entries[0].render, `${slotName} 应有可渲染组件`);
}

// 设置页能渲染
const page = sections[0].render();
assert.ok(page, '设置页应返回元素');
assert.equal(typeof page.type, 'function');

// 面板组件：没有 scope 也不能崩（全局页没有会话时就是这条路径）
const panel = main[0].render({});
assert.ok(panel, '面板组件应返回元素');
assert.equal(typeof panel.type, 'function');

// 右侧栏页签：没有 useTabInfo 时按可见渲染，也不崩
const rightPanel = byName('sidebar.right.pane.tab')[0].render({ sessionId: 'session-1' });
assert.ok(rightPanel, '右侧栏页签正文应返回元素');
assert.equal(typeof rightPanel.type, 'function');

// 数据库子页：结构断言（直接扫源码，避免为渲染造一堆桩）
assert.ok(/id: 'db', label: '数据库'/.test(source), "面板 tabs 应包含「数据库」子页");
assert.ok(/tab === 'db' \? dbPane : null/.test(source), '应渲染 dbPane 分支');
assert.ok(/function EditDbForm/.test(source), '应有数据库连接编辑表单');
assert.ok(/function DbResultCard/.test(source), '应有 SQL 结果卡片');
assert.ok(/function TableDetail/.test(source), '应有表结构视图');
assert.ok(/type: 'password'/.test(source), '密码框必须是 password 类型，不能明文显示');
assert.ok(/只读模式（拒绝写操作）/.test(source), '应有只读模式开关');
assert.ok(/db\/query/.test(source), 'SQL 执行应走 db/query 路由');

// UI 层级：顶部页签用 ar-tabs，一级标题用独立胶囊 ar-segmented（参照宿主插件详情页）
assert.ok(/className: 'ar-tabs'/.test(source), '顶部应有页签容器 ar-tabs');
assert.ok(/className: 'ar-segmented'/.test(source), '一级标题应是小胶囊容器 ar-segmented');
assert.ok(/'ar-seg on' : 'ar-seg'/.test(source), '胶囊选中态应有独立样式');
assert.ok(/label: '连接管理'/.test(source) && /label: '项目授权'/.test(source)
    && /label: 'SQL'/.test(source) && /label: '表结构'/.test(source),
    '数据库子页应有「连接管理 / 项目授权 / SQL / 表结构」四个一级标题');
assert.ok(/const \[dbSection, setDbSection\]/.test(source), '数据库子页需要 dbSection 状态');
assert.ok(/\.ar-segmented \{/.test(source), '缺少 .ar-segmented 样式');
assert.ok(/--ar-elevated:/.test(source), '选中态需要 --ar-elevated 变量（深/浅色主题各一份）');

/**
 * 布局回归：一级标题胶囊必须横向一排。
 * 曾用 flex-wrap: wrap，结果在窄面板（右侧栏 ~300px）里被挤成竖排，
 * 用户看到的就是「连接 / SQL / 表结构」三个上下堆叠的方块。
 */
assert.ok(/\.ar-segmented \{[^}]*flex-wrap:\s*nowrap/s.test(source), 'ar-segmented 必须禁止换行');
assert.ok(/\.ar-segmented \{[^}]*overflow-x:\s*auto/s.test(source), 'ar-segmented 超出时应横向滚动');
assert.ok(/\.ar-seg \{[^}]*flex:\s*0 0 auto/s.test(source), '胶囊不应被压缩');
assert.ok(/\.ar-seg \{[^}]*white-space:\s*nowrap/s.test(source), '胶囊文字不应换行');
assert.ok(!/\.ar-segmented \{[^}]*flex-wrap:\s*wrap/s.test(source), 'ar-segmented 不能用 flex-wrap: wrap（会竖排）');
assert.ok(/\.ar-tabs \{[^}]*overflow-x:\s*auto/s.test(source), '顶部页签超出时应横向滚动');
assert.ok(/scrollIntoView/.test(source), '选中的胶囊应自动滚入视野');

/**
 * 样式热更新回归：installStyles 不能因为「元素已存在」就跳过，
 * 否则插件升级后页面里还是旧 CSS（胶囊退化成原生 button、竖排），刷新也无效。
 */
assert.ok(/style\[id\^="dsh-api-runner-style"\]/.test(source), '应清理历史版本的 style 元素');
assert.ok(/el\.textContent !== CSS/.test(source), '样式内容变化时应替换，而不是跳过');
assert.ok(!/if \(document\.getElementById\(STYLE_ID\)\) return;/.test(source), '不能因 id 已存在就提前返回');
assert.ok(/const STYLE_ID = '[^']*-v\d+'/.test(source), 'style id 应带版本后缀，避免被按 id 去重');

/**
 * 数据库表单的三处修复（用户报的缺陷）：
 *   1. 端口输入框被写死 90px，和 host 挤一行时变形
 *   2. 新增时填完没法试连
 *   3. 支持 URL 直连
 */
assert.ok(!/flex: '0 0 90px'/.test(source), '端口输入框不能固定像素宽（窄面板会变形）');
assert.ok(/测试中…' : '测试'/.test(source), '表单应有「测试」按钮，新增时也能试连');
assert.ok(/label: 'URL'/.test(source), '表单应支持 URL 录入方式');
assert.ok(/connectString/.test(source), '应支持 connectString（URL 模式）');
assert.ok(/item\.urlMode \? h\('span'/.test(source), '列表应标出 URL 模式的连接');
assert.ok(/replace\(\/\[\^\\d\]\/g, ''\)/.test(source), '端口输入框应只接受数字');

// 项目授权 UI：三档切换 + 安全说明
assert.ok(/setDbAccessLevel/.test(source), '应有设置授权的处理函数');
assert.ok(/label: '未授权'/.test(source) && /label: '只读'/.test(source) && /label: '读写'/.test(source),
    '授权应有「未授权 / 只读 / 读写」三档');
assert.ok(/毁灭性操作/.test(source), '授权页应说明毁灭性操作会被拒绝');
assert.ok(/refreshDbAccess/.test(source), '应能刷新授权状态');

// UI 重设计：命名空间分离 + 设计 token
assert.ok(/className: 'ar-switch'/.test(source), '响应切换条应使用 ar-switch（不与 ar-seg 胶囊冲突）');
assert.ok(!/className: 'ar-seg'/.test(source), 'ar-seg 只能当胶囊按钮，不能再被当容器');
assert.ok(/--ar-surface-1/.test(source) && /--ar-surface-2/.test(source) && /--ar-surface-3/.test(source),
    '应有三级中性面 token，用于分层');
assert.ok(/--ar-r-lg/.test(source), '应有大圆角 token');
assert.ok(/dsh-api-runner-style-v5/.test(source), '样式版本应为 v5');

/**
 * 试连不能锁死整个面板：
 * 达梦连不上要等十几秒，若共用全局 busy，期间保存/取消/编辑全被 disabled，
 * 用户会以为界面卡死。试连必须用独立的 testing 状态。
 */
assert.ok(/const \[dbTesting, setDbTesting\]/.test(source), '试连应有独立状态 dbTesting');
assert.ok(/disabled: testing \|\| busy === 'save'/.test(source), '测试按钮只锁自己，不锁其它');
assert.ok(/busy === 'save' \? '保存中…' : '保存'/.test(source), '保存按钮只受保存中影响');
assert.ok(!/busy === 'test'/.test(source), '不应再用全局 busy 表示测试中');

/**
 * 回归：useEffect 的依赖数组里引用了「在它之后才 const 声明」的变量，
 * 会因暂时性死区抛 `Cannot access 'x' before initialization`，
 * 整个 Panel 崩溃 -> 面板白屏。这个 bug 真实发生过（refreshDb）。
 *
 * 做法：把 Panel 函数体抽出来，逐行累积「已声明的标识符」，
 * 遇到 `}, [...])` 形式的依赖数组就检查里面的名字是否都已声明。
 */
const panelStart = source.indexOf('function Panel(props) {');
assert.ok(panelStart > 0, '应能定位 Panel 函数');
let depth = 0;
let panelEnd = -1;
for (let i = source.indexOf('{', panelStart); i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') { depth -= 1; if (depth === 0) { panelEnd = i + 1; break; } }
}
const panelBody = source.slice(panelStart, panelEnd);
const panelLines = panelBody.split('\n');
const declaredBefore = new Set();
const tdzIssues = [];
/** 全局可用的名字，不需要在 Panel 内声明 */
const GLOBALS = new Set(['visible', 'props', 'React', 'h', 'window', 'document', 'setInterval', 'clearInterval', 'setTimeout', 'console', 'undefined', 'null', 'true', 'false']);

for (let i = 0; i < panelLines.length; i += 1) {
    const line = panelLines[i];
    // 依赖数组行：`}, [a, b, c]);` 或 `}, [a, b]);`
    const depMatch = line.match(/\},\s*\[([^\]]*)\]\s*\)/);
    if (depMatch) {
        for (const raw of depMatch[1].split(',')) {
            const name = raw.trim();
            if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
            if (GLOBALS.has(name)) continue;
            if (!declaredBefore.has(name)) {
                tdzIssues.push(`Panel 第 ${i + 1} 行：依赖 "${name}" 在该行之前未声明（TDZ 会导致面板白屏）`);
            }
        }
    }
    // 记录本行声明：const/let/var 单变量
    for (const m of line.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) declaredBefore.add(m[1]);
    // 记录解构声明：const [a, b] = ... / const { a, b } = ...
    for (const m of line.matchAll(/\b(?:const|let|var)\s*\[([^\]]+)\]\s*=/g)) {
        for (const part of m[1].split(',')) {
            const name = part.trim().split(':').pop().trim();
            if (/^[A-Za-z_$][\w$]*$/.test(name)) declaredBefore.add(name);
        }
    }
    for (const m of line.matchAll(/\b(?:const|let|var)\s*\{([^}]+)\}\s*=/g)) {
        for (const part of m[1].split(',')) {
            const name = part.trim().split(':').pop().trim();
            if (/^[A-Za-z_$][\w$]*$/.test(name)) declaredBefore.add(name);
        }
    }
    // 记录函数声明
    for (const m of line.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) declaredBefore.add(m[1]);
}
assert.deepEqual(tdzIssues, [], `useEffect 依赖里出现了「声明在之后」的变量（会导致面板白屏）：\n${tdzIssues.join('\n')}`);

// 宿主没提供 slots 时 apply 要安全退出，不能抛
recorded.exports.apply({ effect: () => {} });

// slots 没有 inject 时退回直接注册（旧版宿主）
const second = makeSlots({ withInject: false });
recorded.exports.apply({
    get: (name) => (name === 'slots' ? second.slots : undefined),
    effect: (callback) => callback(),
});
// 席位：panellist / main / right.pane.tab / right.pane.tab.title / settings.section
assert.equal(second.registrations.length, 5, '没有 inject 时也要把五个席位都注册上');

console.log('PASSED: client bundle shape');
