// 端到端测试：模拟服务器 + 真浏览器。node test/e2e.mjs
// 覆盖：注册、一次 10 张截屏识别（长截屏切段、无文字跳过）、图片不留档、三端同步、编辑、合并、删除、
//       24 小时后起标题并上传 Drive、改动后更新 Drive、拖拽/粘贴、安卓分享、离线排队、iPhone 快捷指令接口、邀请码。
import { start, GAS, LOG, OR, triggers, files } from './gas-mock.mjs';
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const out = path.join(root, 'test', 'out'); fs.mkdirSync(out, { recursive: true });
const API = 'http://127.0.0.1:8788/exec';
start(8788);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.gs': 'text/plain; charset=utf-8' };
http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r);
}).listen(8001);

const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) fails++; };
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
const UA = {
  pc: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36',
  ios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Mobile Safari/537.36'
};
async function device(name, ua, vp, scheme) {
  const c = await browser.newContext({ userAgent: ua, viewport: vp, colorScheme: scheme || 'light', permissions: ['clipboard-read', 'clipboard-write'] });
  await c.addInitScript(api => {
    if (!localStorage.getItem('linggan-server')) localStorage.setItem('linggan-server', api);
    window.confirm = () => true;
  }, API);
  const p = await c.newPage();
  p.on('pageerror', e => { console.log(`[${name}] PAGE ERROR`, e.message); fails++; });
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) console.log(`[${name}] console.error`, m.text()); });
  await p.goto('http://127.0.0.1:8001/');
  p.ctx = c;
  return p;
}
const notes = p => p.evaluate(() => [...N.values()].map(n => ({ id: n.id, t: n.t, title: n.title, text: n.text, source: n.source, count: n.count, drive: n.drive, dirty: n.dirty })));
const jobs = p => p.evaluate(() => [...JOBS.values()].map(j => ({ id: j.id, state: j.state, err: j.err, parts: j.parts.length })));
const idbJobs = p => p.evaluate(() => DB.all('jobs').then(a => a.length));
async function waitFor(fn, ms = 15000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(200); } return false; }

// ---------- 造一批截屏（在浏览器里用 canvas 画） ----------
const gen = await device('gen', UA.pc, { width: 400, height: 400 });
const shots = await gen.evaluate(() => {
  const mk = (w, h, label, blank) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
    g.fillStyle = blank ? '#fff' : '#f7f7f7'; g.fillRect(0, 0, w, h);
    if (!blank) { g.fillStyle = '#111'; g.font = '48px sans-serif'; for (let y = 80; y < h; y += 70) g.fillText(label + ' 这是一段测试文字 ' + y, 30, y); for (let i = 0; i < 4000; i++) { g.fillStyle = `rgb(${i % 255},${(i * 7) % 255},${(i * 13) % 255})`; g.fillRect((i * 37) % w, (i * 91) % h, 3, 3); } }
    return c.toDataURL('image/png').split(',')[1];
  };
  const a = [];
  for (let i = 0; i < 10; i++) a.push({ name: `shot${i}.png`, b64: mk(1170, 2532, '截屏' + i) });
  a[3] = { name: 'long.png', b64: mk(1080, 6000, '长截屏') };   // 长截屏：应该切成 3 段
  a[7] = { name: 'blank.png', b64: mk(60, 60, '', true) };     // 没有文字：应该跳过
  a.push({ name: 'shot10.png', b64: mk(1170, 2532, '多出来的') }, { name: 'shot11.png', b64: mk(1170, 2532, '多出来的2') });
  return a;
});
await gen.ctx.close();
const fileOf = s => ({ name: s.name, mimeType: 'image/png', buffer: Buffer.from(s.b64, 'base64') });

// ---------- 电脑：注册管理员 ----------
const pc = await device('PC', UA.pc, { width: 1280, height: 820 });
ok(await pc.waitForSelector('#auth.show', { timeout: 4000 }).then(() => true, () => false), '未登录时显示登录页');
await pc.click('#tabReg');
await pc.fill('#aUser', '小明'); await pc.fill('#aPass', 'secret12'); await pc.fill('#aInv', 'WRONG');
await pc.click('#aBtn'); await sleep(300);
ok((await pc.textContent('#aErr')).includes('邀请码不对'), '错误的初始邀请码被拒绝');
await pc.fill('#aInv', 'ADMIN-TEST'); await pc.click('#aBtn');
await pc.waitForSelector('#auth', { state: 'hidden' });
ok(true, '用 SETUP_CODE 注册管理员成功');
await sleep(800);
await pc.screenshot({ path: path.join(out, '0-empty-pc.png') });

