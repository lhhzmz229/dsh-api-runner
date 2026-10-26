/**
 * 极简诊断：一条命令判断 dmdb 是不是坏的。
 *
 * 用法（在那台电脑上）：
 *   cd "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-api-runner"
 *   node -e "const r=require('module').createRequire(process.cwd()+'/x.js'); try{const m=r('dmdb'); console.log('require dmdb =>', typeof m, m&&typeof m.createPool==='function'?'OK':'BAD: no createPool')}catch(e){console.log('require 失败:',e.code,e.message.split('\n')[0])}; try{const d=r('dmdb/src/dm'); console.log('dmdb/src/dm 有 .dmdb 字段:', d&&d.dmdb?'YES':'NO  <= 这就是根源')}catch(e){console.log('dmdb/src/dm 失败:',e.code,e.message.split('\n')[0])}"
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

function findPluginDir() {
    const explicit = process.argv[2];
    if (explicit) return explicit;
    const profiles = path.join(os.homedir(), '.dsh', 'profiles');
    if (!fs.existsSync(profiles)) return '';
    for (const p of fs.readdirSync(profiles)) {
        const cand = path.join(profiles, p, 'node_modules', 'dsh-api-runner');
        if (fs.existsSync(cand)) return cand;
    }
    return '';
}

const dir = findPluginDir();
if (!dir) {
    console.log('找不到插件目录。请手动传：node quick-dm-check.mjs "插件完整路径"');
    process.exit(1);
}

console.log(`插件目录: ${dir}`);
const pkgPath = path.join(dir, 'package.json');
if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    console.log(`插件版本: ${pkg.version}`);
}
console.log(`Node: ${process.version}`);
console.log('');

const require = createRequire(path.join(dir, 'package.json'));

console.log('--- 1) require("dmdb") ---');
let dmOk = false;
try {
    const m = require('dmdb');
    console.log(`  返回值类型: ${typeof m}`);
    if (m && typeof m === 'object') {
        console.log(`  createPool: ${typeof m.createPool === 'function' ? '✓ 有' : '✗ 没有'}`);
        console.log(`  parseUrl  : ${typeof m.parseUrl === 'function' ? '✓ 有' : '✗ 没有'}`);
        console.log(`  导出项数  : ${Object.keys(m).length}`);
        dmOk = typeof m.createPool === 'function';
    } else {
        console.log('  ✗ 不是对象 —— module.exports 是空的，这就是报错根源');
    }
} catch (e) {
    console.log(`  ✗ 抛错: ${e.code || ''} ${String(e.message).split('\n')[0]}`);
}

console.log('');
console.log('--- 2) require("dmdb/src/dm") 的 .dmdb 字段 ---');
try {
    const d = require('dmdb/src/dm');
    const keys = Object.keys(d || {});
    console.log(`  导出项: ${keys.join(', ') || '(空)'}`);
    console.log(`  .dmdb 字段: ${d && d.dmdb ? '✓ 有' : '✗ 没有 ←←← 这就是根源'}`);
} catch (e) {
    console.log(`  ✗ 抛错: ${e.code || ''} ${String(e.message).split('\n')[0]}`);
}

console.log('');
console.log('--- 3) dmdb 包文件完整性 ---');
try {
    const require2 = createRequire(path.join(dir, 'package.json'));
    const entry = require2.resolve('dmdb');
    const dmdbDir = path.dirname(entry);
    console.log(`  入口: ${entry}`);
    const srcDir = path.join(dmdbDir, 'src');
    if (fs.existsSync(srcDir)) {
        const walk = (d) => {
            let n = 0;
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                if (e.isDirectory()) n += walk(path.join(d, e.name));
                else n += 1;
            }
            return n;
        };
        const count = walk(srcDir);
        console.log(`  src/ 下文件数: ${count}${count < 50 ? '  ✗ 太少了，包不完整（正常约 100）' : '  ✓ 正常'}`);
    } else {
        console.log('  ✗ src/ 目录不存在 —— 包不完整');
    }
    const dmjs = path.join(srcDir, 'dm.js');
    if (fs.existsSync(dmjs)) {
        console.log(`  src/dm.js: ✓ ${fs.statSync(dmjs).size} 字节`);
    } else {
        console.log('  src/dm.js: ✗ 缺失');
    }
} catch (e) {
    console.log(`  检查失败: ${e.message}`);
}

console.log('');
console.log('--- 4) import("dmdb") ---');
try {
    const m = await import(pathToFileURL(path.join(dir, 'node_modules', 'dmdb', 'index.js')).href);
    console.log(`  ✓ 成功，导出项: ${Object.keys(m).join(', ')}`);
} catch (e) {
    console.log(`  ✗ ${e.constructor.name}: ${String(e.message).split('\n')[0]}`);
    console.log(`    ${String(e.stack || '').split('\n').slice(1, 3).map((l) => l.trim()).join(' ← ')}`);
}

console.log('');
console.log('=== 结论 ===');
if (dmOk) {
    console.log('dmdb 可用。若面板仍报错，把上面第 2、3 节发回。');
} else {
    console.log('dmdb 不可用。执行下面的命令重装：');
    console.log(`  cd "${dir}"`);
    console.log('  Remove-Item node_modules\\dmdb -Recurse -Force -ErrorAction SilentlyContinue');
    console.log('  npm install dmdb');
}
