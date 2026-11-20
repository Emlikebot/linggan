/**
 * 灵感 · 服务器（Google Apps Script）
 * 负责：账号与邀请码、收到截屏 → 调 OpenRouter 只提取文字（截屏本身不保存）、三端同步、
 *       每份内容提取 24 小时后自动起标题并上传到 Google Drive。
 *
 * 只需管理员部署一次：
 * 1. 打开 https://script.google.com → 新建项目 → 把这整段代码粘贴进去（替换原内容）
 * 2. 把下面 SETUP_CODE 改成你自己的一串“管理员初始邀请码”，Ctrl+S 保存
 * 3. 右上角「部署」→「新建部署」→ 齿轮选「网页应用」
 *    执行身份：我　｜　谁可以访问：任何人　→ 部署 → 按提示授权
 *    （出现“Google 尚未验证此应用”时点「高级」→「转至…（不安全）」，这是你自己的脚本）
 * 4. 复制「网页应用」网址（…/exec 结尾），在 App 登录页「服务器设置」里填入
 * 5. 在 App 里用 SETUP_CODE 注册第一个账号，它就是管理员
 * 6. 管理员在 App「设置 → 管理员 → 服务器配置」里填 OpenRouter API Key（只存在本脚本的脚本属性里），
 *    保存时会自动创建「每小时整理一次」的定时任务（给满 24 小时的内容起标题、上传到 Drive）
 *
 * 以后改了代码：「部署」→「管理部署」→ 铅笔 → 版本选「新版本」→ 部署（网址不变）
 *
 * 数据位置：你 Google Drive 的「灵感云端」文件夹，每个账号一个子文件夹：
 *   notes.json            全部内容（App 同步用）
 *   笔记/YYYY-MM/*.md     满 24 小时的内容，每份一个 Markdown 文件（标题做文件名）
 * 截屏图片只在识别时经过服务器内存，识别完就丢掉，任何地方都不保存。
 * 账号、密码（加盐哈希）、邀请码、OpenRouter Key 存在本脚本的「脚本属性」里。
 */
const SETUP_CODE = '改成你的管理员初始邀请码';
const APP_ID = 'linggan';
const ROOT_FOLDER = '灵感云端';
const TOKEN_DAYS = 365;
const HASH_ROUNDS = 400;
const OR_BASE = 'https://openrouter.ai/api/v1';
const MAX_PARTS = 12;                 // 一张长截屏最多切成几段
const DEFAULT_CFG = {
  ocrModel: '~google/gemini-flash-latest',     // 识别文字用的模型（要能看图）
  titleModel: '~google/gemini-flash-latest',   // 起标题用的模型
  tz: 'Asia/Shanghai',                         // 文件名里的日期用这个时区（保存配置时自动用手机的时区）
  archiveHours: 24                             // 提取后多少小时起标题、上传 Drive
};
const SOURCES = ['X', '小红书', '微信', 'Telegram', '微博', '抖音', '知乎', '其他'];

/* ---------------- 入口 ---------------- */
function doGet() {
  return json_({ ok: true, app: APP_ID, msg: '灵感服务器运行中' });
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: '请求格式不对' }); }
  try {
    const fn = API[body.action];
    if (!fn) return json_({ ok: false, error: '未知操作' });
    return json_(Object.assign({ ok: true }, fn(body)));
  } catch (err) {
    if (err && err.userError) return json_({ ok: false, error: err.message, code: err.code || '' });
    return json_({ ok: false, error: '服务器出错：' + String(err && err.message || err) });
  }
}

