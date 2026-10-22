/**
 * 接口调用：按配置里的接口定义发 HTTP 请求。
 *
 * 约定：
 *  - url 支持 {param} 路径占位，params 里的键会同时用于路径替换与 query 拼接；
 *  - body 支持 {param} 模板展开；若 body 是对象且定义了 json 类型，序列化为 JSON；
 *  - 超时用 AbortSignal.timeout，失败统一返回结构化结果而不是抛异常（工具层好渲染）。
 */
import { expandBraces, expandDeep, isPlainObject, truncateText, tryJson } from './util.js';

const DEFAULT_TIMEOUT = 30_000;

/** 把 params 里未被 url 占位消耗的键拼成 query string */
function buildQuery(query, params, url) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query || {})) {
        if (value === undefined || value === null) continue;
        search.append(key, String(expandBraces(value, params)));
    }
    for (const [key, value] of Object.entries(params || {})) {
        if (value === undefined || value === null) continue;
        // url 占位已用的键不再重复进 query
        if (url.includes(`{${key}}`)) continue;
        if (key in (query || {})) continue;
        search.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    const text = search.toString();
    return text === '' ? '' : `?${text}`;
}

/** 拼接完整 URL：baseUrl + url（+ query），并对展开后的地址做合法性校验 */
function buildUrl(api, params) {
    let target = expandBraces(api.url, params);
    if (api.baseUrl) {
        const base = api.baseUrl.endsWith('/') ? api.baseUrl.slice(0, -1) : api.baseUrl;
        if (!/^https?:\/\//i.test(target)) target = `${base}/${target.replace(/^\//, '')}`;
    }
    const queryText = buildQuery(api.query, params, api.url).replace(/^\?/, '');
    let normalized = target;
    if (queryText !== '') normalized = `${target}${target.includes('?') ? '&' : '?'}${queryText}`;
    try {
        const parsed = new URL(normalized);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error(`不支持的协议 ${parsed.protocol}`);
        }
        return parsed.toString();
    } catch (error) {
        throw new Error(`接口 ${api.id} 的 URL 非法：${normalized}（${error.message}）`);
    }
}

/**
 * 依据 method 决定是否带 body，并按 content-type 处理。
 *
 * 注意：headers 是**真实要发出去的**请求头对象，这里必须原地补 content-type。
 * 早期实现内部又拷贝了一份，导致 JSON body 实际以 fetch 默认的
 * `text/plain;charset=UTF-8` 发出，Spring 端直接 500：
 * `Content type 'text/plain;charset=UTF-8' not supported`。
 */
function buildBody(api, params, headers) {
    const method = api.method;
    if (method === 'GET' || method === 'HEAD') return undefined;
    if (api.body === undefined || api.body === null) return undefined;

    const expanded = expandDeep(api.body, {}, params);
    const contentType = findHeader(headers, 'content-type');
    if (typeof expanded === 'string') {
        // body 是字符串时，如果内容看起来是 JSON 就按 JSON 发；否则明确用 text/plain。
        // 两者都必须**显式**设置：fetch 在没设 content-type 时默认 text/plain，
        // 对 Spring 的 @RequestBody JSON 接口会直接 500。
        if (!contentType) {
            setHeader(headers, 'content-type', tryJson(expanded) !== undefined
                ? 'application/json; charset=utf-8'
                : 'text/plain; charset=utf-8');
        }
        return expanded;
    }
    if (contentType && /x-www-form-urlencoded/i.test(contentType)) {
        return new URLSearchParams(flattenPairs(expanded)).toString();
    }
    if (!contentType) setHeader(headers, 'content-type', 'application/json; charset=utf-8');
    return JSON.stringify(expanded);
}

function flattenPairs(value) {
    const out = [];
    for (const [key, item] of Object.entries(value || {})) {
        if (item === undefined || item === null) continue;
        out.push([key, typeof item === 'object' ? JSON.stringify(item) : String(item)]);
    }
    return out;
}

function normalizeHeaders(headers) {
    const out = {};
    for (const [key, value] of Object.entries(headers || {})) {
        if (value === undefined || value === null) continue;
        out[key] = String(value);
    }
    return out;
}

function findHeader(headers, name) {
    const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
    return key ? headers[key] : undefined;
}

function setHeader(headers, name, value) {
    const existing = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
    if (existing) headers[existing] = value;
    else headers[name] = value;
}

/**
 * 执行一次接口调用。
 * @returns {Promise<{ok:boolean,apiId:string,method:string,url:string,status:number,statusText:string,
 *   durationMs:number,headers:Record<string,string>,body:string,json?:unknown,error?:string}>}
 */
export async function callApi(api, params = {}, options = {}) {
    const started = Date.now();
    const timeoutMs = Number(options.timeoutMs || api.timeoutMs || DEFAULT_TIMEOUT);
    const result = {
        ok: false,
        apiId: api.id,
        name: api.name,
        method: api.method,
        url: '',
        status: 0,
        statusText: '',
        durationMs: 0,
        headers: {},
        body: '',
    };

    let url;
    let headers;
    let body;
    try {
        url = buildUrl(api, params);
        headers = normalizeHeaders(expandDeep(api.headers || {}, {}, params));
        body = buildBody(api, params, headers);
    } catch (error) {
        result.error = error.message;
        result.durationMs = Date.now() - started;
        return result;
    }
    result.url = url;

    if (api.baseUrl) setHeader(headers, 'accept', findHeader(headers, 'accept') || 'application/json, text/plain, */*');

    try {
        const response = await fetch(url, {
            method: api.method,
            headers,
            body,
            signal: AbortSignal.timeout(timeoutMs),
            redirect: 'follow',
        });
        result.status = response.status;
        result.statusText = response.statusText;
        result.ok = response.ok;
        for (const [key, value] of response.headers.entries()) result.headers[key] = value;
        const text = await response.text();
        const maxBytes = Number(options.maxBodyBytes || 32 * 1024);
        result.body = truncateText(text, maxBytes);
        const parsed = tryJson(text);
        if (parsed !== undefined) result.json = parsed;
        if (text.length > (result.body || '').length) result.truncated = true;
    } catch (error) {
        result.error = error.name === 'TimeoutError'
            ? `请求超时（${timeoutMs}ms）`
            : String(error?.message || error);
    }
    result.durationMs = Date.now() - started;
    return result;
}

/** 从响应 JSON 里按简单路径取值（a.b[0].c），用于校验 */
export function pickPath(value, dotted) {
    if (!dotted || !isPlainObject(Object(value)) && !Array.isArray(value)) return undefined;
    let cursor = value;
    for (const raw of String(dotted).split('.')) {
        if (cursor === undefined || cursor === null) return undefined;
        const match = /^([^[\]]*)((\[\d+\])*)$/.exec(raw);
        if (!match) return undefined;
        const [, head, indexes] = match;
        if (head) cursor = cursor[head];
        for (const idx of indexes.match(/\d+/g) || []) {
            if (!Array.isArray(cursor)) return undefined;
            cursor = cursor[Number(idx)];
        }
    }
    return cursor;
}
