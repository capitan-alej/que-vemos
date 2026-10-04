// Service worker de "¿Qué vemos?" (scope /que-vemos/).
// Hace dos cosas:
//  1. Caché mínima para que abra rápido y ande offline mostrando lo último.
//     - página: red primero (con tope de espera), si no hay red, la copia guardada;
//     - data/*.json: stale-while-revalidate (muestra lo guardado y lo refresca en el
//       momento; si cambió, avisa a la página para que se redibuje → nunca queda viejo);
//     - SDK de Firebase y fuentes (URLs versionadas): caché primero.
//  2. Es también el SW de Firebase Cloud Messaging (avisos de los jueves). Como el
//     sitio no está en la raíz del dominio, la página lo registra y se lo pasa a getToken.
//     Con la app cerrada o en segundo plano, el SDK muestra la notificación y maneja el clic
//     (abre/enfoca webpush.fcm_options.link). Con la app a la vista, se la pasa a la página.

importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyAthOnaXKZCPfSUxkrqrfnhegkFKh09rQs",
  authDomain: "que-vemos-74ff3.firebaseapp.com",
  projectId: "que-vemos-74ff3",
  storageBucket: "que-vemos-74ff3.firebasestorage.app",
  messagingSenderId: "1014785903035",
  appId: "1:1014785903035:web:4787887e2df9d0da6d5c9e"
});
firebase.messaging();

// Subir el número cuando cambie la lista de SHELL (las demás cachés se renuevan solas).
const SHELL_CACHE = "qv-shell-v1";
const DATA_CACHE = "qv-data";
const CDN_CACHE = "qv-cdn";
const SHELL = ["./", "favicon.svg", "manifest.webmanifest", "icons/apple-touch-icon.png", "icons/icon-192.png"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keep = [SHELL_CACHE, DATA_CACHE, CDN_CACHE];
    for(const k of await caches.keys()) if(!keep.includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if(req.method !== "GET") return;
  const url = new URL(req.url);

  if(req.mode === "navigate" && url.origin === location.origin){
    event.respondWith(networkFirstPage(req));
  } else if(url.origin === location.origin && url.pathname.includes("/data/") && url.pathname.endsWith(".json")){
    event.respondWith(staleWhileRevalidate(event));
  } else if(url.origin === location.origin && SHELL.some(p => p !== "./" && url.pathname.endsWith("/" + p))){
    event.respondWith(caches.match(req).then(r => r || fetch(req)));
  } else if(url.href.startsWith("https://www.gstatic.com/firebasejs/10.14.1/") || url.hostname === "fonts.gstatic.com" || url.hostname === "fonts.googleapis.com"){
    event.respondWith(cacheFirst(req));
  }
  // Todo lo demás (Firestore, Auth, FCM…) pasa directo, sin tocar.
});

async function networkFirstPage(req){
  const cache = await caches.open(SHELL_CACHE);
  try{
    const res = await Promise.race([
      fetch(req),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3500))
    ]);
    if(res.ok) await cache.put("./", res.clone());
    return res;
  }catch(e){
    return (await cache.match("./")) || Response.error();
  }
}

async function staleWhileRevalidate(event){
  const req = event.request;
  const cache = await caches.open(DATA_CACHE);
  const cached = await cache.match(req);
  const old = cached ? await cached.clone().text() : null;
  const network = fetch(req).then(async res => {
    if(res.ok){
      const fresh = await res.clone().text();
      await cache.put(req, res.clone());
      if(old !== null && old !== fresh){
        for(const c of await self.clients.matchAll({ type: "window" })) c.postMessage({ type: "qv-data-updated" });
      }
    }
    return res;
  });
  if(cached){
    event.waitUntil(network.catch(() => {}));
    return cached;
  }
  return network;
}

async function cacheFirst(req){
  const cache = await caches.open(CDN_CACHE);
  const cached = await cache.match(req);
  if(cached) return cached;
  const res = await fetch(req);
  if(res.ok || res.type === "opaque") await cache.put(req, res.clone());
  return res;
}
