// 在 Node 里模拟 Google Apps Script 运行 Code.gs，用来做端到端测试：node test/gas-mock.mjs [端口]
// OpenRouter 也是模拟的：识别截屏返回固定格式的文字，起标题返回固定标题。
import fs from 'node:fs';
import http from 'node:http';
import vm from 'node:vm';
import crypto from 'node:crypto';
import path from 'node:path';

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const PORT = Number(process.argv[2] || 8787);
export const LOG = [];

function makeBlob(bytes, mime, name) {
  const buf = Buffer.isBuffer(bytes) ? bytes : typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes);
  return { _b: buf, getBytes: () => buf, getDataAsString: () => buf.toString('utf8'), getContentType: () => mime || 'application/octet-stream', getName: () => name };
}
let fid = 0;
export const FILES = new Map();
function makeFile(name, blob, parent) {
  const f = { id: 'f' + (++fid), name, blob, trashed: false, parent,
    getId() { return this.id; }, getName() { return this.name; }, setName(n) { this.name = n; return this; }, getBlob() { return this.blob; },
    isTrashed() { return this.trashed; },
    setContent(c) { this.blob = makeBlob(c, this.blob.getContentType()); return this; }, setTrashed(t) { this.trashed = t; } };
  FILES.set(f.id, f); return f;
}
function iter(arr) { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; }
function makeFolder(name, parent) {
  return { name, parent, folders: [], files: [],
    getName() { return this.name; },
    getFoldersByName(n) { return iter(this.folders.filter(f => f.name === n)); },
    createFolder(n) { const f = makeFolder(n, this); this.folders.push(f); return f; },
    getFilesByName(n) { return iter(this.files.filter(f => f.name === n && !f.trashed)); },
    getFiles() { return iter(this.files.filter(f => !f.trashed)); },
    createFile(a, content, mime) {
      const f = typeof a === 'string' ? makeFile(a, makeBlob(content, mime), this) : makeFile(a.getName(), a, this);
      this.files.push(f); return f;
    } };
}
export const DRIVE = makeFolder('My Drive');
const PROPS = {};
let TRIGGERS = [];
const folderPath = f => f ? (f.parent ? folderPath(f.parent) + '/' : '') + f.name : '';

function fmtDate(d, tz, fmt) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' })
    .formatToParts(d).map(p => [p.type, p.value]));
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const off = Math.round((asUTC - Math.floor(d.getTime() / 1000) * 1000) / 60000);
  const Z = (off >= 0 ? '+' : '-') + String(Math.floor(Math.abs(off) / 60)).padStart(2, '0') + String(Math.abs(off) % 60).padStart(2, '0');
  const u = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[parts.weekday];
  return fmt.replace(/yyyy|MM|dd|HH|mm|ss|M|d|u|Z/g, t => ({ yyyy: parts.year, MM: parts.month, dd: parts.day, HH: parts.hour, mm: parts.minute, ss: parts.second, M: String(+parts.month), d: String(+parts.day), u: String(u), Z }[t]));
}

