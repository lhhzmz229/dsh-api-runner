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
        createElement: () => ({ set textContent(v) {}, id: '' }),
        head: { appendChild: () => {} },
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