const API = {
  ping: function () { return { app: APP_ID, setup: !anyAdmin_() }; },

  register: function (b) {
    const name = cleanName_(b.username), pw = String(b.password || ''), code = String(b.invite || '').trim();
    if (pw.length < 6) fail_('密码至少 6 位');
    return withLock_(function () {
      if (getUser_(name)) fail_('这个用户名已经被注册了');
      let admin = false, inv = null;
      if (!anyAdmin_()) {
        if (SETUP_CODE === '改成你的管理员初始邀请码') fail_('管理员还没在脚本里设置 SETUP_CODE');
        if (code !== SETUP_CODE) fail_('邀请码不对（第一个账号请使用脚本里的 SETUP_CODE）');
        admin = true;
      } else {
        inv = getInvite_(code.toUpperCase());
        if (!inv) fail_('邀请码不存在');
        if (inv.usedBy) fail_('这个邀请码已经被用过了');
      }
      const salt = rand_(16);
      const u = { name: name, salt: salt, hash: hash_(pw, salt), admin: admin, created: Date.now(), pv: 1, invite: admin ? 'SETUP' : code.toUpperCase(), fails: 0, lockUntil: 0 };
      putUser_(u);
      if (inv) { inv.usedBy = name; inv.usedAt = Date.now(); putInvite_(inv); }
      return { token: token_(u), user: pub_(u) };
    });
  },

  login: function (b) {
    const name = String(b.username || '').trim(), pw = String(b.password || '');
    const u = getUser_(name);
    if (!u) fail_('用户名或密码不对');
    if (u.lockUntil > Date.now()) fail_('密码错误次数太多，请 ' + Math.ceil((u.lockUntil - Date.now()) / 60000) + ' 分钟后再试');
    if (hash_(pw, u.salt) !== u.hash) {
      withLock_(function () {
        const x = getUser_(name); x.fails = (x.fails || 0) + 1;
        if (x.fails >= 5) { x.lockUntil = Date.now() + 10 * 60000; x.fails = 0; }
        putUser_(x);
      });
      fail_('用户名或密码不对');
    }
    if (u.fails) withLock_(function () { const x = getUser_(name); x.fails = 0; putUser_(x); });
    return { token: token_(u), user: pub_(u) };
  },

  me: function (b) { return { user: pub_(auth_(b.token)), ready: !!orKey_() }; },

  password: function (b) {
    const u = auth_(b.token);
    if (hash_(String(b.old || ''), u.salt) !== u.hash) fail_('原密码不对');
    if (String(b.password || '').length < 6) fail_('新密码至少 6 位');
    return withLock_(function () {
      const x = getUser_(u.name);
      x.salt = rand_(16); x.hash = hash_(String(b.password), x.salt); x.pv = (x.pv || 1) + 1;
      putUser_(x);
      return { token: token_(x) };
    });
  },

  /* 识别一张截屏：images 是同一张截屏切成的几段（长截屏）或者就一段。
     只把文字存下来，图片识别完就丢掉。同一个 id 重复提交不会重复保存。
     也可以只传 data + mime（给 iPhone 快捷指令用）。 */
  add: function (b) {
    const u = auth_(b.token);
    const id = b.id ? cleanId_(b.id) : 'sc' + Date.now().toString(36) + rand_(8);
    const t = Number(b.t) || Date.now();
    let imgs = Array.isArray(b.images) ? b.images : (b.data ? [{ data: b.data, mime: b.mime }] : []);
    imgs = imgs.filter(function (x) { return x && x.data; }).slice(0, MAX_PARTS);
    if (!imgs.length) fail_('没有收到截屏');
    const N = readNotes_(u.name);
    if (N.deleted[id]) return { note: null, deleted: true };
    const ex = N.notes.filter(function (x) { return x.id === id; })[0];
    if (ex) return { note: ex };
    if (!orKey_()) fail_('管理员还没在「服务器配置」里填 OpenRouter API Key', 'nokey');
    const r = ocr_(imgs);                          // 图片只在这里用一次
    imgs = null; b.images = null; b.data = null;
    if (!r.text) return { note: null, empty: true };
    const note = { id: id, t: t, text: r.text, source: r.source, count: 1, title: '', titleBy: '', device: String(b.device || '').slice(0, 30),
      drive: null, archivedAt: 0, dirty: false };
    return withLock_(function () {
      const M = readNotes_(u.name);
      if (M.deleted[id]) return { note: null, deleted: true };
      const again = M.notes.filter(function (x) { return x.id === id; })[0];
      if (again) return { note: again };
      note.u = Date.now();
      M.notes.push(note);
      writeNotes_(u.name, M);
      return { note: note };
    });
  },

  /* 增量拉取：since 之后有变化的内容和删除记录 */
  pull: function (b) {
    const u = auth_(b.token), since = Number(b.since) || 0, now = Date.now();
    const N = readNotes_(u.name);
    props_().setProperty('sync:' + u.name.toLowerCase(), String(now));
    return {
      now: now,
      full: !since,
      notes: N.notes.filter(function (x) { return (x.u || 0) > since; }),
      deleted: Object.keys(N.deleted).filter(function (k) { return N.deleted[k] > since; }),
      ready: !!orKey_(),
      archiveHours: cfg_().archiveHours
    };
  },

  /* 修改文字或标题。标题改成空 = 交给 AI 重新起 */
  'note.update': function (b) {
    const u = auth_(b.token), id = cleanId_(b.id);
    return withLock_(function () {
      const N = readNotes_(u.name);
      const n = N.notes.filter(function (x) { return x.id === id; })[0];
      if (!n) { if (N.deleted[id]) return { note: null }; fail_('找不到这条内容'); }
      if (b.text != null) { n.text = String(b.text).slice(0, 200000); n.edited = true; }
      if (b.title != null) { n.title = cleanTitle_(b.title); n.titleBy = n.title ? 'user' : ''; }
      n.dirty = true;                                   // 已经上传过的，下次整理时更新 Drive 里的文件
      n.u = Date.now();
      writeNotes_(u.name, N);
      return { note: n };
    });
  },

  'note.delete': function (b) {
    const u = auth_(b.token);
    const ids = (Array.isArray(b.ids) ? b.ids : [b.id]).map(cleanId_);
    return withLock_(function () {
      const N = readNotes_(u.name), now = Date.now();
      N.notes.filter(function (x) { return ids.indexOf(x.id) >= 0; }).forEach(function (x) { trashFile_(x.drive); });
      N.notes = N.notes.filter(function (x) { return ids.indexOf(x.id) < 0; });
      ids.forEach(function (id) { N.deleted[id] = now; });   // 还在识别中的，识别完也会被丢掉
      writeNotes_(u.name, N);
      return {};
    });
  },

  /* 合并：按时间从早到晚拼在一起，保留最早那条（提取时间也按最早的算），其余删除 */
  'note.merge': function (b) {
    const u = auth_(b.token);
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(cleanId_);
    if (ids.length < 2) fail_('至少选两条才能合并');
    return withLock_(function () {
      const N = readNotes_(u.name);
      const list = N.notes.filter(function (x) { return ids.indexOf(x.id) >= 0; });
      if (list.length < 2) fail_('要合并的内容有的已经被删除了，请刷新后再试');
      const m = mergeNotes_(list);
      const keep = m.note, gone = m.gone, now = Date.now();
      gone.forEach(function (x) { trashFile_(x.drive); N.deleted[x.id] = now; });
      const goneIds = gone.map(function (x) { return x.id; });
      N.notes = N.notes.filter(function (x) { return goneIds.indexOf(x.id) < 0; });
      keep.u = now;
      writeNotes_(u.name, N);
      return { note: keep, deleted: goneIds };
    });
  },

  /* ---- 管理员 ---- */
  'invite.create': function (b) {
    adminOnly_(b.token);
    return withLock_(function () {
      let code;
      do { code = randCode_(8); } while (getInvite_(code));
      const inv = { code: code, created: Date.now(), by: auth_(b.token).name, note: String(b.note || '').slice(0, 30), usedBy: '', usedAt: 0 };
      putInvite_(inv);
      return { invite: inv };
    });
  },
  'invite.list': function (b) {
    adminOnly_(b.token);
    return { invites: listByPrefix_('inv:').sort(function (a, c) { return c.created - a.created; }) };
  },
  'invite.delete': function (b) {
    adminOnly_(b.token);
    const inv = getInvite_(String(b.code || ''));
    if (!inv) fail_('邀请码不存在');
    if (inv.usedBy) fail_('已使用的邀请码不能删除');
    props_().deleteProperty('inv:' + inv.code);
    return {};
  },
  'admin.users': function (b) {
    adminOnly_(b.token);
    const users = listByPrefix_('user:').map(function (u) {
      return { name: u.name, admin: !!u.admin, created: u.created, invite: u.invite, lastSync: Number(props_().getProperty('sync:' + u.name.toLowerCase()) || 0) };
    }).sort(function (a, c) { return a.created - c.created; });
    return { users: users };
  },
  'admin.reset': function (b) {
    const me = adminOnly_(b.token);
    const name = String(b.target || '');
    if (name.toLowerCase() === me.name.toLowerCase()) fail_('不能重置自己的密码，请用「修改密码」');
    return withLock_(function () {
      const x = getUser_(name); if (!x) fail_('用户不存在');
      const tmp = randCode_(8).toLowerCase();
      x.salt = rand_(16); x.hash = hash_(tmp, x.salt); x.pv = (x.pv || 1) + 1; x.fails = 0; x.lockUntil = 0;
      putUser_(x);
      return { password: tmp };
    });
  },
  /* 读取 / 保存服务器配置。Key 只写不读，返回时只给末 4 位 */
  'admin.config': function (b) {
    adminOnly_(b.token);
    if (b.set) {
      const c = cfg_(), s = b.set;
      if (s.ocrModel != null) c.ocrModel = String(s.ocrModel).trim() || DEFAULT_CFG.ocrModel;
      if (s.titleModel != null) c.titleModel = String(s.titleModel).trim() || DEFAULT_CFG.titleModel;
      if (s.archiveHours != null && isFinite(Number(s.archiveHours))) c.archiveHours = Math.min(24 * 30, Math.max(0, Number(s.archiveHours)));
      if (s.tz) { try { Utilities.formatDate(new Date(), String(s.tz), 'Z'); c.tz = String(s.tz); } catch (e) { fail_('时区不对：' + s.tz); } }
      setJSON_('config', c);
      if (s.key) props_().setProperty('OPENROUTER_API_KEY', String(s.key).trim());
      ensureTrigger_(true);
    }
    const k = orKey_();
    return { config: cfg_(), keySet: !!k, keyTail: k ? k.slice(-4) : '', trigger: triggerInfo_(), lastJob: getJSON_('lastJob') };
  },
  /* 测试 OpenRouter Key 是否可用 */
  'admin.test': function (b) {
    adminOnly_(b.token);
    const k = orKey_(); if (!k) fail_('还没填 OpenRouter API Key');
    const r = UrlFetchApp.fetch(OR_BASE + '/key', { headers: { Authorization: 'Bearer ' + k }, muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) fail_('Key 不可用（' + r.getResponseCode() + '）：' + r.getContentText().slice(0, 200));
    const d = (JSON.parse(r.getContentText()) || {}).data || {};
    return { label: d.label || '', usage: d.usage, limit: d.limit, limitRemaining: d.limit_remaining };
  },
  /* 立刻整理一次（不用等整点） */
  'admin.run': function (b) {
    adminOnly_(b.token);
    return { result: hourlyJob() };
  }
};

/* ---------------- 识别文字 ---------------- */
function ocr_(imgs) {
  const c = cfg_(), k = orKey_();
  const multi = imgs.length > 1;
  const prompt =
    '下面是一张手机截屏' + (multi ? '（因为太长，按从上到下的顺序切成了 ' + imgs.length + ' 段，相邻两段之间有一小段重叠，重叠的内容只保留一次）' : '') +
    '，来自 X（推特）、小红书、微信、Telegram 等 App。\n' +
    '请把截屏里的正文文字原样提取出来：\n' +
    '1. 只要文字，不要描述图片；配图上本身印着的文字（海报、图片里的标题等）也要提取\n' +
    '2. 原文照抄：不翻译、不总结、不改写、不纠错，保留原来的分段和换行\n' +
    '3. 保留有意义的信息：作者昵称、发布时间；聊天记录写成「昵称：内容」；评论区的评论也要\n' +
    '4. 忽略界面元素：手机状态栏（时间、电量、信号）、导航栏、标签栏、按钮文字、输入框、键盘、点赞/转发/收藏的数字、广告\n' +
    '输出格式（严格遵守，不要加任何说明，不要用代码块）：\n' +
    '第一行：「来源：」加上判断出的 App，只能是 ' + SOURCES.join('、') + ' 之一\n' +
    '第二行：空行\n' +
    '第三行开始：提取出的文字。如果截屏里没有任何正文文字，第三行只写「（无文字）」';
  const content = [{ type: 'text', text: prompt }].concat(imgs.map(function (im) {
    const mime = /^image\/(png|jpeg|jpg|webp|gif)$/i.test(String(im.mime || '')) ? String(im.mime).toLowerCase().replace('jpg', 'jpeg') : 'image/jpeg';
    return { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + String(im.data).replace(/^data:[^,]*,/, '') } };
  }));
  const j = chat_(c.ocrModel, content, 'low', 0);
  if (j.err) fail_('识别失败：' + j.err, 'ocr');
  return parseOcr_(j.text);
}
function parseOcr_(out) {
  let s = String(out || '').replace(/\r/g, '').trim();
  s = s.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim();
  let source = '其他', text = s;
  const m = s.match(/^来源\s*[:：]\s*([^\n]*)\n?([\s\S]*)$/);
  if (m) { source = normSource_(m[1]); text = m[2]; }
  text = text.replace(/^\n+/, '').replace(/\s+$/, '');
  if (/^[（(]?\s*无文字\s*[）)]?$/.test(text.trim())) text = '';
  return { source: source, text: text };
}
function normSource_(s) {
  s = String(s || '').trim().replace(/[「」"'“”。.\s]/g, '');
  const l = s.toLowerCase();
  if (/^(x|twitter|推特|x（推特）|x\(推特\))$/.test(l)) return 'X';
  if (/telegram|电报|tg/.test(l)) return 'Telegram';
  if (/小红书|rednote|xiaohongshu/.test(l)) return '小红书';
  if (/微信|wechat|公众号/.test(l)) return '微信';
  if (/微博|weibo/.test(l)) return '微博';
  if (/抖音|douyin|tiktok/.test(l)) return '抖音';
  if (/知乎|zhihu/.test(l)) return '知乎';
  return SOURCES.indexOf(s) >= 0 ? s : '其他';
}

/* 调 OpenRouter 聊天接口，返回 {text} 或 {err} */
function chat_(model, content, effort, temperature) {
  const k = orKey_();
  if (!k) return { err: '还没配置 OpenRouter API Key' };
  const payload = { model: model, messages: [{ role: 'user', content: content }] };
  if (effort) payload.reasoning = { effort: effort };
  if (temperature != null) payload.temperature = temperature;
  try {
    const r = UrlFetchApp.fetch(OR_BASE + '/chat/completions', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true, payload: JSON.stringify(payload),
      headers: { Authorization: 'Bearer ' + k, 'HTTP-Referer': 'https://github.com/Emlikebot/linggan', 'X-Title': 'LingGan' }
    });
    const code = r.getResponseCode(), txt = r.getContentText();
    let j = null; try { j = JSON.parse(txt); } catch (e) {}
    const msg = j && j.choices && j.choices[0] && j.choices[0].message;
    let out = msg && msg.content;
    if (Array.isArray(out)) out = out.map(function (p) { return p && p.text || ''; }).join('');
    if (code !== 200 || typeof out !== 'string') return { err: '（' + code + '）' + String((j && j.error && (j.error.message || j.error)) || txt).slice(0, 300) };
    return { text: out };
  } catch (e) {
    return { err: String(e && e.message || e).slice(0, 300) };
  }
}

/* ---------------- 合并 ---------------- */
function mergeNotes_(list) {
  list = list.slice().sort(function (a, c) { return a.t - c.t || (a.id < c.id ? -1 : 1); });
  const keep = list[0], gone = list.slice(1);
  keep.text = list.map(function (x) { return String(x.text || '').trim(); }).filter(String).join('\n\n———\n\n');
  keep.count = list.reduce(function (a, x) { return a + (x.count || 1); }, 0);
  const srcs = list.map(function (x) { return x.source || '其他'; }).filter(function (s, i, arr) { return arr.indexOf(s) === i; });
  keep.source = srcs.length === 1 ? srcs[0] : srcs.join(' + ');
  if (keep.titleBy !== 'user') { keep.title = ''; keep.titleBy = ''; }   // 内容变了，到时间重新起标题
  keep.dirty = true;
  return { note: keep, gone: gone };
}

/* ---------------- 每小时整理：起标题 + 上传 Drive ---------------- */
/* 定时任务入口（每小时一次）。满 archiveHours 小时的内容：没有标题就让 AI 起一个；然后存进 Drive「笔记」文件夹。
   之后再改过或合并过的，会更新 Drive 里的文件。 */
function hourlyJob() {
  const started = Date.now(), c = cfg_(), dueBefore = Date.now() - c.archiveHours * 3600000;
  const res = { titled: 0, uploaded: 0, failed: 0, users: 0 };
  listByPrefix_('user:').forEach(function (u) {
    if (Date.now() - started > 4.5 * 60000) return;     // Apps Script 单次最多 6 分钟，剩下的下个小时继续
    try {
      const N = readNotes_(u.name);
      const due = N.notes.filter(function (x) { return x.t <= dueBefore && (!x.title || !x.drive || x.dirty); })
        .sort(function (a, b) { return a.t - b.t; }).slice(0, 60);
      if (!due.length) return;
      res.users++;
      // 1) 起标题（慢，不占锁）
      const titles = {};
      due.forEach(function (x) {
        if (x.title || !orKey_() || Date.now() - started > 4 * 60000) return;
        const t = makeTitle_(x);
        if (t) titles[x.id] = { title: t, text: x.text }; else res.failed++;
      });
      // 2) 写回 + 上传 Drive（重新读一遍，防止这期间用户改过）
      withLock_(function () {
        const M = readNotes_(u.name), now = Date.now();
        due.forEach(function (d) {
          const n = M.notes.filter(function (x) { return x.id === d.id; })[0];
          if (!n) return;                                         // 这期间被删除或合并掉了
          const tt = titles[n.id];
          if (!n.title && tt && tt.text === n.text) { n.title = tt.title; n.titleBy = 'ai'; res.titled++; }
          if (!n.title && orKey_()) return;                      // 标题还没起好，下次再上传
          try {
            n.drive = saveToDrive_(u.name, n);
            if (!n.archivedAt) n.archivedAt = now;
            n.dirty = false; n.u = now; res.uploaded++;
          } catch (e) { res.failed++; console.error(u.name + ' 上传失败：' + e); }
        });
        writeNotes_(u.name, M);
      });
    } catch (e) { res.failed++; console.error(u.name + ': ' + e); }
  });
  res.at = Date.now();
  setJSON_('lastJob', res);
  return res;
}

function makeTitle_(n) {
  const prompt = '给下面这段从手机截屏里提取的文字起一个简短的中文标题：6–18 个字，概括核心内容，方便以后搜索。\n' +
    '只输出标题本身，不加引号、书名号、句号，不要任何解释。\n\n来源：' + (n.source || '其他') + '\n\n' + String(n.text || '').slice(0, 8000);
  const j = chat_(cfg_().titleModel, prompt, 'low', 0.3);
  if (j.err) { console.error('起标题失败：' + j.err); return ''; }
  return cleanTitle_(String(j.text || '').trim().split('\n')[0]);
}
function cleanTitle_(s) {
  return String(s || '').replace(/^\s*(标题|title)\s*[:：]\s*/i, '').replace(/^[#\s"'“”‘’《「『【]+|["'“”‘’》」』】。.!！?？,，\s]+$/g, '').trim().slice(0, 60);
}

/* 存成 Markdown：灵感云端/用户名/笔记/YYYY-MM/MM-dd HH.mm 标题.md；已经存过的就更新原文件 */
function saveToDrive_(name, n) {
  const tz = cfg_().tz, d = new Date(n.t);
  const title = n.title || firstLine_(n.text);
  const fname = Utilities.formatDate(d, tz, 'MM-dd HH.mm') + ' ' + title.replace(/[\\\/:*?"<>|\r\n\t]+/g, ' ').slice(0, 60).trim() + '.md';
  const meta = '来源：' + (n.source || '其他') + ' · 提取于 ' + Utilities.formatDate(d, tz, 'yyyy-MM-dd HH:mm') + ((n.count || 1) > 1 ? ' · ' + n.count + ' 张截屏合并' : '');
  const md = '# ' + title + '\n\n> ' + meta + '\n\n' + String(n.text || '');
  if (n.drive && n.drive.fileId) {
    try {
      const f = DriveApp.getFileById(n.drive.fileId);
      if (!f.isTrashed || !f.isTrashed()) {
        f.setContent(md);
        if (f.getName() !== fname) f.setName(fname);
        return { fileId: f.getId(), name: fname };
      }
    } catch (e) {}                                           // 文件被手动删了：重新建一个
  }
  const folder = sub_(sub_(userFolder_(name), '笔记'), Utilities.formatDate(d, tz, 'yyyy-MM'));
  const f = folder.createFile(fname, md, 'text/markdown');
  return { fileId: f.getId(), name: fname };
}
function firstLine_(t) { return String(t || '').split('\n').map(function (l) { return l.trim(); }).filter(String)[0] || '无标题'; }
function trashFile_(drive) {
  if (!drive || !drive.fileId) return;
  try { DriveApp.getFileById(drive.fileId).setTrashed(true); } catch (e) {}
}

/* 手动运行一次：在编辑器里选 setup → 运行（首次会要求授权），也可以只在 App 里保存配置 */
function setup() { ensureTrigger_(true); console.log(JSON.stringify(triggerInfo_())); }
function ensureTrigger_(force) {
  const mine = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'hourlyJob'; });
  if (!force && mine.length) return;
  mine.forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('hourlyJob').timeBased().everyHours(1).create();
}
function triggerInfo_() {
  const n = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'hourlyJob'; }).length;
  return { active: n > 0, text: n > 0 ? '每小时整理一次' : '未创建' };
}

/* ---------------- 内容存储 ---------------- */
function readNotes_(name) {
  const def = { notes: [], deleted: {} };
  const it = userFolder_(name).getFilesByName('notes.json');
  if (!it.hasNext()) return def;
  try { const o = JSON.parse(it.next().getBlob().getDataAsString('UTF-8')); return { notes: o.notes || [], deleted: o.deleted || {} }; } catch (e) { return def; }
}
function writeNotes_(name, N) {
  // 删除记录只留 90 天，够各设备同步
  const cut = Date.now() - 90 * 86400000;
  Object.keys(N.deleted).forEach(function (k) { if (N.deleted[k] < cut) delete N.deleted[k]; });
  upsert_(userFolder_(name), 'notes.json', JSON.stringify(N), 'application/json');
}

/* ---------------- 通用存储 ---------------- */
function props_() { return PropertiesService.getScriptProperties(); }
function getJSON_(k) { const v = props_().getProperty(k); return v ? JSON.parse(v) : null; }
function setJSON_(k, o) { props_().setProperty(k, JSON.stringify(o)); }
function cfg_() { return Object.assign({}, DEFAULT_CFG, getJSON_('config') || {}); }
function orKey_() { return props_().getProperty('OPENROUTER_API_KEY') || ''; }
function getUser_(name) { return getJSON_('user:' + String(name).toLowerCase()); }
function putUser_(u) { setJSON_('user:' + u.name.toLowerCase(), u); }
function getInvite_(code) { return code ? getJSON_('inv:' + code) : null; }
function putInvite_(inv) { setJSON_('inv:' + inv.code, inv); }
function anyAdmin_() { return listByPrefix_('user:').some(function (u) { return u.admin; }); }
function listByPrefix_(p) {
  const all = props_().getProperties();
  return Object.keys(all).filter(function (k) { return k.indexOf(p) === 0; }).map(function (k) { return JSON.parse(all[k]); });
}
function sub_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}
function userFolder_(name) {
  const rootIt = DriveApp.getFoldersByName(ROOT_FOLDER);
  const root = rootIt.hasNext() ? rootIt.next() : DriveApp.createFolder(ROOT_FOLDER);
  return sub_(root, name.toLowerCase());
}
function upsert_(folder, fname, content, mime) {
  const it = folder.getFilesByName(fname);
  if (it.hasNext()) it.next().setContent(content);
  else folder.createFile(fname, content, mime || 'application/json');
}