// ocr：每次识别的记录；titles：起标题的记录。小于 2KB 的图当作“没有文字”。
export const OR = { ocr: [], titles: [], calls: [], failOcr: false, delay: 300 };
const SRC = ['X', '小红书', '微信', 'Telegram'];
const ctx = {
  console,
  PropertiesService: { getScriptProperties: () => ({
    getProperty: k => (k in PROPS ? PROPS[k] : null), setProperty: (k, v) => { PROPS[k] = String(v); }, deleteProperty: k => { delete PROPS[k]; }, getProperties: () => ({ ...PROPS }) }) },
  DriveApp: { getFoldersByName: n => DRIVE.getFoldersByName(n), createFolder: n => DRIVE.createFolder(n), getFileById: id => { const f = FILES.get(id); if (!f) throw new Error('no file ' + id); return f; } },
  Utilities: {
    base64Decode: s => Buffer.from(s, 'base64'), base64Encode: b => Buffer.from(b).toString('base64'),
    base64EncodeWebSafe: b => Buffer.from(b).toString('base64url') + '=', base64DecodeWebSafe: s => Buffer.from(s, 'base64url'),
    newBlob: (b, mime, name) => makeBlob(b, mime, name),
    computeHmacSha256Signature: (v, k) => crypto.createHmac('sha256', Buffer.from(k)).update(Buffer.from(v)).digest(),
    getUuid: () => crypto.randomUUID(),
    formatDate: fmtDate
  },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  UrlFetchApp: { fetch(url, o) {
    o = o || {};
    const key = (o.headers || {}).Authorization;
    if (url.endsWith('/key')) return resp(key === 'Bearer sk-or-test' ? 200 : 401, { data: { label: 'test', usage: 1.5, limit: 10, limit_remaining: 8.5 } });
    if (key !== 'Bearer sk-or-test') return resp(401, { error: { message: 'bad key' } });
    const p = JSON.parse(o.payload);
    if (url.endsWith('/chat/completions')) {
      const c = p.messages[0].content;
      const effort = p.reasoning && p.reasoning.effort;
      OR.calls.push({ model: p.model, effort, image: Array.isArray(c) });
      // 模拟 Gemini 3：不允许关掉思考
      if (/gemini-3/.test(p.model) && effort === 'none') return resp(400, { error: { message: 'Reasoning is mandatory for this endpoint and cannot be disabled.' } });
      if (Array.isArray(c)) {
        const imgs = c.filter(x => x.type === 'image_url').map(x => {
          const m = x.image_url.url.match(/^data:([^;]+);base64,(.*)$/);
          return { mime: m[1], bytes: Buffer.from(m[2], 'base64').length };
        });
        const k = OR.ocr.length;
        OR.ocr.push({ model: p.model, effort, parts: imgs.length, imgs, prompt: c[0].text });
        if (OR.failOcr) return resp(502, { error: { message: 'provider down' } });
        if (imgs.every(i => i.bytes < 2500)) return resp(200, { choices: [{ message: { content: '来源：其他\n\n（无文字）' } }] });
        return resp(200, { choices: [{ message: { content: `来源：${SRC[k % 4]}\n\n第${k + 1}张截屏 共${imgs.length}段\n今天要记得买牛奶。\n关键词 苹果${k + 1}` } }] });
      }
      OR.titles.push({ model: p.model, effort, prompt: c });
      const m = String(c).match(/关键词 (苹果\d+)/);
      return resp(200, { choices: [{ message: { content: '「' + (m ? m[1] + '的笔记' : '合并的笔记') + '」' } }] });
    }
    return resp(404, { error: 'unknown' });
  } },
  ScriptApp: {
    getProjectTriggers: () => TRIGGERS,
    deleteTrigger: t => { TRIGGERS = TRIGGERS.filter(x => x !== t); },
    newTrigger: h => { const t = { h, getHandlerFunction: () => h, spec: {} }; const b = { timeBased: () => b, everyHours: x => (t.spec.every = x, b), create: () => (TRIGGERS.push(t), t) }; return b; }
  },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ s, setMimeType() { return this; } }) }
};
function resp(code, obj) { const t = JSON.stringify(obj); return { getResponseCode: () => code, getContentText: () => t }; }

let code = fs.readFileSync(path.join(root, 'google-drive/Code.gs'), 'utf8').replace("const SETUP_CODE = '改成你的管理员初始邀请码'", "const SETUP_CODE = 'ADMIN-TEST'");
code = code.replace(/^const /gm, 'var ');
vm.createContext(ctx);
vm.runInContext(code, ctx, { filename: 'Code.gs' });
export const GAS = ctx;
export function triggers() { return TRIGGERS.map(t => ({ h: t.h, ...t.spec })); }
export function files() { return [...FILES.values()].map(f => ({ id: f.id, name: f.name, trashed: f.trashed, path: folderPath(f.parent), text: f.blob.getDataAsString() })); }

export function start(port = PORT) {
  const srv = http.createServer((req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
    if (req.method === 'OPTIONS') { LOG.push('PREFLIGHT'); res.writeHead(204, cors); return res.end(); }
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      if (req.method === 'GET') { const o = ctx.doGet(); res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); return res.end(o.s); }
      let a = '?'; try { a = JSON.parse(body).action; } catch (e) {}
      LOG.push(a + ' ' + body.length + ' ' + (req.headers['content-type'] || ''));
      const run = () => { const o = ctx.doPost({ postData: { contents: body } }); res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); res.end(o.s); };
      a === 'add' ? setTimeout(run, OR.delay) : run();      // 模拟识别要花点时间
    });
  });
  srv.listen(port);
  return srv;
}
if (process.argv[1] && process.argv[1].endsWith('gas-mock.mjs')) { start(); console.log('mock GAS on', PORT); }
