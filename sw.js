/* ============================================================
   TIDELYNE SERVICE WORKER
   ------------------------------------------------------------
   VERSION must equal UPDATES[0].version in index.html
   (window.TL_VERSION). Bump it on EVERY release: the cache name is
   derived from it, older caches are swept on activate, and every open
   tab is told {type:'TL_UPDATED'} so it can offer a reload.

   Strategy
     navigations + *.html   network-first → cache → ./index.html (a nested path
                            under the scope redirects to the scope instead of
                            getting the shell served there); with a cached
                            copy the network gets SHELL_TIMEOUT_MS (lie-fi: a
                            stalled connection must not hold the opening page)
                            and a host 5xx never replaces the cached shell;
                            navigation preload starts the request before boot
     other same-origin GET  stale-while-revalidate; a ?v= that is not this
                            worker's VERSION (a newer shell served by the old
                            worker right after a release) is network-first
     three.min.js (CDN)     cache-first in a version-independent cache, so
                            the 3D lab works offline once it has been opened
     Google Fonts           CSS stale-while-revalidate, font files cache-first,
                            in their own version-independent cache (offline
                            typography; the files are immutable)
     other cross-origin     never intercepted (Supabase, jsDelivr, YouTube go
                            straight through)
   ============================================================ */
'use strict';

const VERSION      = '3.2.0';
const CACHE_PREFIX = 'tidelyne-v';
const CACHE        = CACHE_PREFIX + VERSION;
const INDEX        = './index.html';
// A connection that is up but stalled ("lie-fi") would otherwise hold a navigation for the browser's own
// request timeout although the shell is precached: after this long the cached copy is served and the network
// answer, kept alive with waitUntil, still refreshes the cache for the next visit.
const SHELL_TIMEOUT_MS = 3000;
// The pinned, immutable Three.js build the 3D lab injects (index.html ensureViz3DReady, loaded with
// crossorigin so the response is not opaque). It lives in its own cache that survives version sweeps:
// its name must NOT start with CACHE_PREFIX ('tidelyne-v…'), or activate() would delete it.
const THREE_URL    = 'https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js';
const VENDOR_CACHE = 'tl-vendor-cache';
// Google Fonts: the CSS (fonts.googleapis.com, loaded with crossorigin so the response is not opaque)
// and the immutable font files it names (fonts.gstatic.com). Same naming rule as VENDOR_CACHE.
const FONTS_CSS_ORIGIN  = 'https://fonts.googleapis.com';
const FONTS_FILE_ORIGIN = 'https://fonts.gstatic.com';
const FONTS_CACHE       = 'tl-fonts-cache';

// Numeric dotted-version compare ("3.10.0" > "3.9.1"); mirrors cmpVer in index.html.
function cmpVer(a, b){
  const pa = String(a || '').split('.').map(function(n){ return parseInt(n, 10) || 0; });
  const pb = String(b || '').split('.').map(function(n){ return parseInt(n, 10) || 0; });
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++){ const x = pa[i] || 0, y = pb[i] || 0; if (x !== y) return x < y ? -1 : 1; }
  return 0;
}
// Every navigation to the shell ('./', './?x', './index.html') is stored once, under INDEX — only at the
// scope's own directory: a nested '/JAC_Online/foo/' or '/JAC_Online/a/index.html' is not the shell (see
// cachedShell in networkFirst). Other pages are keyed by origin + pathname so query-string variants share one entry.
function shellKey(req){
  try {
    const u = new URL(req.url), p = u.pathname;
    if ((p.charAt(p.length - 1) === '/' || /\/index\.html$/i.test(p)) && inScopeDir(req)) return INDEX;
    return u.origin + p;
  } catch(e){}
  return req;
}
// True when the request's directory is the scope's own ('/JAC_Online/foo' yes, '/JAC_Online/foo/' and
// '/JAC_Online/a/b.html' no). Unknown (no scope, unparsable URL) counts as in scope: never redirect blindly.
function inScopeDir(req){
  try {
    const dir = new URL(req.url).pathname.replace(/[^/]*$/, '');
    const scopeDir = new URL(self.registration.scope).pathname.replace(/[^/]*$/, '');
    return dir === scopeDir;
  } catch(e){}
  return true;
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
  './favicon-192.png'
  // apple-touch-180.png, icon-512.png and icon-512-maskable.png are fetched by the OS once at
  // install time, never by the page: precaching them cost every user 73 KB per version bump.
];

