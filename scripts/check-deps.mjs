#!/usr/bin/env node
/**
 * 发布前「干净安装」检查（prepublishOnly 自动执行）。
 *
 * 为什么需要它：
 *   本机源码目录里手动装过 dmdb / mysql2 等驱动，所以测试全过；
 *   但 package.json 没声明这些依赖时，别人装上插件根本没有这些包，
 *   达梦/MySQL/PostgreSQL 全部用不了。0.3.1 就踩了这个坑。
 *
 * 做法：把 package.json 的 files 白名单里的文件复制到一个临时目录，
 * 用真实的 npm install --omit=dev 装一遍，然后检查：
 *   1. 声明的 optionalDependencies 是否真的装上了
 *   2. 运行时依赖（yaml）是否在
 *   3. 关键模块能否被 import
 *
 * 退出码非 0 时 npm publish 会被中止。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

/**
 * 期望能被 import 的运行时依赖。
 * optionalDependencies 里的驱动如果装不上（比如平台不支持），
 * 只要插件能给出「缺依赖」的清晰提示就算合格，所以这里只警告不失败。
 */
const REQUIRED = ['yaml'];
const OPTIONAL = Object.keys(pkg.optionalDependencies || {});

/**
 * 插件代码里会 import 的驱动，**必须**在 package.json 里声明。
 *
 * 这是 0.3.1 的教训：源码目录手动装过 dmdb，测试全过，但 package.json
 * 没声明它，别人装上插件后达梦直接不可用。
 * 所以除了「声明了的是否装上」，还要反向检查「代码里用的有没有声明」。
 */
const DRIVERS = [
    { name: 'dmdb', for: '达梦' },
    { name: 'mysql2', for: 'MySQL' },
    { name: 'pg', for: 'PostgreSQL' },
];
const declared = new Set([
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.optionalDependencies || {}),
    ...Object.keys(pkg.peerDependencies || {}),
]);

const problems = [];
const warnings = [];

function run(cmd, args, cwd) {
    /**
     * Windows 上 npm 是 `npm.cmd`（批处理包装），execFileSync 直接调 `npm` 会 ENOENT。
     * 但 `shell: true` 会触发 DEP0190（参数不转义，有注入风险）。
     * 折中：直接调 npm.cmd，用 cmd.exe 显式执行它——参数由 execFileSync 转义。
     */
    const isWin = process.platform === 'win32';
    if (isWin && cmd === 'npm') {
        return execFileSync('cmd.exe', ['/d', '/c', 'npm.cmd', ...args], {
            cwd,
            stdio: 'pipe',
            encoding: 'utf8',
            windowsHide: true,
        });
    }
    return execFileSync(cmd, args, { cwd, stdio: 'pipe', encoding: 'utf8' });
}

// ---- 1. 准备临时目录，只放会发布出去的文件 ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-api-runner-clean-'));

function copyEntries(entries) {
    for (const entry of entries) {
        if (entry.includes('*')) {
            const dir = path.dirname(entry);
            const pattern = path.basename(entry);
            const absDir = path.join(root, dir);
            if (!fs.existsSync(absDir)) continue;
            const re = new RegExp(`^${pattern.replace(/\./g, '\\.').replace(/\*/g, '.*')}$`);
            for (const f of fs.readdirSync(absDir)) {
                if (!re.test(f)) continue;
                fs.mkdirSync(path.join(tmp, dir), { recursive: true });
                fs.copyFileSync(path.join(absDir, f), path.join(tmp, dir, f));
            }
        } else {
            const abs = path.join(root, entry);
            if (!fs.existsSync(abs)) continue;
            fs.cpSync(abs, path.join(tmp, entry), { recursive: true });
        }
    }
}

copyEntries(['package.json', ...(pkg.files || [])]);

console.log(`[check-deps] 临时目录: ${tmp}`);
console.log(`[check-deps] 声明的 optionalDependencies: ${OPTIONAL.join(', ') || '(无)'}`);

// ---- 1.5 反向检查：代码里 import 的驱动必须已声明 ----
/**
 * 扫描 src/ 里所有 `import('xxx')`，找出插件真正会加载的第三方包。
 * 只比对 DRIVERS 白名单，避免误报（内置模块、相对路径不参与）。
 */
{
    const srcDir = path.join(root, 'src');
    const imported = new Set();
    if (fs.existsSync(srcDir)) {
        for (const f of fs.readdirSync(srcDir)) {
            if (!f.endsWith('.js')) continue;
            const text = fs.readFileSync(path.join(srcDir, f), 'utf8');
            for (const m of text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
                const spec = m[1];
                if (spec.startsWith('.') || spec.startsWith('node:') || spec.startsWith('file:')) continue;
                // 取包名（@scope/name 或 name）
                const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
                imported.add(name);
            }
        }
    }
    for (const d of DRIVERS) {
        if (imported.has(d.name) && !declared.has(d.name)) {
            problems.push(
                `代码里 import 了 ${d.name}（${d.for}），但 package.json 没声明它——`
                + '别人装上插件后这个功能会直接不可用。请加进 optionalDependencies。',
            );
        }
    }
}