// ---------- 一次选 12 张：只取前 10 张；还没配 Key → 排队等待 ----------
OR.delay = 600;
const [chooser] = await Promise.all([pc.waitForEvent('filechooser'), pc.click('#addBtn')]);
await chooser.setFiles(shots.map(fileOf));
await sleep(400);
ok((await pc.textContent('#toast')).includes('一次最多 10 张'), '选了 12 张时提示只取前 10 张：' + await pc.textContent('#toast'));
await waitFor(async () => (await jobs(pc)).length === 10, 10000);
let js = await jobs(pc);
ok(js.length === 10, `队列里有 ${js.length} 张`);
ok(js.filter(j => j.parts === 3).length === 1 && js.filter(j => j.parts === 1).length === 9, '6000 像素高的长截屏切成 3 段、普通截屏 1 段：' + JSON.stringify(js.map(j => j.parts)));
await waitFor(async () => (await jobs(pc)).every(j => j.err), 10000);
js = await jobs(pc);
ok(js.every(j => j.state === 'wait' && /OpenRouter/.test(j.err)), '没配 Key 时截屏留在队列里等待：' + js[0].err);
await pc.evaluate(() => pull()); await sleep(400);
ok(await pc.evaluate(() => !!document.querySelector('#notice .card')), '显示“服务器还不能识别”提醒');
ok(!LOG.includes('PREFLIGHT'), '请求没有触发 CORS 预检（Apps Script 不支持预检）');
await pc.screenshot({ path: path.join(out, '1-queue-pc.png') });

// ---------- 管理员配置 Key ----------
await pc.click('button[aria-label=设置]');
await pc.click('#admToggle'); await sleep(500);
await pc.fill('#cfKey', 'sk-or-test');
await pc.click('text=保存配置'); await sleep(600);
const tr = triggers();
ok(tr.length === 1 && tr[0].h === 'hourlyJob' && tr[0].every === 1, '保存配置后自动创建每小时一次的整理任务：' + JSON.stringify(tr));
ok(GAS.PropertiesService.getScriptProperties().getProperty('OPENROUTER_API_KEY') === 'sk-or-test', 'Key 存进了脚本属性');
const cfgResp = await pc.evaluate(() => api('admin.config', { token: A.token }));
ok(!JSON.stringify(cfgResp).includes('sk-or-test') && cfgResp.keyTail === 'test', '读取配置时不会返回完整 Key');
await pc.click('text=测试 Key'); await sleep(300);
ok((await pc.textContent('#toast')).includes('Key 可用'), '测试 Key：' + await pc.textContent('#toast'));
await pc.screenshot({ path: path.join(out, '2-settings-admin.png') });
await pc.click('#mSet .shead .tbtn');

// ---------- 识别 ----------
await pc.evaluate(() => retryAllJobs());
const t0 = Date.now();
ok(await waitFor(async () => (await jobs(pc)).length === 0, 20000), `10 张全部识别完（${((Date.now() - t0) / 1000).toFixed(1)} 秒，同时识别 3 张）`);
let ns = await notes(pc);
ok(ns.length === 9, `生成 ${ns.length} 条内容（10 张里 1 张没有文字被跳过）`);
ok(OR.ocr.some(o => o.parts === 3), '长截屏 3 段一起发给模型识别');
ok(OR.ocr.every(o => o.model === 'google/gemini-2.5-flash' && o.effort === 'none' && o.imgs.every(i => i.mime === 'image/jpeg')), '识别请求：模型 ' + OR.ocr[0].model + '，关掉思考（effort=' + OR.ocr[0].effort + '），图片压成 JPEG');
ok(OR.ocr.every(o => o.imgs.every(i => i.bytes < 900000)), '每段图片都压缩到 900KB 以下：最大 ' + Math.max(...OR.ocr.flatMap(o => o.imgs.map(i => i.bytes))) + ' 字节');
ok(new Set(ns.map(n => n.source)).size >= 3, '识别出来源：' + [...new Set(ns.map(n => n.source))].join('、'));
ok(ns.every(n => !n.title && !n.drive), '刚提取的内容还没有标题、没上传 Drive');
ok(await idbJobs(pc) === 0, '识别完后本机不再保留任何截屏图片');
ok(files().every(f => f.name === 'notes.json'), '服务器 Drive 里只有 notes.json，没有保存截屏：' + files().map(f => f.name).join(','));
ok(!fs.readFileSync(path.join(root, 'google-drive/Code.gs'), 'utf8').match(/createFile\([^)]*Blob/), 'Code.gs 里没有保存图片的代码');
await sleep(300);
await pc.screenshot({ path: path.join(out, '3-list-pc.png') });