// ─── INSTALL: precache the core shell, one file at a time so a single
// missing asset can never block the whole install. ──────────────────────
// cache:'no-cache' always revalidates (freshness is the same as 'reload') but lets the host answer 304 for
// the bytes the browser fetched seconds ago, so a first visit or a version bump transfers only the files
// that actually changed (~400 KB otherwise). The HTTP cache is keyed by URL, so the two big files are
// fetched by the URL the page used — the navigation was './' (not './index.html') and the 3D module is
// requested as './viz-human.js?v=<VERSION>' (the idle warm's prefetch and the lab's <script>) — and stored
// under the key the fetch handler looks up (INDEX; the un-versioned module path, which assetKey collapses to).
// A Data Saver user gets the 3D module on demand instead (index.html never warms it for them either).
const PRECACHE_SOURCE = { './index.html': './', './viz-human.js': './viz-human.js?v=' + encodeURIComponent(VERSION) };
function precacheList(){
  try {
    if (self.navigator && self.navigator.connection && self.navigator.connection.saveData) return PRECACHE.filter(function(u){ return u !== './viz-human.js'; });
  } catch(e){}
  return PRECACHE;
}
self.addEventListener('install', function(event){
  event.waitUntil(
    caches.open(CACHE).then(function(cache){
      return Promise.all(precacheList().map(function(url){
        return fetch(new Request(PRECACHE_SOURCE[url] || url, { cache: 'no-cache' })).then(function(res){
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
        // Let the browser start a navigation's request in parallel with the worker's boot
        // (event.preloadResponse in networkFirst) instead of after it.
        .then(function(){ return self.registration.navigationPreload ? self.registration.navigationPreload.enable().catch(function(){}) : null; })
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
    else if (url.origin === FONTS_FILE_ORIGIN) event.respondWith(fontFileCacheFirst(req));
    else if (url.origin === FONTS_CSS_ORIGIN) event.respondWith(fontCssStaleWhileRevalidate(event, req));
    return;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return;

  const isPage = req.mode === 'navigate' || /\.html$/i.test(url.pathname) || url.pathname.charAt(url.pathname.length - 1) === '/';
  if (isPage){ event.respondWith(networkFirst(event, req)); return; }
  // A cache-busted asset built for ANOTHER shell version (the first navigation after a release: this worker,
  // still in control, served the NEW index.html network-first and it now asks for viz-human.js?v=<new>).
  // assetKey collapses every ?v= to one entry, so stale-while-revalidate would hand the module of the
  // previous release to the new page and refresh only in the background. Network first for a foreign
  // version; the cached copy is the offline fallback only. The new worker (VERSION matches) keeps the
  // cache-first path.
  const ver = /(?:^|[?&])v=([^&]*)/.exec(url.search);
  if (ver && safeDecode(ver[1]) !== VERSION){ event.respondWith(foreignVersionNetworkFirst(event, req)); return; }
  event.respondWith(staleWhileRevalidate(event, req));
});
function safeDecode(s){ try { return decodeURIComponent(s); } catch(e){ return s; } }
function foreignVersionNetworkFirst(event, req){
  // A real answer (including a 404) is returned as-is; only a failed fetch (offline) falls back to the cache.
  return fetch(req).catch(function(){
    return caches.open(CACHE).then(function(cache){ return cache.match(assetKey(req)); })
      .then(function(hit){ return hit || offlineResponse(); }, function(){ return offlineResponse(); });
  });
}

function networkFirst(event, req){
  const key = shellKey(req);
  return caches.open(CACHE).then(function(cache){
    // The navigation-preload response (started by the browser before this worker booted) is the
    // network answer when there is one; anything else (subresource .html, preload disabled) fetches.
    const network = Promise.resolve(event.preloadResponse || null).then(function(pre){ return pre || fetch(req); }).then(function(res){
      // A real answer (including 404) is returned as-is; only good ones are cached.
      if (res && res.ok) cache.put(key, res.clone()).catch(function(){});
      return res;
    });
    // A host error page (5xx: a GitHub Pages incident, a CDN edge failure) must not replace a good
    // cached shell. Everything else — including a genuine 404 for the custom 404.html — passes through.
    const hostError = function(res){ return !!res && res.status >= 500; };
    // The shell stands in for any page that is not cached — but only at the scope's own directory. Served
    // at a nested path (/JAC_Online/foo/, /JAC_Online/a/b.html: a mistyped or stale bookmark), index.html
    // would resolve every relative asset, legal link and its own ./sw.js under that directory and open
    // broken; a redirect to the scope lands the app at its real address instead (the hash rides along).
    const cachedShell = function(){
      return cache.match(key, { ignoreSearch: true }).then(function(hit){
        if (hit) return hit;
        if (key !== INDEX && !inScopeDir(req)) return Response.redirect(self.registration.scope, 302);
        return cache.match(INDEX);
      });
    };
    const fromCache = function(){ return cachedShell().then(function(hit){ return hit || offlineResponse(); }); };
    return cache.match(key, { ignoreSearch: true }).then(function(cached){
      if (!cached){                                             // nothing to fall back on: wait for the network as before
        return network.then(function(res){
          if (!hostError(res)) return res;
          return cachedShell().then(function(hit){ return hit || res; });
        }, fromCache);
      }
      let timer = 0;
      const timeout = new Promise(function(resolve){ timer = setTimeout(function(){ resolve(null); }, SHELL_TIMEOUT_MS); });
      const settled = network.then(function(res){ clearTimeout(timer); return res; }, function(){ clearTimeout(timer); return null; });
      return Promise.race([settled, timeout]).then(function(res){
        if (res && !hostError(res)) return res;
        try { event.waitUntil(network.catch(function(){})); } catch(e){}   // let the late answer still refresh the cache
        return cached;
      });
    });
  }).catch(function(){ return storageBroken(event, req); });
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
  }).catch(function(){ return storageBroken(event, req); });
}

// CacheStorage can fail while a worker is already in control (Chrome's "Internal error opening backing
// store", a corrupted profile, a quota sweep). respondWith() must still get a response, so the request
// goes straight to the network — through the navigation preload when the browser already started it —
// and the worker unregisters itself once so the next load runs without it and re-registers cleanly.
let storageFailed = false;
function storageBroken(event, req){
  if (!storageFailed){
    storageFailed = true;
    try { self.registration.unregister().catch(function(){}); } catch(e){}
  }
  return Promise.resolve(event && event.preloadResponse || null).then(function(pre){ return pre || fetch(req); }, function(){ return fetch(req); });
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

// Font files are immutable (max-age=31536000, immutable) and CORS-enabled: a cached copy is always right.
// Non-OK and opaque responses pass through uncached, so an error can never be pinned.
function fontFileCacheFirst(req){
  return caches.open(FONTS_CACHE).then(function(cache){
    return cache.match(req, { ignoreVary: true }).then(function(hit){
      if (hit) return hit;
      return fetch(req).then(function(res){
        if (res && res.ok && res.type !== 'opaque') cache.put(req, res.clone()).catch(function(){});
        return res;
      });
    });
  }).catch(function(){ return fetch(req); });
}
// The font CSS is served per browser and changes when Google ships a new font version: serve the cached copy
// (offline typography), refresh it in the background, and drop font files the fresh CSS no longer names
// so the cache cannot grow across font versions. ignoreVary covers Google's Vary: Sec-Fetch-* header.
function fontCssStaleWhileRevalidate(event, req){
  return caches.open(FONTS_CACHE).then(function(cache){
    return cache.match(req, { ignoreVary: true }).then(function(cached){
      const network = fetch(req).then(function(res){
        if (res && res.ok && res.type !== 'opaque'){
          cache.put(req, res.clone()).catch(function(){});
          res.clone().text().then(function(css){ return sweepFontFiles(cache, css); }).catch(function(){});
        }
        return res;
      });
      if (cached){
        try { event.waitUntil(network.catch(function(){})); } catch(e){}
        return cached;
      }
      return network;
    });
  }).catch(function(){ return fetch(req); });
}
// The app and the legal pages / 404 request different stylesheets (the app's names DM Mono and the DM Sans
// italics, the legal one does not), so the keep-list is the union of EVERY cached stylesheet plus the fresh
// one — a legal-page visit must not evict the files only the app uses. The fresh CSS was put into the cache
// before this runs, so a file a new font version retires is still dropped once no cached stylesheet names it.
function sweepFontFiles(cache, css){
  const keep = {};
  function noteFiles(text){
    (String(text).match(/https:\/\/fonts\.gstatic\.com\/[^)'"\s]+/g) || []).forEach(function(u){ keep[u] = 1; });
  }
  noteFiles(css);
  return cache.keys().then(function(reqs){
    const sheets = reqs.filter(function(r){ return r.url.indexOf(FONTS_CSS_ORIGIN) === 0; });
    return Promise.all(sheets.map(function(r){
      return cache.match(r, { ignoreVary: true }).then(function(res){ return res ? res.text() : ''; }).catch(function(){ return ''; });
    })).then(function(texts){
      texts.forEach(noteFiles);
      return Promise.all(reqs.filter(function(r){ return r.url.indexOf(FONTS_FILE_ORIGIN) === 0 && !keep[r.url]; })
        .map(function(r){ return cache.delete(r); }));
    });
  });
}

function offlineResponse(){
  return new Response('Offline — this file is not cached yet.', {
    status: 503, statusText: 'Offline',
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
