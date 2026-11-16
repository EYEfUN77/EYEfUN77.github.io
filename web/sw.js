/* 바탕화면 달력 휴대폰 앱: 껍데기 파일을 저장해 인터넷 없이도 열리게 함(달력 화면·일정은 앱이 따로 저장) */
const C = 'dcal-web-24';
const FILES = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-180.png', './icon-maskable-192.png', './icon-maskable-512.png', './splash.png', './gweb.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(C).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || e.request.method !== 'GET') return;
  if (u.searchParams.has('t')) return;   /* ?t=… 는 '항상 새로 받기' 요청 → 그대로 인터넷 */
  /* 저장된 파일로 바로 열고(시작이 빨라짐), 새 파일은 뒤에서 받아 두었다가 다음에 열 때 사용.
     처음이라 저장본이 없으면 인터넷에서 받음 */
  const net = fetch(e.request, { cache: 'no-cache' }).then(r => {
    if (r && r.ok) { const cp = r.clone(); caches.open(C).then(c => c.put(e.request, cp)); }
    return r;
  });
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => {
    if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
    return net.catch(() => caches.match('./').then(r => r || Response.error()));
  }));
});