/* ---------------- 安全 ---------------- */
function secret_() {
  let s = props_().getProperty('TOKEN_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); props_().setProperty('TOKEN_SECRET', s); }
  return s;
}
function b64_(bytes) { return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, ''); }
function hash_(pw, salt) {
  const key = Utilities.newBlob(salt).getBytes();
  let h = Utilities.computeHmacSha256Signature(Utilities.newBlob(salt + ':' + pw).getBytes(), key);
  for (let i = 0; i < HASH_ROUNDS; i++) h = Utilities.computeHmacSha256Signature(h, key);
  return b64_(h);
}
function sign_(s) { return b64_(Utilities.computeHmacSha256Signature(Utilities.newBlob(s).getBytes(), Utilities.newBlob(secret_()).getBytes())); }
function token_(u) {
  const payload = b64_(Utilities.newBlob(JSON.stringify({ u: u.name.toLowerCase(), pv: u.pv, i: Date.now() })).getBytes());
  return payload + '.' + sign_(payload);
}
function auth_(tok) {
  const parts = String(tok || '').split('.');
  if (parts.length !== 2 || sign_(parts[0]) !== parts[1]) fail_('登录已失效，请重新登录', 'auth');
  let p;
  try {
    let s = parts[0]; while (s.length % 4) s += '=';
    p = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(s)).getDataAsString());
  } catch (e) { fail_('登录已失效，请重新登录', 'auth'); }
  const u = getUser_(p.u);
  if (!u || u.pv !== p.pv || Date.now() - p.i > TOKEN_DAYS * 86400000) fail_('登录已失效，请重新登录', 'auth');
  return u;
}
function adminOnly_(tok) { const u = auth_(tok); if (!u.admin) fail_('只有管理员可以这样做'); return u; }
function pub_(u) { return { username: u.name, admin: !!u.admin, created: u.created }; }
function cleanName_(n) {
  n = String(n || '').trim();
  if (!/^[A-Za-z0-9_一-龥]{2,20}$/.test(n)) fail_('用户名只能用 2–20 位中文、字母、数字或下划线');
  return n;
}
function cleanId_(id) {
  id = String(id || '');
  if (!/^[A-Za-z0-9_-]{6,40}$/.test(id)) fail_('内容编号不对');
  return id;
}
function rand_(n) { return Utilities.getUuid().replace(/-/g, '').slice(0, n); }
function randCode_(n) {
  const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = ''; const src = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  for (let i = 0; i < n; i++) s += cs[parseInt(src.substr(i * 2, 2), 16) % cs.length];
  return s;
}
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try { return fn(); } finally { lock.releaseLock(); }
}
function fail_(msg, code) { const e = new Error(msg); e.userError = true; e.code = code; throw e; }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
