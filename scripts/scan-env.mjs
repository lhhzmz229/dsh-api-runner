/**
 * dsh-api-runner 环境扫描（给另一台电脑用）
 *
 * 用法：把本文件保存成 scan.mjs，在任意目录执行：
 *     node scan.mjs
 * 或指定插件目录：
 *     node scan.mjs "C:\Users\xxx\.dsh\profiles\desktop\node_modules\dsh-api-runner"
 *
 * 它只读，不改任何东西。把输出的整段文本发回即可。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const line = (s = '') => console.log(s);
const head = (s) => { line(); line('='.repeat(60)); line(s); line('='.repeat(60)); };

/** 自动找插件目录 */
function findPluginDir() {
    const explicit = process.argv[2];
    if (explicit) return explicit;
    const home = os.homedir();
    const profiles = path.join(home, '.dsh', 'profiles');
    const found = [];
    if (fs.existsSync(profiles)) {
        for (const p of fs.readdirSync(profiles)) {
            const cand = path.join(profiles, p, 'node_modules', 'dsh-api-runner');
            if (fs.existsSync(cand)) found.push(cand);
        }
    }
    return found[0] || '';
}

head('1. 基本环境');
line(`时间       : ${new Date().toISOString()}`);
line(`平台       : ${process.platform} ${os.arch()}`);
line(`Node       : ${process.version}`);
line(`Node 路径  : ${process.execPath}`);
line(`当前目录   : ${process.cwd()}`);

const pluginDir = findPluginDir();
line(`插件目录   : ${pluginDir || '(未找到)'}`);

head('2. 插件版本与依赖声明');
if (pluginDir && fs.existsSync(path.join(pluginDir, 'package.json'))) {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
        line(`版本           : ${pkg.version}`);
        line(`dependencies   : ${JSON.stringify(pkg.dependencies || {})}`);
        line(`optionalDeps   : ${JSON.stringify(pkg.optionalDependencies || {})}`);
    } catch (e) {
        line(`package.json 解析失败: ${e.message}`);
    }
} else {
    line('找不到插件目录，请手动传路径：node scan.mjs "插件完整路径"');
}

head('3. dmdb 包是否存在');
/**
 * dmdb 可能在三个地方：
 *   - 插件自己的 node_modules
 *   - profile 顶层的 node_modules（pnpm 提升后）
 *   - .pnpm 里
 */
const candidates = [];
if (pluginDir) {
    candidates.push({ label: '插件目录下', p: path.join(pluginDir, 'node_modules', 'dmdb') });
    const profileRoot = path.dirname(path.dirname(pluginDir)); // .../node_modules
    candidates.push({ label: 'profile 顶层', p: path.join(profileRoot, 'dmdb') });
    const pnpmDir = path.join(profileRoot, '.pnpm');
    if (fs.existsSync(pnpmDir)) {
        for (const d of fs.readdirSync(pnpmDir)) {
            if (d.startsWith('dmdb@')) {
                candidates.push({ label: `.pnpm/${d}`, p: path.join(pnpmDir, d, 'node_modules', 'dmdb') });
            }
        }
    }
}
// 也查插件源码目录（link 安装时）
candidates.push({ label: '当前目录下', p: path.join(process.cwd(), 'node_modules', 'dmdb') });

let dmdbDir = '';
for (const c of candidates) {
    const exists = fs.existsSync(c.p);
    line(`  ${exists ? '✓' : '✗'} ${c.label.padEnd(16)} ${c.p}`);
    if (exists && !dmdbDir) dmdbDir = c.p;
}

