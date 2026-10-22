/**
 * 插件级设置（跨项目共用一份）。
 *
 * 存在 `${DSH_HOME}/api-runner-settings.json`，与项目配置分开：
 * 项目配置（YAML / 面板保存的接口）是「这个项目怎么调接口」，
 * 这里是「插件把运行数据写到哪」这类机器级偏好。
 *
 * 结构：
 * {
 *   version: 1,
 *   dataDir: "/abs/path/.dsh-api-runner",   // 空表示用 DSH_HOME；必须是绝对路径
 *   workspace: "/abs/path/your-project",    // 面板默认项目根（可选）
 *   mavenHome: "/abs/path/apache-maven-3.6.3" // Maven 主路径（可选；空表示自动探测）
 * }
 */
import fs from 'node:fs';
import path from 'node:path';
import { isPlainObject } from './util.js';

export class SettingsStore {
    constructor(options = {}) {
        this.homeDir = options.homeDir || process.env.DSH_HOME || path.join(process.cwd(), '.dsh');
        this.file = path.join(this.homeDir, 'api-runner-settings.json');
        this._doc = undefined;
        this._mtimeMs = -1;
    }

    _load() {
        let stat;
        try {
            stat = fs.statSync(this.file);
        } catch {
            this._doc = { version: 1, dataDir: '', workspace: '', mavenHome: '' };
            this._mtimeMs = -1;
            return this._doc;
        }
        if (this._doc !== undefined && stat.mtimeMs === this._mtimeMs) return this._doc;
        try {
            const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            this._doc = isPlainObject(parsed) ? parsed : { version: 1 };
        } catch {
            this._doc = { version: 1 };
        }
        this._mtimeMs = stat.mtimeMs;
        return this._doc;
    }

    _save(doc) {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
        fs.renameSync(tmp, this.file);
        this._doc = doc;
        this._mtimeMs = fs.statSync(this.file).mtimeMs;
    }

    /** 当前设置（对外展示用） */
    read() {
        const doc = this._load();
        return {
            dataDir: String(doc.dataDir || ''),
            workspace: String(doc.workspace || ''),
            mavenHome: String(doc.mavenHome || ''),
            /** 生效的运行数据目录：没配就用 DSH_HOME */
            effectiveDataDir: this.dataDir(),
            homeDir: this.homeDir,
            settingsFile: this.file,
        };
    }

    /**
     * 运行数据落盘目录。
     * 配了 dataDir 就用它（相对路径按 DSH_HOME 解析，避免用户填了个相对路径不知道落到哪）；
     * 否则退回 DSH_HOME，与老版本行为一致。
     */
    dataDir() {
        const doc = this._load();
        const raw = String(doc.dataDir || '').trim();
        if (!raw) return this.homeDir;
        return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(this.homeDir, raw);
    }

    set(patch = {}) {
        const doc = this._load();
        if (patch.dataDir !== undefined) {
            const raw = String(patch.dataDir || '').trim();
            if (raw !== '' && !path.isAbsolute(raw)) {
                const sample = process.platform === 'win32' ? 'D:\\dsh-api-runner-data' : '/Users/you/dsh-api-runner-data';
                throw new Error(`数据目录必须是绝对路径，例如 ${sample}`);
            }
            doc.dataDir = raw;
        }
        if (patch.workspace !== undefined) {
            const raw = String(patch.workspace || '').trim();
            doc.workspace = raw;
        }
        if (patch.mavenHome !== undefined) {
            const raw = String(patch.mavenHome || '').trim();
            if (raw !== '' && !path.isAbsolute(raw)) {
                const sample = process.platform === 'win32' ? 'D:\\apache-maven-3.9.6' : '/opt/apache-maven-3.9.6';
                throw new Error(`Maven 主路径必须是绝对路径（到安装目录为止），例如 ${sample}`);
            }
            doc.mavenHome = raw;
        }
        doc.version = 1;
        this._save(doc);
        return this.read();
    }
}