// 打开一条：两栏布局
const first = ns.sort((a, b) => b.t - a.t)[0];
await pc.click(`.nrow[data-id="${first.id}"]`); await sleep(300);
ok(await pc.evaluate(() => getComputedStyle(document.getElementById('notePane')).visibility === 'visible' && !!document.getElementById('nText')), '电脑上左右两栏：右边直接显示内容');
ok((await pc.inputValue('#nText')).includes('今天要记得买牛奶'), '内容页显示提取出的文字');
ok((await pc.getAttribute('#nTitle', 'placeholder')).includes('小时后自动生成'), '标题提示：' + await pc.getAttribute('#nTitle', 'placeholder'));
await pc.screenshot({ path: path.join(out, '4-note-pc.png') });

// 搜索
await pc.fill('#q', '苹果3'); await sleep(200);
ok(await pc.$$eval('.nrow', r => r.length) === 1 && await pc.$$eval('.nrow mark', r => r.length) >= 1, '搜索「苹果3」找到 1 条并高亮');
await pc.fill('#q', ''); await sleep(100);
// 来源筛选
const chips = await pc.$$eval('.chip', c => c.map(x => x.textContent));
ok(chips.length >= 4 && chips[0].startsWith('全部'), '来源筛选：' + chips.join(' | '));
await pc.click('.chip:nth-child(2)'); await sleep(100);
const filtered = await pc.$$eval('.nrow', r => r.length);
ok(filtered > 0 && filtered < 9, `按来源筛选后显示 ${filtered} 条`);
await pc.click('.chip:nth-child(1)');

// ---------- iPhone：同一账号登录，自动同步 ----------
const ph = await device('iPhone', UA.ios, { width: 390, height: 844 }, 'light');
await ph.fill('#aUser', '小明'); await ph.fill('#aPass', 'secret12'); await ph.click('#aBtn');
await ph.waitForSelector('#auth', { state: 'hidden' });
ok(await waitFor(async () => (await notes(ph)).length === 9, 5000), 'iPhone 登录后同步到 9 条内容');
await sleep(300);
await ph.screenshot({ path: path.join(out, '5-list-iphone.png') });
// 打开、编辑文字和标题
const pid = (await notes(ph)).sort((a, b) => b.t - a.t)[1].id;
await ph.click(`.nrow[data-id="${pid}"]`); await sleep(450);
ok(await ph.evaluate(() => document.body.classList.contains('noting')), '手机上点一条：滑入内容页');
await ph.screenshot({ path: path.join(out, '6-note-iphone.png') });
await ph.fill('#nTitle', '买牛奶提醒');
await ph.click('#nText'); await ph.keyboard.press('End'); await ph.keyboard.type('\n手动补充一句');
await sleep(1500);
await ph.click('#nBack'); await sleep(500);
ok(!(await ph.evaluate(() => document.body.classList.contains('noting'))), '点「‹ 灵感」返回列表');
await pc.evaluate(() => pull()); await sleep(500);
let pn = (await notes(pc)).find(n => n.id === pid);
ok(pn.title === '买牛奶提醒' && pn.text.endsWith('手动补充一句'), '在 iPhone 改的标题和文字同步到电脑');

