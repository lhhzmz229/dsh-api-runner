/**
 * 「接管 IDEA 服务」真实进程自测。
 *
 * 单测没法覆盖这条链路的关键点，所以真的起一个 Java 进程当替身：
 *   1. 用 javac 编译一个自带 HTTP 服务的 FakeService（模仿 IDEA 启动：带 jdwp 参数）；
 *   2. 用 java 直接拉起它 → 这就是「IDEA 起的那个进程」；
 *   3. 调 JavaRunner.start 接管：快照 → 杀旧进程 → 用去掉调试参数的方式重新拉起；
 *   4. 验证新进程能讲 HTTP、日志文件有内容、面板能区分 owner；
 *   5. 验证 stop 只停插件自己的、restart 换 pid。
 *
 * 依赖本机 JDK。找不到 java/javac 时整体跳过（不算失败），
 * 否则 CI 机器上没装 JDK 会一片红。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);

let passed = 0;
async function ok(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log(`  ✓ ${name}`);
    } catch (error) {
        console.error(`  ✗ ${name}\n    ${error?.stack || error}`);
        process.exitCode = 1;
    }
}

async function freePort() {
    const server = net.createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    await new Promise((r) => server.close(r));
    return port;
}

/** 找一个可用的 JDK（JAVA_HOME 优先，其次 PATH 上的 java/javac） */
function findJdk() {
    const exe = process.platform === 'win32' ? '.exe' : '';
    const names = (home) => ({ home, java: path.join(home, 'bin', `java${exe}`), javac: path.join(home, 'bin', `javac${exe}`) });
    const candidates = [process.env.JAVA_HOME].filter(Boolean).map(names);
    // macOS 下 JAVA_HOME 常为空，用系统自带的 java_home 工具问一下
    if (process.platform === 'darwin') {
        try {
            const detected = execFileSync('/usr/libexec/java_home', { encoding: 'utf8' }).trim();
            if (detected) candidates.push(names(detected));
        } catch { /* 没装 JDK 就走下面的跳过分支 */ }
    }
    for (const item of candidates) {
        if (fs.existsSync(item.java) && fs.existsSync(item.javac)) return item;
    }
    // 最后退回 PATH：先问 java 自己 java.home 在哪，必须用它 bin 下的真身。
    // 坑：`C:\Program Files\Common Files\Oracle\Java\javapath\java.exe` 只是个转发壳，
    // 它会再起一个子进程跑真正的 JVM，于是 spawn 拿到的 pid 是壳的、jcmd 附加到壳上会报
    // AttachNotSupportedException: jvm.dll not loaded by target process。
    try {
        execFileSync('javac', ['-version'], { stdio: 'ignore' });
        // 注意：`-XshowSettings:properties` 的内容打在 stderr，不是 stdout
        const probe = spawnSync('java', ['-XshowSettings:properties', '-version'], { encoding: 'utf8' });
        const found = /java\.home = (.+)/.exec(`${probe.stdout || ''}\n${probe.stderr || ''}`);
        if (found) {
            const real = names(found[1].trim());
            if (fs.existsSync(real.java) && fs.existsSync(real.javac)) return real;
        }
    } catch {
        return undefined;
    }
    return undefined;
}

const jdk = findJdk();
if (!jdk) {
    console.log('java runner: SKIPPED（本机没有 JDK，跳过接管链路自测）');
    process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'api-runner-java-'));
const homeDir = path.join(tmp, 'home');
const cwd = tmp;
const port = await freePort();
const debugPort = await freePort();

// 替身服务：只用 com.sun.net.httpserver（JDK 自带，不依赖第三方 jar）
const source = path.join(tmp, 'FakeService.java');
fs.writeFileSync(
    source,
    `import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
public class FakeService {
    public static void main(String[] args) throws Exception {
        int port = Integer.parseInt(System.getProperty("fake.port", "${port}"));
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
        server.createContext("/", exchange -> {
            byte[] body = ("{\\"ok\\":true,\\"port\\":" + port + "}").getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
        System.out.println("fake service started on " + port);
        Thread.currentThread().join();
    }
}
`,
    'utf8',
);

let compiled = true;
try {
    execFileSync(jdk.javac, ['-encoding', 'UTF-8', '-d', tmp, source], { stdio: 'ignore', timeout: 60_000 });
} catch (error) {
    compiled = false;
    console.error('  ! javac 编译失败，跳过接管测试', error?.message);
}

