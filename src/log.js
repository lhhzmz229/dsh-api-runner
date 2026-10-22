/**
 * 日志增量读取：按字节游标读文件尾部新增内容，支持正则过滤与"等到某行出现"。
 *
 * 设计要点：
 *  - 游标持久化在 ${DSH_HOME}/api-runner-state.json，按 logId 记录 {offset, inode, size}；
 *  - 检测截断/轮转：记录 inode 与上次 size，当前 size 小于上次 offset（或 inode 变化）就从头读；
 *  - 只读新增字节上限，避免把几十 MB 日志读进上下文；返回给模型前再做 maxLines 截断；
 *  - waitFor：轮询直到匹配行出现或超时，用于"重启服务→等启动完成日志"。
 */
import fs from 'node:fs';
import { isPlainObject, readStateNamespace, sleep, truncateText, writeStateNamespace } from './util.js';

const MAX_DEFAULT_BYTES = 64 * 1024;
const MAX_DEFAULT_LINES = 400;

export class LogReader {
    constructor(options = {}) {
        this.statePath = options.statePath || '';
        this._state = null;
        this._stateDirty = false;
    }

    /** 读取状态文件（惰性加载一次） */
    _loadState() {
        if (this._state) return this._state;
        this._state = readStateNamespace(this.statePath, 'logs');
        return this._state;
    }

    /** 写回状态文件（只更新 logs 命名空间，保留 services 记录） */
    save() {
        if (!this.statePath || !this._state) return;
        writeStateNamespace(this.statePath, 'logs', this._state);
        this._stateDirty = false;
    }

    /** 当前记录的文件大小与 inode，用于轮转检测 */
    stat(logPath) {
        const stat = fs.statSync(logPath);
        return { size: stat.size, ino: String(stat.ino ?? ''), mtimeMs: stat.mtimeMs };
    }

    /**
     * 增量读取。
     * @param {{id:string,path:string}} log
     * @param {{reset?:boolean, fromOffset?:number, maxBytes?:number, maxLines?:number,
     *          pattern?:string, ignoreCase?:boolean, invert?:boolean}} options
     */
    read(log, options = {}) {
        const filePath = log.path;
        if (!filePath) throw new Error(`日志 ${log.id} 未配置 path`);
        let stat;
        try {
            stat = this.stat(filePath);
        } catch (error) {
            throw new Error(`读取日志文件失败 ${filePath}: ${error.message}`);
        }

        const state = this._loadState();
        const record = isPlainObject(state[log.id]) ? state[log.id] : {};
        let start = Number.isInteger(options.fromOffset) ? Number(options.fromOffset) : Number(record.offset || 0);
        const rotated = record.ino !== undefined && record.ino !== '' && String(record.ino) !== stat.ino;
        const truncated = stat.size < start;
        const firstRead = record.offset === undefined;
        let note = '';

        if (options.reset) {
            start = 0;
            note = 'reset：从头读取';
        } else if (rotated || truncated) {
            start = 0;
            note = rotated ? '检测到日志轮转（inode 变化），从头读取' : '检测到日志截断（文件变小），从头读取';
        } else if (firstRead && options.fromTail !== false) {
            // 首次读取默认只取尾部一段，避免把历史全量灌进上下文
            const tailBytes = Number(options.maxBytes || MAX_DEFAULT_BYTES);
            start = Math.max(0, stat.size - tailBytes);
            note = `首次读取，从末尾 ${tailBytes} 字节开始（如需全量请传 reset:true）`;
        }

        const maxBytes = Number(options.maxBytes || MAX_DEFAULT_BYTES);
        const available = Math.max(0, stat.size - start);
        const take = Math.min(available, maxBytes);
        let text = '';
        let end = start + take;
        if (take > 0) {
            const buffer = Buffer.allocUnsafe(take);
            const fd = fs.openSync(filePath, 'r');
            try {
                const read = fs.readSync(fd, buffer, 0, take, start);
                text = buffer.subarray(0, read).toString(log.encoding || 'utf8');
                end = start + read;
            } finally {
                fs.closeSync(fd);
            }
        }
        // 截断到最后一个完整行，剩余留到下次
        if (end < stat.size && !text.endsWith('\n')) {
            const cut = text.lastIndexOf('\n');
            if (cut >= 0) {
                end = start + Buffer.byteLength(text.slice(0, cut + 1), 'utf8');
                text = text.slice(0, cut + 1);
            }
        }

        // 按行切分：只丢掉结尾因换行产生的空元素，正文里的空行保留
        const rawLines = text === '' ? [] : text.split(/\r?\n/);
        if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();
        let lines = rawLines;
        if (options.pattern) {
            let regex;
            try {
                regex = new RegExp(options.pattern, options.ignoreCase ? 'i' : '');
            } catch (error) {
                throw new Error(`pattern 不是合法正则：${error.message}`);
            }
            lines = lines.filter((line) => (options.invert ? !regex.test(line) : regex.test(line)));
        }

        const maxLines = Number(options.maxLines || MAX_DEFAULT_LINES);
        const totalLines = lines.length;
        const limited = lines.length > maxLines ? lines.slice(-maxLines) : lines;
        const bodyText = truncateText(limited.join('\n'), Math.max(maxBytes * 2, 4096));

        state[log.id] = { offset: end, ino: stat.ino, size: end, updatedAt: new Date().toISOString() };
        this._stateDirty = true;
        // 每次读完立即落盘：DSH 重启后游标才不丢（状态文件很小，开销可忽略）
        this.save();

        return {
            ok: true,
            logId: log.id,
            name: log.name,
            path: filePath,
            fileSize: stat.size,
            fromOffset: start,
            nextOffset: end,
            remainingBytes: Math.max(0, stat.size - end),
            totalLines,
            returnedLines: limited.length,
            droppedLines: Math.max(0, totalLines - limited.length),
            text: bodyText,
            note,
        };
    }

