// CE Study AI - Service Worker（アプリ本体のオフラインキャッシュ）
// 注意：Gemini APIへの問題生成リクエストはオフラインでは動作しません。
// キャッシュ対象はアプリの見た目・動作に必要な静的ファイルのみです。
//
// 戦略：network-first（まずネットから最新版を取りに行き、
// 取得できた場合はキャッシュを更新する。オフライン時のみキャッシュを使う）
// これにより、アプリを更新したときに反映されやすくなる。

const CACHE_NAME = "cestudy-cache-v2";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Gemini APIへのリクエストなど、他ドメインへの通信はキャッシュしない
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
