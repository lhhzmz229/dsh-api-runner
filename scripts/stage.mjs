#!/usr/bin/env node
/**
 * stage.mjs —— 把 src/ 打包到一个全新的 build/v<序号>/ 并用它改写 cordis.patch.yml 的入口。
 *
 * 为什么需要它：DSH 的插件 loader 用 ESM 动态 import，Node 按 URL 缓存模块。
 * 同一个页面进程里 toggle bundle 只会重跑 apply，不会重新 import 模块，
 * 所以改了 src/ 之后必须让入口 URL 变化，否则继续跑旧代码。
 *
 * 用法：
 *   node scripts/stage.mjs            # 递增版本号，自动改写 patch
 *   node scripts/stage.mjs --clean    # 只保留最新一版 build
 *   node scripts/stage.mjs --release  # 把 patch 的入口改回包名（提交/发布用）
 * 之后到 DSH 里把 dsh-api-runner 这个 bundle 关掉再打开。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');
const buildDir = path.join(root, 'build');
const PACKAGE_NAME = 'dsh-api-runner';
const patchPath = path.join(root, 'cordis.patch.yml');

/** 把 patch 里的入口行改写成给定的 name，返回是否改动过 */
function rewriteEntry(name) {
    const patch = fs.readFileSync(patchPath, 'utf8');
    const rewritten = patch.replace(/^(\s+name:\s*).*$/m, `$1${name}`);
    if (rewritten === patch && !patch.includes(name)) {
        console.error('cordis.patch.yml 里没找到 name 行，未改写');
        process.exit(1);
    }
    if (rewritten !== patch) fs.writeFileSync(patchPath, rewritten, 'utf8');
    return rewritten !== patch;
}

// 发布形态：入口写包名，DSH 从安装目录解析；提交到仓库前跑这个
if (process.argv.includes('--release')) {
    rewriteEntry(PACKAGE_NAME);
    console.log(`cordis.patch.yml 入口 → ${PACKAGE_NAME}（发布形态，不含本机路径）`);
    process.exit(0);
}

function nextVersion() {
    if (!fs.existsSync(buildDir)) return 1;
    const used = fs.readdirSync(buildDir)
        .map((name) => /^v(\d+)$/.exec(name))
        .filter(Boolean)
        .map((m) => Number(m[1]));
    return used.length ? Math.max(...used) + 1 : 1;
}

const version = `v${nextVersion()}`;
const outDir = path.join(buildDir, version);
fs.mkdirSync(outDir, { recursive: true });

const files = fs.readdirSync(srcDir).filter((name) => name.endsWith('.js'));
for (const name of files) fs.copyFileSync(path.join(srcDir, name), path.join(outDir, name));

// 入口统一叫 main.js（与 src/main.js 对齐），loader 只需一个入口 URL。
const entry = path.join(outDir, 'main.js');
if (!fs.existsSync(entry)) {
    console.error(`src/main.js 不存在，无法确定插件入口`);
    process.exit(1);
}

const entryUrl = pathToFileURL(entry).href;
rewriteEntry(entryUrl);

if (process.argv.includes('--clean')) {
    for (const name of fs.readdirSync(buildDir)) {
        if (name !== version) fs.rmSync(path.join(buildDir, name), { recursive: true, force: true });
    }
}

console.log(`已发布 ${files.length} 个文件 → ${outDir}`);
console.log(`cordis.patch.yml 入口 → ${entryUrl}`);
console.log('下一步：在 DSH 里把 dsh-api-runner bundle 关掉再打开（set_bundle false → true）');
