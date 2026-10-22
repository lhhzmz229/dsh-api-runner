/**
 * client/client.js 的形态测试。
 *
 * 客户端 bundle 是「经典脚本」：加载时立刻调用 window.__ModuleLoader__.load(...)，
 * 由 DSH 前端注入的 loader 提供 require。这里用最小桩模拟这套环境，
 * 校验：① 注册的 id 与包名一致；② 导出 inject/apply；③ apply 会注册一个侧边栏 tab；
 * ④ 面板组件能在没有 scope 的情况下渲染不崩。
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
assert.deepEqual(recorded.exports.inject, ['betterSidebar']);
assert.equal(typeof recorded.exports.apply, 'function');

// apply：用一个只提供 betterSidebar 的 ctx，断言注册了一个 tab
const tabs = [];
const effects = [];
const ctx = {
    betterSidebar: {
        registerTab: (descriptor) => {
            tabs.push(descriptor);
            return () => {};
        },
    },
    // 没有 slots 时也要能正常注册 tab（设置页是可选的）
    get: () => undefined,
    effect: (callback, label) => {
        effects.push(label);
        return callback();
    },
};
recorded.exports.apply(ctx);
assert.equal(tabs.length, 1, 'apply 应注册一个侧边栏 tab');
assert.equal(tabs[0].id, 'dsh-api-runner');
assert.equal(tabs[0].single, true);
assert.equal(typeof tabs[0].title, 'function');
assert.equal(tabs[0].title(), '接口调试');

// 有 slots 时，还要在设置里挂一个插件主页（settings.section）
const sections = [];
const injectedSlots = [];
const ctxWithSlots = {
    betterSidebar: { registerTab: () => () => {} },
    get: (name) => (name === 'slots' ? {
        inject: (slot, callback) => { injectedSlots.push(slot); callback(); return () => {}; },
        register: (descriptor, render) => { sections.push({ descriptor, render }); return () => {}; },
    } : undefined),
    effect: (callback) => callback(),
};
recorded.exports.apply(ctxWithSlots);
assert.deepEqual(injectedSlots, ['settings.section'], '设置页应通过 slots.inject 等待 slot 就绪');
assert.equal(sections.length, 1, '应注册一个设置页');
assert.equal(sections[0].descriptor.name, 'settings.section');
assert.equal(sections[0].descriptor.id, 'dsh-api-runner');
assert.equal(sections[0].descriptor.label(), '接口调试');
const page = sections[0].render();
assert.ok(page, '设置页应返回元素');
assert.equal(typeof page.type, 'function');

// 面板组件：没有 scope 也不能崩
const panel = tabs[0].component({ visible: false, scope: {} });
assert.ok(panel, '面板组件应返回元素');
assert.equal(typeof panel.type, 'function');

// 没有 betterSidebar 时 apply 要安全退出，不能抛
recorded.exports.apply({ effect: () => {} });

console.log('PASSED: client bundle shape');
