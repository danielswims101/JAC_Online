/* ============================================================
   TIDELYNE SERVICE WORKER
   ------------------------------------------------------------
   VERSION must equal UPDATES[0].version in index.html
   (window.TL_VERSION). Bump it on EVERY release: the cache name is
   derived from it, older caches are swept on activate, and every open
   tab is told {type:'TL_UPDATED'} so it can offer a reload.

   Strategy
     navigations + *.html   network-first → cache → ./index.html
     other same-origin GET  stale-while-revalidate
     cross-origin           never intercepted (Supabase, jsDelivr,
                            Google Fonts, YouTube go straight through)
   ============================================================ */
'use strict';

const VERSION      = '3.0.1';
const CACHE_PREFIX = 'tidelyne-v';
const CACHE        = CACHE_PREFIX + VERSION;
const INDEX        = './index.html';

const PRECACHE = [
  './',
  './index.html',
  './privacy.html',
  './terms.html',
  './disclaimer.html',
  './404.html',
  './site.webmanifest',
  './logo-mark.svg',
  './logo-full.svg',
  './favicon-32.png',
  './favicon-192.png',
  './apple-touch-180.png',
  './og.png',
  './icon-512.png',
  './icon-512-maskable.png'
];

// ─── INSTALL: precache the core shell, one file at a time so a single
// missing asset can never block the whole install. ──────────────────────
self.addEventListener('install', function(event){
  event.waitUntil(
    caches.open(CACHE).then(function(cache){
      return Promise.all(PRECACHE.map(function(url){
        return fetch(new Request(url, { cache: 'reload' })).then(function(res){
          if (res && res.ok) return cache.put(url, res);
        }).catch(function(){ /* skipped — fetched on demand later */ });
      }));
    }).then(function(){ return self.skipWaiting(); })
  );
});

// ─── ACTIVATE: sweep old versions, take control, announce ──────────────
self.addEventListener('activate', function(event){
  event.waitUntil(
    caches.keys().then(function(keys){
      const old = keys.filter(function(k){ return k.indexOf(CACHE_PREFIX) === 0 && k !== CACHE; });
      const previous = old.length ? old[old.length - 1].slice(CACHE_PREFIX.length) : null;
      return Promise.all(old.map(function(k){ return caches.delete(k); }))
        .then(function(){ return self.clients.claim(); })
        .then(function(){ return self.clients.matchAll({ type: 'window', includeUncontrolled: true }); })
        .then(function(clients){
          clients.forEach(function(c){
            try { c.postMessage({ type: 'TL_UPDATED', version: VERSION, previous: previous }); } catch(e){}
          });
        });
    })
  );
});

// ─── MESSAGES: the page can ask which version is in control ────────────
self.addEventListener('message', function(event){
  const d = event && event.data;
  if (!d || d.type !== 'TL_GET_VERSION') return;
  const src = event.source;
  if (src && typeof src.postMessage === 'function'){
    try { src.postMessage({ type: 'TL_VERSION', version: VERSION }); } catch(e){}
  }
});

// ─── FETCH ─────────────────────────────────────────────────────────────
self.addEventListener('fetch', function(event){
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch(e){ return; }
  if (url.origin !== self.location.origin) return;               // cross-origin: untouched
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return;

  const isPage = req.mode === 'navigate' || /\.html$/i.test(url.pathname) || url.pathname.charAt(url.pathname.length - 1) === '/';
  if (isPage){ event.respondWith(networkFirst(req)); return; }
  event.respondWith(staleWhileRevalidate(event, req));
});

function networkFirst(req){
  return caches.open(CACHE).then(function(cache){
    return fetch(req).then(function(res){
      // A real answer (including 404) is returned as-is; only good ones are cached.
      if (res && res.ok) cache.put(req, res.clone()).catch(function(){});
      return res;
    }).catch(function(){
      return cache.match(req, { ignoreSearch: true }).then(function(hit){
        if (hit) return hit;
        return cache.match(INDEX).then(function(index){
          if (index) return index;
          return cache.match('./').then(function(root){ return root || offlineResponse(); });
        });
      });
    });
  });
}

function staleWhileRevalidate(event, req){
  return caches.open(CACHE).then(function(cache){
    return cache.match(req).then(function(cached){
      const network = fetch(req).then(function(res){
        if (res && res.ok) cache.put(req, res.clone()).catch(function(){});
        return res;
      }).catch(function(){ return null; });
      if (cached){
        // Keep the worker alive until the background refresh finishes.
        try { event.waitUntil(network); } catch(e){}
        return cached;
      }
      return network.then(function(res){ return res || offlineResponse(); });
    });
  });
}

function offlineResponse(){
  return new Response('Offline — this file is not cached yet.', {
    status: 503, statusText: 'Offline',
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
