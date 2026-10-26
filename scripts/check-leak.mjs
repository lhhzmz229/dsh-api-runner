#!/usr/bin/env node
/**
 * 发布前防泄漏检查（prepublishOnly 自动执行）。
 *
 * 为什么需要它：
 *   仓库里有一份 RELEASE.local.md（本地发版流程），含本机绝对路径、用户名、
 *   Git 凭据助手路径。它被 .gitignore 和 npm files 白名单双重排除，
 *   但「双重排除」靠的是配置正确——一次手滑（往 files 里加一行、或 git add -f）
 *   就会泄漏。这里在发布前做一次硬检查，命中就中止发布。
 *
 * 检查两类东西：
 *   1. 会被打进 npm 包的文件里，有没有本机绝对路径 / 用户名
 *   2. 有没有真实凭据（token / 私钥 / 密码字面量）
 *
 * 退出码非 0 时 npm publish 会被中止。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

/**
 * 会被打进包的文件清单。
 * 优先用 package.json 的 files 白名单展开，避免和实际打包内容不一致。
 */
function listPackagedFiles() {
    const out = [];
    const always = ['package.json', 'README.md', 'LICENSE'];
    for (const name of always) {
        const p = path.join(root, name);
        if (fs.existsSync(p)) out.push(name);
    }
    const walk = (rel) => {
        const abs = path.join(root, rel);
        if (!fs.existsSync(abs)) return;
        const stat = fs.statSync(abs);
        if (stat.isDirectory()) {
            for (const entry of fs.readdirSync(abs)) walk(path.join(rel, entry));
        } else {
            out.push(rel.replace(/\\/g, '/'));
        }
    };
    for (const entry of pkg.files || []) {
        // 处理 "locale/*.json" 这类通配
        if (entry.includes('*')) {
            const dir = path.dirname(entry);
            const pattern = path.basename(entry);
            const absDir = path.join(root, dir);
            if (!fs.existsSync(absDir)) continue;
            const re = new RegExp(`^${pattern.replace(/\./g, '\\.').replace(/\*/g, '.*')}$`);
            for (const f of fs.readdirSync(absDir)) {
                if (re.test(f)) out.push(path.join(dir, f).replace(/\\/g, '/'));
            }
        } else {
            walk(entry);
        }
    }
    return [...new Set(out)];
}

/** 只检查文本文件；二进制跳过（图片等） */
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.yml', '.yaml', '.md', '.ts', '.txt', '.css', '.html']);

/**
 * 泄漏规则：命中任意一条就中止。
 * 注意：不把「用户名」本身当规则（作者名会正常出现在 package.json），
 * 只拦「绝对路径」这种能定位到具体机器的信息。
 */
const RULES = [
    { name: 'Windows 用户目录绝对路径', re: /[A-Za-z]:\\+Users\\+[^\\\s"']+/i },
    { name: 'POSIX 家目录绝对路径', re: /\/home\/[a-z0-9_-]+\//i },
    { name: 'macOS 用户目录绝对路径', re: /\/Users\/[A-Za-z0-9_-]+\//i },
    { name: '本机 link: 安装路径', re: /link:[A-Za-z]:[\\/]/i },
    { name: 'file:// 本机路径', re: /file:\/\/\/[A-Za-z]:/i },
    { name: 'npm token', re: /npm_[A-Za-z0-9]{30,}/ },
    { name: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{30,}/ },
    { name: '私钥块', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
    { name: 'OpenAI 风格密钥', re: /sk-[A-Za-z0-9]{32,}/ },
];

/**
 * 白名单：这些行是「示例/说明」，允许出现类似路径的文本。
 * 只放行明确无害的写法，不放行真实绝对路径。
 *
 * 原则：示例里用的应该是通用占位（`you`、`<用户名>`、`path/to`），
 * 一旦出现真实用户名（比如本机的 MZ），规则就会命中——这才是要拦的。
 */
const ALLOW_LINE = [
    /你的项目根目录/, /绝对路径\/到/, /<绝对路径>/, /link:\/绝对路径/,
    /link:[A-Za-z]:\/(?:path|绝对)/i,          // README 里的 link:D:/path/to/...
    /\/Users\/(?:you|your|用户名|username)\//i,  // 占位用户名
    /D:\\+data\\/, /D:\\+dsh-api-runner-data/,
    /D:\\?data/, /example/i, /示例/,
];

const files = listPackagedFiles();
const problems = [];
const scanned = [];

for (const rel of files) {
    const ext = path.extname(rel).toLowerCase();
    if (!TEXT_EXT.has(ext)) continue;
    const abs = path.join(root, rel);
    let text;
    try {
        text = fs.readFileSync(abs, 'utf8');
    } catch {
        continue;
    }
    scanned.push(rel);
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (ALLOW_LINE.some((re) => re.test(line))) continue;
        for (const rule of RULES) {
            if (rule.re.test(line)) {
                problems.push({
                    file: rel,
                    line: i + 1,
                    rule: rule.name,
                    snippet: line.trim().slice(0, 120),
                });
            }
        }
    }
}

// 额外确认：敏感文件绝不能被 files 白名单覆盖
const FORBIDDEN = ['RELEASE.local.md'];
for (const name of FORBIDDEN) {
    if (files.some((f) => f.endsWith(name) || f === name)) {
        problems.push({ file: name, line: 0, rule: '敏感文件被打进包', snippet: name });
    }
}

console.log(`[check-leak] 扫描 ${scanned.length} 个文本文件（共打包 ${files.length} 个）`);

if (problems.length > 0) {
    console.error('\n✗ 发现疑似泄漏，已中止发布：\n');
    for (const p of problems) {
        console.error(`  ${p.file}${p.line ? `:${p.line}` : ''}  [${p.rule}]`);
        if (p.snippet) console.error(`    ${p.snippet}`);
    }
    console.error('\n如果确认这些是无害的示例文本，把它们加进 scripts/check-leak.mjs 的 ALLOW_LINE。');
    process.exit(1);
}

console.log('✓ 未发现本地路径或凭据泄漏');
