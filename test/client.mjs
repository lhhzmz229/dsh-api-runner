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

// apply：只提供 slots 的 ctx，断言注册落在宿主自带的席位上
const first = makeSlots();
const tabTypes = [];
const effects = [];
const ctx = {
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
    effect: (callback, label) => {
        effects.push(label);
        return callback();
    },
};
recorded.exports.apply(ctx);

assert.deepEqual(
    first.injected,
    ['sidebar.panellist', 'main', 'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title', 'settings.section'],
    '每个席位都要通过 slots.inject 等待声明就绪',
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

assert.equal(tabTypes.length, 1, '应向 sidebarRightTabs 注册一个页签类型');
assert.equal(tabTypes[0].id, 'dsh-api-runner');
assert.equal(tabTypes[0].kind, 'dsh-api-runner');
assert.equal(tabTypes[0].title(), '接口调试');

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
assert.ok(/label: '连接'/.test(source) && /label: 'SQL'/.test(source) && /label: '表结构'/.test(source),
    '数据库子页应有「连接 / SQL / 表结构」三个一级标题');
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
assert.equal(second.registrations.length, 5, '没有 inject 时也要把五个席位都注册上');

console.log('PASSED: client bundle shape');