// ---- 2. 干净安装（只装生产依赖）----
try {
    run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'], tmp);
} catch (error) {
    const out = String(error.stdout || '') + String(error.stderr || '');
    // 安装失败本身不一定是错（optional 包装不上是允许的），但要看清楚
    warnings.push(`npm install 返回非零：${out.trim().split('\n').slice(-3).join(' | ')}`);
}

// ---- 3. 检查依赖是否真的在 ----
for (const name of REQUIRED) {
    const dir = path.join(tmp, 'node_modules', name);
    if (!fs.existsSync(dir)) {
        problems.push(`必需依赖 ${name} 没有装上（package.json 的 dependencies 是否漏了？）`);
    }
}

for (const name of OPTIONAL) {
    const dir = path.join(tmp, 'node_modules', name);
    if (!fs.existsSync(dir)) {
        warnings.push(`可选驱动 ${name} 未装上（可能是平台限制；插件应给出清晰提示）`);
    }
}

// ---- 4. 尝试 import 关键模块 ----
async function tryImport(name) {
    const dir = path.join(tmp, 'node_modules', name);
    if (!fs.existsSync(dir)) return { ok: false, reason: 'not-installed' };
    const pkgFile = path.join(dir, 'package.json');
    if (!fs.existsSync(pkgFile)) return { ok: false, reason: 'no-package-json' };
    const meta = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    const entry = meta.main || 'index.js';
    const abs = path.join(dir, entry);
    if (!fs.existsSync(abs)) return { ok: false, reason: `main 不存在: ${entry}` };
    try {
        const mod = await import(pathToFileURL(abs).href);
        return { ok: true, keys: Object.keys(mod || {}).slice(0, 6) };
    } catch (error) {
        return { ok: false, reason: error.message };
    }
}

// ---- 5. 关键：dmdb 的 createPool 能否拿到 ----
let dmdbChecked = false;
if (fs.existsSync(path.join(tmp, 'node_modules', 'dmdb'))) {
    const r = await tryImport('dmdb');
    if (!r.ok) {
        problems.push(`dmdb 装上了但 import 失败：${r.reason}`);
    } else {
        const candidates = [r.keys.includes('default') ? (await import(pathToFileURL(path.join(tmp, 'node_modules', 'dmdb', 'index.js')).href)).default : null];
        const mod = await import(pathToFileURL(path.join(tmp, 'node_modules', 'dmdb', 'index.js')).href);
        const found = [mod?.default, mod?.dmdb, mod?.default?.dmdb, mod].find((m) => m && typeof m.createPool === 'function');
        if (!found) {
            problems.push(`dmdb 已安装但找不到 createPool（导出项：${r.keys.join(', ')}）`);
        } else {
            dmdbChecked = true;
        }
    }
}

// ---- 6. 插件自身能否被 import ----
const mainEntry = path.join(tmp, pkg.main || 'src/main.js');
if (fs.existsSync(mainEntry)) {
    try {
        const mod = await import(pathToFileURL(mainEntry).href);
        if (!Array.isArray(mod.inject)) {
            problems.push('src/main.js 没有导出 inject 数组（cordis 插件格式不对）');
        }
        const want = ['webServer', 'sessions', 'tools', 'connection', 'systemPrompt'];
        const missing = want.filter((n) => !mod.inject.includes(n));
        if (missing.length > 0) {
            problems.push(`src/main.js 的 inject 缺少：${missing.join(', ')}`);
        }
    } catch (error) {
        problems.push(`src/main.js import 失败：${error.message}`);
    }
}

// ---- 7. 清理 ----
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

// ---- 8. 报告 ----
if (warnings.length > 0) {
    console.warn('\n[check-deps] 警告（不阻止发布）：');
    for (const w of warnings) console.warn(`  ⚠ ${w}`);
}

if (problems.length > 0) {
    console.error('\n[check-deps] ✗ 干净安装检查失败，已中止发布：');
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error('\n修复：把缺失的包写进 package.json 的 dependencies 或 optionalDependencies。');
    process.exit(1);
}

console.log(`[check-deps] ✓ 干净安装通过${dmdbChecked ? '（dmdb 可用）' : ''}`);