    /**
     * 轮询等待匹配行出现。
     * @param {{id:string,path:string}} log
     * @param {{pattern?:string, timeoutMs?:number, intervalMs?:number, maxBytes?:number,
     *          maxLines?:number, reset?:boolean, ignoreCase?:boolean}} options
     */
    async waitFor(log, options = {}) {
        const timeoutMs = Number(options.timeoutMs || 60_000);
        const intervalMs = Math.max(100, Number(options.intervalMs || 500));
        const started = Date.now();
        let cursor = Number.isInteger(options.fromOffset) ? Number(options.fromOffset) : undefined;
        const chunks = [];
        let matched = false;

        while (Date.now() - started <= timeoutMs) {
            const result = this.read(log, {
                fromOffset: cursor,
                maxBytes: Number(options.maxBytes || 16 * 1024),
                maxLines: Number(options.maxLines || 200),
                pattern: options.pattern,
                ignoreCase: options.ignoreCase,
                reset: chunks.length === 0 ? options.reset : false,
            });
            cursor = result.nextOffset;
            if (result.text !== '') chunks.push(result.text);
            if (options.pattern && result.totalLines > 0) {
                matched = true;
                break;
            }
            if (!options.pattern && result.text !== '') {
                matched = true;
                break;
            }
            await sleep(intervalMs);
        }

        return {
            // 超时未命中时 ok 为 false，让调用方（工具/verify）能直接判定失败
            ok: matched,
            logId: log.id,
            path: log.path,
            pattern: options.pattern || '',
            matched,
            waitedMs: Date.now() - started,
            text: truncateText(chunks.join('\n'), Number(options.maxBytes || 16 * 1024) * 2),
        };
    }

    /** 暴露给上层的游标快照 */
    snapshot(logId) {
        const state = this._loadState();
        return isPlainObject(state[logId]) ? { ...state[logId] } : undefined;
    }

    resetCursor(logId) {
        const state = this._loadState();
        delete state[logId];
        this._stateDirty = true;
    }

    dispose() {
        if (this._stateDirty) this.save();
    }
}
