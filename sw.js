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
     three.min.js (CDN)     cache-first in a version-independent cache, so
                            the 3D lab works offline once it has been opened
     other cross-origin     never intercepted (Supabase, jsDelivr,
                            Google Fonts, YouTube go straight through)
   ============================================================ */
'use strict';

const VERSION      = '3.1.1';
const CACHE_PREFIX = 'tidelyne-v';
const CACHE        = CACHE_PREFIX + VERSION;
const INDEX        = './index.html';
// The pinned, immutable Three.js build the 3D lab injects (index.html ensureViz3DReady, loaded with
// crossorigin so the response is not opaque). It lives in its own cache that survives version sweeps:
// its name must NOT start with CACHE_PREFIX ('tidelyne-v…'), or activate() would delete it.
const THREE_URL    = 'https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js';
const VENDOR_CACHE = 'tl-vendor-cache';

// Numeric dotted-version compare ("3.10.0" > "3.9.1"); mirrors cmpVer in index.html.
function cmpVer(a, b){
  const pa = String(a || '').split('.').map(function(n){ return parseInt(n, 10) || 0; });
  const pb = String(b || '').split('.').map(function(n){ return parseInt(n, 10) || 0; });
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++){ const x = pa[i] || 0, y = pb[i] || 0; if (x !== y) return x < y ? -1 : 1; }
  return 0;
}
// Every navigation to the shell ('./', './?x', './index.html') is stored once, under INDEX;
// other pages are keyed by origin + pathname so query-string variants share one entry.
function shellKey(req){
  try {
    const u = new URL(req.url), p = u.pathname;
    if (p.charAt(p.length - 1) === '/' || /\/index\.html$/i.test(p)) return INDEX;
    return u.origin + p;
  } catch(e){}
  return req;
}
// Cache-busted assets ('./viz-human.js?v=3.1.1') share one entry with the precached un-versioned file.
function assetKey(req){
  try {
    const u = new URL(req.url);
    if (/(^|[?&])v=/.test(u.search)) return u.origin + u.pathname;
  } catch(e){}
  return req;
}

const PRECACHE = [
  './index.html',
  './viz-human.js',
  './privacy.html',
  './terms.html',
  './disclaimer.html',
  './site.webmanifest',
  './logo-mark.svg',
  './favicon.ico',
  './favicon-32.png',
  './favicon-192.png',
  './apple-touch-180.png',
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
      // caches.keys() order is unspecified: pick the newest stale version, not an arbitrary one.
      const previous = old.length ? old.map(function(k){ return k.slice(CACHE_PREFIX.length); }).sort(cmpVer).pop() : null;
      return Promise.all(old.map(function(k){ return caches.delete(k); }))
        .then(function(){ return sweepVendor(); })
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
  if (url.origin !== self.location.origin){                       // cross-origin: untouched …
    if (url.href === THREE_URL) event.respondWith(vendorCacheFirst(req)); // … except the pinned Three.js build
    return;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return;

  const isPage = req.mode === 'navigate' || /\.html$/i.test(url.pathname) || url.pathname.charAt(url.pathname.length - 1) === '/';
  if (isPage){ event.respondWith(networkFirst(req)); return; }
  event.respondWith(staleWhileRevalidate(event, req));
});

function networkFirst(req){
  const key = shellKey(req);
  return caches.open(CACHE).then(function(cache){
    return fetch(req).then(function(res){
      // A real answer (including 404) is returned as-is; only good ones are cached.
      if (res && res.ok) cache.put(key, res.clone()).catch(function(){});
      return res;
    }).catch(function(){
      return cache.match(key, { ignoreSearch: true }).then(function(hit){
        if (hit) return hit;
        return cache.match(INDEX).then(function(index){ return index || offlineResponse(); });
      });
    });
  });
}

function staleWhileRevalidate(event, req){
  const key = assetKey(req);
  return caches.open(CACHE).then(function(cache){
    return cache.match(key).then(function(cached){
      const network = fetch(req).then(function(res){
        if (res && res.ok) cache.put(key, res.clone()).catch(function(){});
        return res;
      }).catch(function(){ return null; });
      if (cached){
        // Keep the worker alive until the background refresh finishes.
        try { event.waitUntil(network); } catch(e){}
        return cached;
      }
      return network.then(function(res){ return res || cache.match(key, { ignoreSearch: true }); })
        .then(function(res){ return res || offlineResponse(); });
    });
  });
}

// Three.js is pinned and immutable, so a cached copy is always right: serve it first and only fetch
// on a miss. Non-OK and opaque responses are passed through uncached; ignoreVary covers the CDN's
// Vary: Accept-Encoding header.
function vendorCacheFirst(req){
  return caches.open(VENDOR_CACHE).then(function(cache){
    return cache.match(req, { ignoreVary: true }).then(function(hit){
      if (hit) return hit;
      return fetch(req).then(function(res){
        if (res && res.ok && res.type !== 'opaque') cache.put(req, res.clone()).catch(function(){});
        return res;
      });
    });
  }).catch(function(){ return fetch(req); });
}
function sweepVendor(){
  return caches.open(VENDOR_CACHE).then(function(cache){
    return cache.keys().then(function(reqs){
      return Promise.all(reqs.filter(function(r){ return r.url !== THREE_URL; }).map(function(r){ return cache.delete(r); }));
    });
  }).catch(function(){});
}

function offlineResponse(){
  return new Response('Offline — this file is not cached yet.', {
    status: 503, statusText: 'Offline',
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