// ---------- iPhone：选择 3 条合并 ----------
await ph.click('#selBtn');
const ids3 = (await notes(ph)).sort((a, b) => a.t - b.t).slice(0, 3).map(n => n.id);
for (const id of ids3) await ph.click(`.nrow[data-id="${id}"]`);
await ph.screenshot({ path: path.join(out, '7-select-iphone.png') });
await ph.click('#tbL button'); await sleep(800);
let mn = (await notes(ph)).find(n => n.id === ids3[0]);
ok((await notes(ph)).length === 7 && mn.count === 3 && mn.text.split('———').length === 3, '3 条合并成 1 条（按时间顺序拼接，记作 3 张截屏）');
ok(await ph.evaluate(() => document.body.classList.contains('noting') && UI.cur), '合并后直接打开合并好的内容');
await ph.screenshot({ path: path.join(out, '8-merged-iphone.png') });
await ph.click('#nBack'); await sleep(400);
await pc.evaluate(() => pull()); await sleep(400);
ok((await notes(pc)).length === 7 && (await notes(pc)).find(n => n.id === ids3[0]).count === 3, '合并结果同步到电脑');

// ---------- 电脑：删除 ----------
const delId = (await notes(pc)).find(n => n.id !== ids3[0] && n.id !== pid).id;
await pc.click('#selBtn'); await pc.click(`.nrow[data-id="${delId}"]`); await pc.click('#tbR button'); await sleep(500);
ok(!(await notes(pc)).some(n => n.id === delId), '电脑上删除 1 条');
await ph.evaluate(() => pull()); await sleep(400);
ok(!(await notes(ph)).some(n => n.id === delId) && (await notes(ph)).length === 6, '删除同步到 iPhone');

// ---------- 24 小时后：起标题 + 上传 Drive ----------
let r = await pc.evaluate(() => api('admin.run', { token: A.token }));
ok(r.result.uploaded === 0 && OR.titles.length === 0, '还不到 24 小时：整理任务什么也不做');
// 模拟时间过去：把所有内容的提取时间往前挪 25 小时
const nameKey = '小明'.toLowerCase();
const folder = GAS.userFolder_('小明');
const nf = folder.getFilesByName('notes.json').next();
const data = JSON.parse(nf.getBlob().getDataAsString());
data.notes.forEach(n => { n.t -= 25 * 3600000; });
nf.setContent(JSON.stringify(data));
const res = GAS.hourlyJob();
ok(res.titled === 5 && res.uploaded === 6, `满 24 小时：AI 起标题 ${res.titled} 条（自己写过标题的不改），上传 Drive ${res.uploaded} 条`);
let fl = files().filter(f => f.name.endsWith('.md') && !f.trashed);
ok(fl.length === 6 && fl.every(f => /灵感云端\/小明\/笔记\/\d{4}-\d{2}$/.test(f.path)), 'Drive 里 灵感云端/小明/笔记/年-月/ 下有 6 个 Markdown：' + fl.map(f => f.name).slice(0, 3).join('，') + '…');
ok(fl.some(f => f.name.includes('买牛奶提醒')) && fl.some(f => /苹果\d+的笔记/.test(f.name)), '文件名用标题（自己写的标题保留，其余是 AI 起的，引号被去掉）');
const mdMerged = fl.find(f => f.text.includes('3 张截屏合并'));
ok(mdMerged && mdMerged.text.startsWith('# ') && mdMerged.text.includes('来源：'), 'Markdown 内容带标题、来源和合并信息');
await pc.evaluate(() => pull()); await sleep(400);
ns = await notes(pc);
ok(ns.every(n => n.title && n.drive && n.drive.fileId), '电脑同步到标题和「已存 Drive」状态');
await sleep(300);
await pc.screenshot({ path: path.join(out, '9-titled-pc.png') });
const res2 = GAS.hourlyJob();
ok(res2.uploaded === 0, '已经整理过的不会重复上传');
ok(OR.titles.length >= 5 && OR.titles.every(t => t.model === 'google/gemini-2.5-flash-lite' && t.effort === 'none'), '起标题：模型 google/gemini-2.5-flash-lite，关掉思考');
// 以前保存过旧默认模型的配置：自动换成新的便宜模型
GAS.setJSON_('config', Object.assign(GAS.cfg_(), { ocrModel: '~google/gemini-flash-latest', titleModel: '~google/gemini-flash-latest' }));
ok(GAS.cfg_().ocrModel === 'google/gemini-2.5-flash' && GAS.cfg_().titleModel === 'google/gemini-2.5-flash-lite', '旧配置里的 ~google/gemini-flash-latest 自动换成新的便宜模型');
// 换成不允许关思考的模型（Gemini 3）：自动退回最少思考，照样能识别
GAS.setJSON_('config', Object.assign(GAS.cfg_(), { ocrModel: 'google/gemini-3.5-flash' }));
const nCalls = OR.calls.length;
const g3 = GAS.ocr_([{ data: Buffer.alloc(5000, 7).toString('base64'), mime: 'image/jpeg' }]);
const tried = OR.calls.slice(nCalls).map(c => c.effort).join('→');
ok(g3.text && tried === 'none→minimal', '模型不允许关思考时自动改用最少思考重试：' + tried);
GAS.setJSON_('config', Object.assign(GAS.cfg_(), { ocrModel: 'google/gemini-2.5-flash' }));