if (compiled) {
    const { JavaRunner } = await load('src/java-runner.js');
    const { isAlive, getJavaSnapshot, buildRestartArgv, killProcessTree, compileModule } = await load('src/restart.js');
    const { listJavaProcesses } = await load('src/java.js');

    const { spawn } = await import('node:child_process');
    const runner = new JavaRunner({ homeDir });
    let sourcePid = 0;

    // 模仿 IDEA：把调试参数放在最前面（suspend=n 才能自动化）
    const ideaLikeArgs = [
        `-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:${debugPort}`,
        `-Dfake.port=${port}`,
        '-Dspring.output.ansi.enabled=always',
        '-cp', tmp,
        'FakeService',
    ];

    console.log('java runner (接管 IDEA 进程):');
    await ok('替身服务能启动并响应 HTTP（模拟 IDEA 起的进程）', async () => {
        const child = spawn(jdk.java, ideaLikeArgs, { cwd: tmp, stdio: 'ignore', detached: true, windowsHide: true });
        child.unref();
        sourcePid = child.pid;
        assert.ok(sourcePid > 0);
        const deadline = Date.now() + 20_000;
        let body = '';
        while (Date.now() < deadline) {
            // eslint-disable-next-line no-await-in-loop
            const result = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text()).catch(() => '');
            if (result) {
                body = result;
                break;
            }
            // eslint-disable-next-line no-await-in-loop
            await new Promise((r) => setTimeout(r, 300));
        }
        assert.match(body, /"ok":true/);
    });

    await ok('getJavaSnapshot 能读出主类/classpath/工作目录', async () => {
        const snapshot = await getJavaSnapshot(sourcePid);
        assert.equal(snapshot.ok, true, snapshot.message);
        assert.equal(snapshot.mainClass, 'FakeService');
        assert.equal(path.resolve(snapshot.cwd).toLowerCase(), path.resolve(tmp).toLowerCase());
        assert.match(snapshot.classPath, /api-runner-java-/);
        assert.equal(snapshot.programArgs.length, 0);
    });

    await ok('classpath 取完整值（jcmd VM.command_line 会截断，必须用 system_properties）', async () => {
        // 真实案例：某 Spring Cloud 服务有 218 条依赖、21335 字符，jcmd VM.command_line
        // 只返回了 1998 字符（前 19 条），照它重启会缺 jar。这里造一个超长 classpath 复现。
        const pad = path.join(tmp, 'x'.repeat(200), 'pad.jar');
        const hugeCp = Array.from({ length: 12 }, (_unused, index) => (index % 2 ? pad : tmp)).join(';');
        const otherPort = await freePort();
        const longJava = spawn(jdk.java, [`-Dfake.port=${otherPort}`, '-cp', hugeCp, 'FakeService'], {
            cwd: tmp,
            stdio: 'ignore',
            detached: true,
            windowsHide: true,
        });
        longJava.unref();
        try {
            // jcmd 对新进程要等一下才能附加
            let snapshot;
            const until = Date.now() + 10_000;
            while (Date.now() < until) {
                // eslint-disable-next-line no-await-in-loop
                snapshot = await getJavaSnapshot(longJava.pid);
                if (snapshot.ok) break;
                // eslint-disable-next-line no-await-in-loop
                await new Promise((r) => setTimeout(r, 400));
            }
            assert.equal(snapshot.ok, true, snapshot.message);
            assert.equal(snapshot.classPath, hugeCp, 'classpath 必须与启动时完全一致，不能被截断');
        } finally {
            await killProcessTree(longJava.pid);
        }
    });

    await ok('buildRestartArgv 剥掉 suspend=y 的调试参数，改成可远程挂载的 server=y', async () => {
        const snapshot = await getJavaSnapshot(sourcePid);
        const built = buildRestartArgv(snapshot, { debug: 'port', debugPort });
        assert.ok(built.argv.some((arg) => /-agentlib:jdwp=[^\s]*server=y,suspend=n/.test(arg)), '应带 server=y,suspend=n');
        assert.ok(!built.argv.some((arg) => /suspend=y/.test(arg)), '不应残留 suspend=y');
        assert.equal(built.argv[built.argv.length - 1], 'FakeService', '主类必须是最后一个参数');
    });

    await ok('start 接管：杀掉 IDEA 的进程，用同样参数拉起新的，端口恢复可用', async () => {
        const result = await runner.start(cwd, { pid: sourcePid, port, compile: false, timeoutMs: 40_000 });
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.notEqual(result.pid, sourcePid, '应产生新 pid');
        assert.equal(isAlive(sourcePid), false, '原 IDEA 进程应已退出');
        assert.equal(isAlive(result.pid), true);
        const body = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
        assert.match(body, /"ok":true/);
    });

    await ok('日志文件里有启动输出（面板「详情」读的就是它）', async () => {
        const runs = runner.runs(cwd);
        assert.equal(runs.length, 1);
        const run = runs[0];
        assert.equal(run.id, 'FakeService');
        const log = runner.logs(cwd, 'FakeService', { fromOffset: 0 });
        assert.equal(log.ok, true);
        assert.match(log.text, /fake service started on \d+/);
        assert.equal(log.alive, true);
        assert.equal(log.pid, run.pid);
    });

    await ok('日志支持按偏移增量读取', async () => {
        const first = runner.logs(cwd, 'FakeService', { fromOffset: 0 });
        const second = runner.logs(cwd, 'FakeService', { fromOffset: first.nextOffset });
        assert.equal(second.fromOffset, first.nextOffset);
        assert.equal(second.text, '', '没有新内容时增量应为空');
        assert.equal(second.remainingBytes, 0);
    });

    await ok('listJavaProcesses 能识别插件托管的进程（带 -DdshApiRunner.runId）', async () => {
        const list = await listJavaProcesses();
        const mine = list.processes.find((item) => item.pid === runner.runs(cwd)[0].pid);
        assert.ok(mine, 'jps 应能看到插件拉起的进程');
        assert.match(mine.systemProperties['dshApiRunner.runId'] || '', /FakeService/);
    });

    await ok('stop 只停插件自己起的进程，停止后记录仍在（可再次启动）', async () => {
        const pid = runner.runs(cwd)[0].pid;
        const result = await runner.stop(cwd, 'FakeService');
        assert.equal(result.ok, true, JSON.stringify(result));
        await new Promise((r) => setTimeout(r, 400));
        assert.equal(isAlive(pid), false);
        const runs = runner.runs(cwd);
        assert.equal(runs.length, 1, '记录应保留，便于看历史日志/再启动');
        assert.equal(runs[0].alive, false);
        assert.ok(runs[0].stoppedAt, '应记录停止时间');
    });

    await ok('stop 对不存在的服务给出可读提示', async () => {
        const result = await runner.stop(cwd, 'NotExistService');
        assert.equal(result.ok, false);
        assert.equal(result.code, 'RUN_NOT_FOUND');
        assert.match(result.message, /IDEA/);
    });

    await ok('restart 能在停止状态下直接拉起（换新 pid）', async () => {
        const before = runner.runs(cwd)[0].pid;
        const result = await runner.restart(cwd, 'FakeService', { compile: false, timeoutMs: 40_000 });
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.notEqual(result.pid, before, '重启应换 pid');
        const body = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
        assert.match(body, /"ok":true/);
    });

    await ok('编译：mvn 路径含空格时能正确执行（cmd.exe 引号处理）', async () => {
        // IDEA 自带的 mvn 路径通常含空格（<安装目录>\plugins\maven\lib\maven3\bin\mvn.cmd），
        // 拼命令行时少一层引号就会把路径截断到第一个空格。这里用一个必然失败但
        // 语法合法的 mvn 替身脚本验证「命令真的被调起来过」而不是「路径被截断」。
        const fakeMvn = path.join(tmp, 'with space', 'mvn.cmd');
        fs.mkdirSync(path.dirname(fakeMvn), { recursive: true });
        fs.writeFileSync(fakeMvn, '@echo off\r\necho FAKE_MVN_RAN %*\r\nexit /b 0\r\n', 'utf8');
        const result = await compileModule({ mvn: fakeMvn, rootDir: tmp, artifactId: 'demo', timeoutMs: 30_000 });
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.match(result.output || '', /FAKE_MVN_RAN/, '替身脚本应被执行到');
    });

    await ok('清理：停掉测试进程', async () => {
        const run = runner.runs(cwd)[0];
        if (run && isAlive(run.pid)) await killProcessTree(run.pid);
        assert.equal(isAlive(run.pid), false);
    });
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${process.exitCode ? 'FAILED' : 'PASSED'}: ${passed} checks`);