if (!dmdbDir) {
    line('');
    line('结论：dmdb 根本没装。执行：');
    line(`  cd "${pluginDir}"`);
    line('  npm install dmdb');
} else {
    head('4. dmdb 包完整性（这是关键）');
    const dmdbPkgPath = path.join(dmdbDir, 'package.json');
    if (!fs.existsSync(dmdbPkgPath)) {
        line(`✗ 缺 package.json：${dmdbPkgPath}`);
    } else {
        try {
            const p = JSON.parse(fs.readFileSync(dmdbPkgPath, 'utf8'));
            line(`  名称     : ${p.name}`);
            line(`  版本     : ${p.version}`);
            line(`  main     : ${p.main}`);
            line(`  type     : ${p.type ?? '(未设)'}`);
            line(`  依赖     : ${JSON.stringify(p.dependencies || {})}`);
        } catch (e) {
            line(`  ✗ package.json 损坏：${e.message}`);
        }
    }

    line('');
    line('  文件清单：');
    const mustHave = ['index.js', 'src/dm.js'];
    for (const rel of mustHave) {
        const p = path.join(dmdbDir, rel);
        if (fs.existsSync(p)) {
            line(`    ✓ ${rel}  (${fs.statSync(p).size} 字节)`);
        } else {
            line(`    ✗ ${rel}  ← 缺失！`);
        }
    }

    // index.js 内容
    const indexPath = path.join(dmdbDir, 'index.js');
    if (fs.existsSync(indexPath)) {
        line('');
        line('  index.js 内容：');
        line(`    ${JSON.stringify(fs.readFileSync(indexPath, 'utf8'))}`);
    }

    // 统计 src 下文件数
    const srcDir = path.join(dmdbDir, 'src');
    if (fs.existsSync(srcDir)) {
        const count = (function walk(d) {
            let n = 0;
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                if (e.isDirectory()) n += walk(path.join(d, e.name));
                else n += 1;
            }
            return n;
        })(srcDir);
        line(`  src/ 下文件数：${count}`);
    } else {
        line('  ✗ src/ 目录不存在');
    }

    head('5. 实际加载测试（决定性证据）');
    // 5a. require 直接加载
    try {
        const require = createRequire(path.join(pluginDir || process.cwd(), 'package.json'));
        const m = require('dmdb');
        line(`require('dmdb') → ${typeof m}`);
        if (m && typeof m === 'object') {
            const keys = Object.keys(m);
            line(`  导出项数量: ${keys.length}`);
            line(`  有 createPool: ${typeof m.createPool === 'function' ? '✓' : '✗'}`);
            line(`  有 parseUrl  : ${typeof m.parseUrl === 'function' ? '✓' : '✗'}`);
            line(`  前 10 个导出: ${keys.slice(0, 10).join(', ')}`);
        } else {
            line(`  ✗ 返回值不是对象（是 ${typeof m}）← 这就是报错的根源`);
        }
    } catch (e) {
        line(`require('dmdb') 抛错: ${e.code || ''} ${e.message.split('\n')[0]}`);
    }

    // 5b. 直接 require 子模块，看 .dmdb 字段在不在
    line('');
    try {
        const require = createRequire(path.join(pluginDir || process.cwd(), 'package.json'));
        const dm = require('dmdb/src/dm');
        const keys = Object.keys(dm || {});
        line(`require('dmdb/src/dm') → 导出项数量 ${keys.length}`);
        line(`  有 .dmdb 字段: ${dm && dm.dmdb ? '✓ 有' : '✗ 没有 ← 这就是报错根源'}`);
        line(`  前 10 个: ${keys.slice(0, 10).join(', ')}`);
    } catch (e) {
        line(`require('dmdb/src/dm') 抛错: ${e.message.split('\n')[0]}`);
    }

    // 5c. import 测试
    line('');
    try {
        const m = await import('dmdb');
        line(`import('dmdb') → 成功，导出项: ${Object.keys(m).join(', ')}`);
    } catch (e) {
        line(`import('dmdb') 抛错: ${e.constructor.name} | ${String(e.message).split('\n')[0]}`);
        const st = String(e.stack || '').split('\n').slice(1, 3).map((l) => l.trim()).join(' ← ');
        line(`  位置: ${st}`);
    }
}

head('6. 插件自己的驱动自检');
if (pluginDir) {
    try {
        const { pathToFileURL } = await import('node:url');
        const mod = await import(pathToFileURL(path.join(pluginDir, 'src', 'db.js')).href);
        const mgr = new mod.DbManager({ homeDir: path.join(os.homedir(), '.dsh') });
        const r = await mgr.diagnose();
        line(`Node: ${r.node}`);
        for (const d of r.drivers) {
            const mark = d.ok ? '✓' : (d.installed ? '!' : '-');
            line(`  ${mark} ${d.label.padEnd(12)} ${d.name.padEnd(10)} ${d.detail.slice(0, 100)}`);
            if (d.path) line(`      ${d.path}`);
        }
        mgr.dispose();
    } catch (e) {
        line(`自检失败: ${e.message.split('\n')[0]}`);
    }
}

head('7. 结论提示');
line('把以上全部内容发回即可。重点看：');
line('  - 第 3 节：dmdb 到底在哪个位置');
line('  - 第 4 节：src/dm.js 是否存在、src/ 下文件数是否合理（正常应有上百个）');
line('  - 第 5 节：require("dmdb") 是否返回 undefined、dmdb/src/dm 有没有 .dmdb 字段');
line('');