// 已上传的再修改 → 下次整理时更新 Drive 文件（不新建）
const tgt = ns.find(n => n.id === pid);
await pc.click(`.nrow[data-id="${pid}"]`); await sleep(300);
await pc.fill('#nText', '整个改掉的文字');
await pc.fill('#nTitle', '新标题'); await sleep(1500);
await pc.evaluate(() => flushEdit()); await sleep(600);
GAS.hourlyJob();
const f2 = files().find(f => f.id === tgt.drive.fileId);
ok(f2.name.includes('新标题') && f2.text.includes('整个改掉的文字') && files().filter(f => f.name.endsWith('.md') && !f.trashed).length === 6, '已上传的改过后：同一个 Drive 文件被更新并改名');
// 删除已上传的 → Drive 文件进回收站
await pc.evaluate(() => deleteCur()); await sleep(600);
ok(files().find(f => f.id === tgt.drive.fileId).trashed, '删除已上传的内容：Drive 文件移到回收站');

// ---------- 电脑：粘贴、拖拽 ----------
const before = (await notes(pc)).length;
await pc.evaluate(b64 => {
  const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  const dt = new DataTransfer(); dt.items.add(new File([u], 'paste.png', { type: 'image/png' }));
  document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
}, shots[0].b64);
ok(await waitFor(async () => (await notes(pc)).length === before + 1, 8000), 'Ctrl+V 粘贴截屏 → 识别成 1 条');
await pc.evaluate(b64 => {
  const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  const dt = new DataTransfer(); dt.items.add(new File([u], 'drag.png', { type: 'image/png' }));
  window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
  window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
}, shots[1].b64);
ok(await waitFor(async () => (await notes(pc)).length === before + 2, 8000), '拖拽截屏进窗口 → 识别成 1 条');

// ---------- 安卓：从相册分享进来（PWA share_target，模拟 sw.js 存进缓存） ----------
const an = await device('Android', UA.android, { width: 412, height: 900 }, 'dark');
await an.fill('#aUser', '小明'); await an.fill('#aPass', 'secret12'); await an.click('#aBtn');
await an.waitForSelector('#auth', { state: 'hidden' }); await sleep(600);
await an.evaluate(async (arr) => {
  const c = await caches.open('linggan-share');
  for (let i = 0; i < arr.length; i++) { const bin = atob(arr[i]), u = new Uint8Array(bin.length); for (let k = 0; k < bin.length; k++) u[k] = bin.charCodeAt(k); await c.put(new Request('./__share/' + i), new Response(new Blob([u], { type: 'image/png' }))); }
}, [shots[2].b64, shots[4].b64]);
const nBeforeShare = (await notes(an)).length;
await an.goto('http://127.0.0.1:8001/?share=1');
ok(await waitFor(async () => (await notes(an)).length === nBeforeShare + 2, 10000), '安卓相册分享 2 张 → 打开 App 自动识别成 2 条');
ok(await an.evaluate(async () => (await (await caches.open('linggan-share')).keys()).length === 0), '分享进来的图片读取后立刻从缓存删除');
ok(await an.evaluate(() => location.search === ''), '地址栏的 ?share=1 被清掉（刷新不会重复识别）');
await sleep(300);
await an.screenshot({ path: path.join(out, '10-dark-android.png') });

