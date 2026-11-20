// 离线缓存 + 接收安卓「分享」进来的截屏。修改文件后请递增版本号
const CACHE = 'linggan-v1';
const SHARE = 'linggan-share';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== SHARE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // 安卓相册 → 分享 → 灵感：先把图片放进缓存，再打开 App（App 读取后立刻删除）
  if (e.request.method === 'POST' && url.origin === location.origin && url.pathname.endsWith('/share')) {
    e.respondWith((async () => {
      try {
        const form = await e.request.formData();
        const files = form.getAll('images').filter(f => f && typeof f !== 'string');
        const c = await caches.open(SHARE);
        let i = 0;
        for (const f of files.slice(0, 10)) {
          await c.put(new Request('./__share/' + Date.now() + '-' + (i++)), new Response(f, { headers: { 'Content-Type': f.type || 'image/png' } }));
        }
      } catch (err) {}
      return Response.redirect('./?share=1', 303);
    })());
    return;
  }
  if (e.request.method !== 'GET') return;
  // 网络优先，失败时使用缓存（保证更新及时，同时支持离线）
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok && url.origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./index.html')))
  );
});