// ---------- 离线排队 ----------
await an.ctx.setOffline(true);
await an.evaluate(() => window.dispatchEvent(new Event('offline')));
const nOff = (await notes(an)).length;
await an.evaluate(b64 => {
  const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  addFiles([new File([u], 'off.png', { type: 'image/png' })]);
}, shots[5].b64);
await sleep(1500);
ok((await jobs(an)).length === 1 && (await notes(an)).length === nOff, '离线时截屏留在队列里');
ok((await an.textContent('#jobs')).includes('离线') || (await an.textContent('#jobs')).includes('等待'), '队列显示离线/等待状态');
await an.ctx.setOffline(false);
await an.evaluate(() => window.dispatchEvent(new Event('online')));
ok(await waitFor(async () => (await notes(an)).length === nOff + 1 && (await jobs(an)).length === 0, 10000), '联网后自动识别');

// 刷新页面后队列不丢（识别失败的情况）
OR.failOcr = true;
await an.evaluate(b64 => {
  const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  addFiles([new File([u], 'fail.png', { type: 'image/png' })]);
}, shots[6].b64);
await waitFor(async () => (await jobs(an)).some(j => j.err), 8000);
ok((await jobs(an))[0].err.includes('识别失败'), '识别失败显示原因：' + (await jobs(an))[0].err);
await an.reload(); await sleep(800);
ok((await jobs(an)).length === 1, '刷新 / 重开 App 后，没识别成功的截屏还在队列里');
OR.failOcr = false;
await an.evaluate(() => retryAllJobs());
ok(await waitFor(async () => (await jobs(an)).length === 0, 8000), '点重试后识别成功，队列清空');

// ---------- iPhone 快捷指令接口：只传 data（没有 id） ----------
const tok = await ph.evaluate(() => A.token);
const sc = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'add', token: tok, data: shots[8].b64, device: 'iPhone 快捷指令' }) }).then(r => r.json());
ok(sc.ok && sc.note && sc.note.device === 'iPhone 快捷指令', '快捷指令直接 POST 一张截屏也能识别保存');
await ph.evaluate(() => pull()); await sleep(400);
ok((await notes(ph)).some(n => n.id === sc.note.id), '快捷指令存的内容同步到 App');

// ---------- 设置页 / 邀请码 ----------
await ph.click('button[aria-label=设置]'); await sleep(300);
await ph.screenshot({ path: path.join(out, '11-settings-iphone.png'), fullPage: true });
await ph.click('text=看步骤'); await sleep(200);
ok((await ph.textContent('#infoBody')).includes('Base64'), 'iPhone 快捷指令设置步骤');
await ph.screenshot({ path: path.join(out, '12-shortcut-iphone.png') });
const inv = await pc.evaluate(async () => (await api('invite.create', { token: A.token, note: '朋友' })).invite.code);
const fr = await device('Friend', UA.ios, { width: 390, height: 844 });
await fr.click('#tabReg'); await fr.fill('#aUser', '小红'); await fr.fill('#aPass', 'abcdef'); await fr.fill('#aInv', inv); await fr.click('#aBtn');
await fr.waitForSelector('#auth', { state: 'hidden' }); await sleep(600);
ok((await notes(fr)).length === 0, '朋友用邀请码注册，看不到别人的内容');
await fr.screenshot({ path: path.join(out, '13-empty-iphone.png') });
const again = await fetch(API, { method: 'POST', body: JSON.stringify({ action: 'register', username: '小黑', password: 'abcdef', invite: inv }) }).then(r => r.json());
ok(!again.ok && again.error.includes('用过'), '邀请码只能用一次');
const steal = await fetch(API, { method: 'POST', body: JSON.stringify({ action: 'note.delete', token: await fr.evaluate(() => A.token), ids: [pid.replace(/./, 'z')] }) }).then(r => r.json());
ok(steal.ok && (await notes(pc)).length > 0, '别人的账号删不到我的内容（各自独立存储）');

console.log(fails ? `\n${fails} 项失败` : '\n全部通过');
await browser.close();
process.exit(fails ? 1 : 0);
