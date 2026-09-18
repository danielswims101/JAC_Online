/* ============================================================
   TIDELYNE — REALISTIC 3D SWIMMER  (viz-human.js)
   ------------------------------------------------------------
   Procedural, rigged human swimmer for the 3D biomechanics lab.
   Loaded lazily by index.html (ensureViz3DReady) right after
   Three.js r128 (UMD global). If this file fails to load, or a
   build throws on a device, index.html falls back to its built-in
   segmented mannequin (buildSwimmer) — nothing else changes.

   Three plain-script IIFE modules, concatenated in dependency order:

     1. window.TL_HumanMaterials  wet-skin / lycra / silicone /
                                  goggle materials, a pool-tinted
                                  PMREM environment, a lighting pass
                                  (shadow bias, rim), skin tones and
                                  the caustics hook (shares
                                  causticsTex.offset with the scene)
     2. window.TL_HumanMotion     C1 shape-limited spline over the
                                  SAME stroke keyframes the mannequin
                                  uses, secondary motion (forearm and
                                  wrist twist, ankles, scapula, hip
                                  counter-roll, breath split), the
                                  arm-vs-torso clearance solver and
                                  STROKE_PATCHES / applyPatches
     3. window.TL_Human           implicit-surface anatomy (real
                                  athlete proportions) → marching
                                  cubes (tables inline) → one
                                  THREE.SkinnedMesh with skin / suit /
                                  cap groups + rigid goggles, on the
                                  mannequin's joint hierarchy;
                                  buildHumanSwimmer / …Async

   No top-level THREE access: every function resolves window.THREE
   when called, so this file may execute before or after three.min.js
   as long as it runs before startViz3D. No external assets — every
   texture is generated (seeded, deterministic). Cache-busted by
   index.html as ./viz-human.js?v=<TL_VERSION>; listed in sw.js
   PRECACHE. Bump TL_VERSION (UPDATES[0]) and sw.js VERSION together.
   Module versions: materials.js 1.4.0, motion.js 1.11.0, body.js 1.5.0
   ============================================================ */

/* ─────────────────────────────────────────────────────────────────────────────
 * Tidelyne — human/materials.js → window.TL_HumanMaterials   (SPEC §9.2)
 *
 * Wet-skin / lycra / silicone / goggle materials, a procedural underwater
 * PMREM environment and a lighting pass for the procedural swimmer.
 * Three.js r128 UMD only. Plain script (IIFE), no top-level THREE access —
 * Three is lazy-loaded by index.html; every function resolves THREE when called.
 *
 * Key facts this file is built on (verified against node_modules/three@0.128.0):
 *  • ALL maps share ONE uvTransform (taken from `map` first) → caustics can not
 *    be an emissiveMap once a skin `map`/`normalMap` exists. They are injected via
 *    onBeforeCompile with their own sampler + uCausticOffset, world-space
 *    triplanar projection. uCausticOffset.value IS causticsTex.offset (same
 *    Vector2), so animate3D's existing scroll drives the body with zero changes.
 *  • r128 `sheen` is a Color|null and REPLACES the GGX direct specular with the
 *    Charlie cloth lobe → great for the suit, never for skin.
 *  • `transmission` is a stub (alpha blend); goggles use it only at 0.15.
 *  • `material.skinning = true` is mandatory for SkinnedMesh on r128.
 *  • PCFSoftShadowMap ignores shadow.radius; VSM honours it.
 *  • PMREMGenerator writes RGBE (unsigned byte) → works on WebGL1.
 *  • Textures are deterministic (seeded mulberry32) DataTextures — no canvas,
 *    no Math.random, no external files; generated once and cached.
 * ───────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var VERSION = '1.4.0';   // round-4: two-octave pores at half depth (normalScale 0.55), ±0.18 oil roughness, lips tint + pore masks from the bind-space position
  var GLOBAL = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : this);

  function T() {
    var t = GLOBAL.THREE || (typeof global !== 'undefined' && global.THREE);
    if (!t) throw new Error('TL_HumanMaterials: THREE (r128) is not loaded yet');
    return t;
  }

  /* ═══════════════════════════════ 1. Deterministic noise ═══════════════════ */

  // mulberry32 — tiny, fast, deterministic 32-bit PRNG.
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
  // finite-number option or the default (NaN, Infinity, strings and undefined all fall back)
  function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function posNum(v, d) { v = num(v, d); return v > 0 ? v : d; }
  function isPow2(n) { return n > 0 && (n & (n - 1)) === 0; }
  function smoothstep(e0, e1, x) { var t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); }
  function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
  function srgbToLinear(c) { return c < 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function linearToSrgb(c) { return c < 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; }

  // Tileable value-noise lattice with integer period P (wraps by construction).
  function makeLattice(P, rng) {
    var a = new Float32Array(P * P);
    for (var i = 0; i < a.length; i++) a[i] = rng();
    return { P: P, a: a };
  }
  function valueNoise(l, x, y) {          // x,y in tile units [0,1) → [0,1]
    var P = l.P, a = l.a;
    var gx = x * P, gy = y * P;
    var ix = Math.floor(gx), iy = Math.floor(gy);
    var fx = gx - ix, fy = gy - iy;
    ix = ((ix % P) + P) % P; iy = ((iy % P) + P) % P;
    var ix1 = (ix + 1) % P, iy1 = (iy + 1) % P;
    var ux = fade(fx), uy = fade(fy);
    var v00 = a[iy * P + ix], v10 = a[iy * P + ix1], v01 = a[iy1 * P + ix], v11 = a[iy1 * P + ix1];
    return (v00 + (v10 - v00) * ux) * (1 - uy) + (v01 + (v11 - v01) * ux) * uy;
  }
  // fBm of tileable value noise → roughly [-1, 1], zero-mean.
  function makeFbm(P, octaves, seed) {
    var rng = mulberry32(seed), ls = [];
    for (var o = 0; o < octaves; o++) ls.push(makeLattice(P << o, rng));
    var norm = 0, amp = 1;
    for (o = 0; o < octaves; o++) { norm += amp; amp *= 0.5; }
    return function (x, y) {
      var s = 0, amp = 1;
      for (var o = 0; o < ls.length; o++) { s += (valueNoise(ls[o], x, y) - 0.5) * 2 * amp; amp *= 0.5; }
      return s / norm;
    };
  }
  // Tileable Worley (cellular) noise: one jittered feature point per cell.
  function makeCells(P, seed) {
    var rng = mulberry32(seed), j = new Float32Array(P * P * 2), m = new Float32Array(P * P);
    for (var i = 0; i < P * P; i++) { j[i * 2] = rng(); j[i * 2 + 1] = rng(); m[i] = rng(); }
    return { P: P, j: j, m: m };
  }
  var _w = { f1: 0, f2: 0, mask: 0 };
  function worley(c, x, y) {              // distances in cell units; fills _w
    var P = c.P, gx = x * P, gy = y * P;
    var cx = Math.floor(gx), cy = Math.floor(gy);
    var f1 = 1e9, f2 = 1e9, mask = 0;
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        var ncx = cx + dx, ncy = cy + dy;
        var wcx = ((ncx % P) + P) % P, wcy = ((ncy % P) + P) % P;
        var idx = wcy * P + wcx;
        var px = ncx + c.j[idx * 2], py = ncy + c.j[idx * 2 + 1];
        var ddx = px - gx, ddy = py - gy, d = Math.sqrt(ddx * ddx + ddy * ddy);
        if (d < f1) { f2 = f1; f1 = d; mask = c.m[idx]; } else if (d < f2) { f2 = d; }
      }
    }
    _w.f1 = f1; _w.f2 = f2; _w.mask = mask;
    return _w;
  }

  /* ═══════════════════════════════ 2. Texture generators ════════════════════ */
  // Every generator returns { data: Uint8Array RGBA, size, meta } and is a pure
  // function of (size, seed) — testable in Node, deterministic everywhere.

  // Skin micro-structure: two nested crease networks (Worley cell boundaries),
  // pores at ~45 % of the fine cells, low-frequency plateau bumps, grain.
  // Nominal tile ≈ 8 cm of skin at uvRepeat 10-12 on a ~1 m torso circumference.
  function skinHeightField(size, seed) {
    var cA = makeCells(48, seed + 11);      // ~1.7 mm cells  → primary line network (faint)
    var cB = makeCells(96, seed + 23);      // ~0.8 mm cells  → fine network + pores
    var cC = makeCells(192, seed + 29);     // ~0.4 mm cells  → a second, finer pore octave (round-4: one pore size read as uniform sandpaper)
    var bump = makeFbm(6, 3, seed + 37);    // 1-2 cm soft undulation
    var grain = makeFbm(48, 1, seed + 41);  // sub-mm grain
    var h = new Float32Array(size * size);
    var crease = new Float32Array(size * size);   // 0..1 "groove-ness" (for roughness/albedo)
    var pores = new Float32Array(size * size);
    for (var y = 0; y < size; y++) {
      var v = (y + 0.5) / size;
      for (var x = 0; x < size; x++) {
        var u = (x + 0.5) / size, i = y * size + x;
        var w = worley(cA, u, v);
        var crA = 1 - smoothstep(0, 0.14, w.f2 - w.f1);
        w = worley(cB, u, v);
        var crB = 1 - smoothstep(0, 0.22, w.f2 - w.f1);
        var pore = w.mask > 0.6 ? (1 - smoothstep(0, 0.26, w.f1)) : 0;
        w = worley(cC, u, v);
        var pore2 = w.mask > 0.72 ? (1 - smoothstep(0, 0.24, w.f1)) : 0;   // sparse 0.4 mm pores between the 0.8 mm ones
        var cr = Math.max(crA, crB * 0.75);
        crease[i] = cr; pores[i] = Math.max(pore, 0.6 * pore2);
        // shallow line network (skin lines are barely visible at arm's length), distinct pores at TWO sizes,
        // soft cm-scale undulation: the relief must break up the highlight, not read as scales or pebbled hide
        h[i] = -0.34 * crA - 0.16 * crB - 0.65 * pore - 0.32 * pore2 + 0.22 * bump(u, v) + 0.07 * grain(u, v);   // round-4: pore depth halved (was −1.35 at normalScale 0.85 = sandpaper under water, pebbled hide above it) + a second octave at 0.4 mm
      }
    }
    return { h: h, crease: crease, pores: pores, size: size };
  }
  function normalFromHeight(field, size, strength) {
    var data = new Uint8Array(size * size * 4);
    for (var y = 0; y < size; y++) {
      var ym = (y - 1 + size) % size, yp = (y + 1) % size;
      for (var x = 0; x < size; x++) {
        var xm = (x - 1 + size) % size, xp = (x + 1) % size;
        var dx = (field[y * size + xp] - field[y * size + xm]) * 0.5 * strength;
        var dy = (field[yp * size + x] - field[ym * size + x]) * 0.5 * strength;
        var nx = -dx, ny = -dy, nz = 1, inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
        var o = (y * size + x) * 4;
        data[o] = Math.round((nx * inv * 0.5 + 0.5) * 255);
        data[o + 1] = Math.round((ny * inv * 0.5 + 0.5) * 255);
        data[o + 2] = Math.round((nz * inv * 0.5 + 0.5) * 255);
        data[o + 3] = 255;
      }
    }
    return data;
  }
  var _skinFieldCache = null;
  function getSkinField(size, seed) {
    if (!_skinFieldCache || _skinFieldCache.size !== size || _skinFieldCache.seed !== seed) {
      _skinFieldCache = skinHeightField(size, seed); _skinFieldCache.seed = seed;
    }
    return _skinFieldCache;
  }
  function genSkinNormal(size, seed) {
    var f = getSkinField(size, seed);
    return { data: normalFromHeight(f.h, size, 3.8), size: size, meta: { kind: 'normal' } };
  }
  // Packed: R = clearcoat factor (patchy water film 0.78-1.0: 2-4 cm sheets and
  // runnels so the film highlight breaks up at arm's length), G = roughness
  // multiplier (plateaus smoother, grooves/pores rougher), B = crease mask.
  function genSkinPacked(size, seed) {
    var f = getSkinField(size, seed), data = new Uint8Array(size * size * 4);
    var patch = makeFbm(3, 3, seed + 53), runnel = makeFbm(5, 2, seed + 57), oil = makeFbm(4, 2, seed + 59);   // oil: 2-3 cm patches of sebum-smooth vs matte skin (round-3: the face was one glaze)
    for (var y = 0; y < size; y++) {
      var v = (y + 0.5) / size;
      for (var x = 0; x < size; x++) {
        var u = (x + 0.5) / size, i = y * size + x, o = i * 4;
        // sheets of water (patch) with sharper-edged drier islands (runnel ridge): 0.78 … 1.0
        var sheet = 0.5 + 0.5 * patch(u, v), dryIsle = smoothstep(0.15, 0.45, runnel(u, v));
        var cc = 0.78 + 0.22 * sheet * (1 - 0.6 * dryIsle) - 0.04 * f.pores[i];
        var rg = 0.74 + 0.10 * Math.max(f.crease[i], f.pores[i]) + 0.06 * dryIsle + 0.36 * (0.5 + 0.5 * oil(u, v));   // 0.74 … 1.26: the 2-3 cm "oil" term is ±0.18 (round-4: ±0.06 was not perceptible — the face was one glaze)
        data[o] = Math.round(clamp01(cc) * 255);
        data[o + 1] = Math.round(clamp01(rg) * 255);
        data[o + 2] = Math.round(clamp01(f.crease[i]) * 255);
        data[o + 3] = 255;
      }
    }
    return { data: data, size: size, meta: { kind: 'packed' } };
  }
  // Albedo mottle: a neutral MULTIPLIER (mean ≈ 0.93 linear) — one texture
  // serves every tone; the tone lives in material.color. sRGB-encoded bytes.
  function genSkinAlbedo(size, seed) {
    var f = getSkinField(size, seed);
    var lum1 = makeFbm(4, 3, seed + 61), lum2 = makeFbm(20, 2, seed + 67), warm = makeFbm(7, 3, seed + 71), yel = makeFbm(3, 2, seed + 73);
    var rng = mulberry32(seed + 79), specks = [];
    // a few faint moles/freckles (1-3 mm): 12 slightly darker, 3 lighter — never dirt-like specks
    for (var s = 0; s < 15; s++) specks.push({ x: rng() * size, y: rng() * size, r: (3 + rng() * 6) * size / 512, k: s < 12 ? 0.88 + rng() * 0.07 : 1.03 });
    var lin = new Float32Array(size * size * 3), sum = 0;
    for (var y = 0; y < size; y++) {
      var v = (y + 0.5) / size;
      for (var x = 0; x < size; x++) {
        var u = (x + 0.5) / size, i = y * size + x;
        // luminance: gentle (real skin varies mostly in hue, not value); lines/pores barely darker
        var m = 1 + 0.032 * lum1(u, v) + 0.014 * lum2(u, v) - 0.012 * f.crease[i] - 0.04 * f.pores[i];
        // hue: red/blue push (blood) at 1-2 cm and a slow yellow/olive drift at 3-4 cm
        var wv = warm(u, v), yv = yel(u, v);
        var r = m * (1 + 0.05 * wv + 0.02 * yv), g = m * (1 + 0.006 * wv + 0.025 * yv), b = m * (1 - 0.045 * wv - 0.03 * yv);
        for (var k = 0; k < specks.length; k++) {
          var sp = specks[k];
          var dx = Math.abs(x - sp.x), dy = Math.abs(y - sp.y);
          if (dx > size / 2) dx = size - dx; if (dy > size / 2) dy = size - dy;
          var d2 = (dx * dx + dy * dy) / (sp.r * sp.r);
          if (d2 < 4) { var e = Math.exp(-d2 * 1.5), fk = 1 + (sp.k - 1) * e; r *= fk; g *= fk; b *= fk; }
        }
        lin[i * 3] = r; lin[i * 3 + 1] = g; lin[i * 3 + 2] = b; sum += (r + g + b) / 3;
      }
    }
    // normalise so the max is ≤ 1 and record the true mean for colour compensation
    var scale = 0.93 / (sum / (size * size)), data = new Uint8Array(size * size * 4), mean = 0;
    for (i = 0; i < size * size; i++) {
      var R = clamp01(lin[i * 3] * scale), G = clamp01(lin[i * 3 + 1] * scale), B = clamp01(lin[i * 3 + 2] * scale);
      mean += (R + G + B) / 3;
      data[i * 4] = Math.round(linearToSrgb(R) * 255);
      data[i * 4 + 1] = Math.round(linearToSrgb(G) * 255);
      data[i * 4 + 2] = Math.round(linearToSrgb(B) * 255);
      data[i * 4 + 3] = 255;
    }
    return { data: data, size: size, meta: { kind: 'albedo', meanLinear: mean / (size * size) } };
  }
  // Lycra/tricot weave: fine 45° ribs with a secondary cross rib and a little
  // fibre noise. Nominal tile ≈ 2.5 cm → 1 mm ribs at uvRepeat ≈ 40/m.
  function genWeaveNormal(size, seed) {
    var P = 24, TAU = Math.PI * 2, fib = makeFbm(32, 2, seed + 83);
    var h = new Float32Array(size * size);
    for (var y = 0; y < size; y++) {
      var v = (y + 0.5) / size;
      for (var x = 0; x < size; x++) {
        var u = (x + 0.5) / size;
        var rib = Math.sin(TAU * P * (u + v));
        var cross = 0.75 + 0.25 * Math.sin(TAU * 2 * P * (u - v));
        var twill = Math.sin(TAU * 6 * (u - v));            // coarse ~4 mm diagonal so the knit still reads at 0.5 m
        h[y * size + x] = 0.5 * rib * cross + 0.22 * twill * (0.6 + 0.4 * cross) + 0.12 * fib(u, v);
      }
    }
    return { data: normalFromHeight(h, size, 2.2), size: size, meta: { kind: 'normal' } };
  }
  // Silicone "orange peel": very soft, low-frequency only.
  function genPeelNormal(size, seed) {
    var f1 = makeFbm(8, 3, seed + 91), h = new Float32Array(size * size);
    for (var y = 0; y < size; y++) { var v = (y + 0.5) / size; for (var x = 0; x < size; x++) h[y * size + x] = f1((x + 0.5) / size, v); }
    return { data: normalFromHeight(h, size, 1.6), size: size, meta: { kind: 'normal' } };
  }
  // Stretched silicone cap: soft orange peel + meridional stretch wrinkles (1-2 mm creases running
  // crown → rim, denser and deeper toward the rim where the cap is pulled over the ears) + the
  // moulded crown seam. The tile is authored for the head's spherical UVs at uvRepeat 2: u = azimuth
  // (tile u = 0 at the front AND the back meridian → the seam runs front-to-back over the crown),
  // v = polar angle (tile ≈ 12 cm of the crown → rim distance).
  function genCapNormal(size, seed) {
    var peel = makeFbm(6, 3, seed + 91), wob = makeFbm(4, 2, seed + 95), fine = makeFbm(24, 2, seed + 97);
    var h = new Float32Array(size * size), TAU = Math.PI * 2;
    for (var y = 0; y < size; y++) {
      var v = (y + 0.5) / size;
      for (var x = 0; x < size; x++) {
        var u = (x + 0.5) / size, i = y * size + x;
        // ~14 meridional creases per tile (≈ 2 cm apart at the widest), wandering by ±0.5 crease with the wobble
        var ph = TAU * (14 * u + 0.5 * wob(u, v));
        var crease = Math.pow(0.5 + 0.5 * Math.cos(ph), 6);                 // narrow ridges, wide flats
        var amp = 0.18 + 0.32 * smoothstep(0.35, 1.0, v);                   // deeper toward the rim
        // crown seam: a 1.4 mm raised bead along the u = 0 meridian, both sides of the wrap
        var du = Math.min(u, 1 - u), seam = Math.exp(-du * du / (2 * 0.006 * 0.006));
        // round-2: the meridians converge at the crown (tile v ≈ 0 — the head's spherical v wraps there), so every u-dependent
        // term is faded out inside the polar cap (≈ 8 mm) — the blocky pixel-star at the seam origin is gone
        var pole = smoothstep(0.0, 0.08, Math.min(v, 1 - v));
        h[i] = (0.35 * peel(u, v) + amp * crease * (0.7 + 0.3 * fine(u, v)) + 0.9 * seam) * pole + 0.04 * fine(u, v);
      }
    }
    return { data: normalFromHeight(h, size, 2.6), size: size, meta: { kind: 'normal' } };
  }
  // Byte-exact replica of index.html makeCausticTexture() (lines 3432-3454) as
  // pixel data — the fallback when the integrator does not pass causticsTex.
  function genCaustic(size) {
    var S = size, TAU = Math.PI * 2, data = new Uint8Array(S * S * 4);
    for (var y = 0; y < S; y++) {
      for (var x = 0; x < S; x++) {
        var u = x / S, v = y / S;
        var n1 = Math.sin(TAU * (3 * u + 0.7 * Math.sin(TAU * 2 * v))) * Math.sin(TAU * (2 * v + 0.6 * Math.sin(TAU * 3 * u)));
        var n2 = Math.sin(TAU * (5 * u + 0.5 * Math.sin(TAU * 3 * v))) * Math.sin(TAU * (4 * v + 0.4 * Math.sin(TAU * 2 * u)));
        var c = Math.min(1, Math.pow(Math.abs(n1), 6) + Math.pow(Math.abs(n2), 8) * 0.7);
        var i = (y * S + x) * 4, b = Math.floor(c * 255);
        data[i] = b; data[i + 1] = b; data[i + 2] = b; data[i + 3] = 255;
      }
    }
    return { data: data, size: S, meta: { kind: 'caustic' } };
  }

  /* ═══════════════════════════════ 3. Texture cache ═════════════════════════ */
  var SEED = 20260913;
  var _tex = {};          // name → THREE.DataTexture
  var _texMeta = {};      // name → meta from the generator
  var _maxAniso = 1;      // recorded from the renderer when we see one
  var GEN = {
    skinNormal: function () { return genSkinNormal(512, SEED); },
    skinPacked: function () { return genSkinPacked(512, SEED); },
    skinAlbedo: function () { return genSkinAlbedo(512, SEED); },
    weaveNormal: function () { return genWeaveNormal(256, SEED); },
    peelNormal: function () { return genPeelNormal(128, SEED); },
    capNormal: function () { return genCapNormal(256, SEED); },
    caustic: function () { return genCaustic(256); }
  };
  function makeDataTexture(px, opts) {
    var THREE = T();
    var tex = new THREE.DataTexture(px.data, px.size, px.size, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = Math.max(1, Math.min(8, _maxAniso));
    tex.encoding = (opts && opts.srgb) ? THREE.sRGBEncoding : THREE.LinearEncoding;
    tex.flipY = false;
    tex.needsUpdate = true;
    tex.name = 'TL_' + ((opts && opts.name) || 'tex');
    return tex;
  }
  function getTexture(name, repeat) {
    if (!_tex[name]) {
      var px = GEN[name]();
      _texMeta[name] = px.meta;
      _tex[name] = makeDataTexture(px, { srgb: name === 'skinAlbedo', name: name });
      if (name === 'caustic') _tex[name].repeat.set(3, 3);
    }
    var t = _tex[name];
    // NOTE: textures are shared, so `repeat` is a global setting for that map (last caller wins);
    // non-finite / non-positive values are ignored rather than poisoning the shared uvTransform.
    if (repeat !== undefined && name !== 'caustic') { var r = posNum(repeat, 0); if (r > 0) t.repeat.set(r, r); }
    return t;
  }
  // Called when a renderer is first seen: raise the anisotropy of textures that were
  // built before we knew the GPU limit (re-uploads them once via needsUpdate).
  function applyAnisotropy() {
    var a = Math.max(1, Math.min(8, _maxAniso));
    for (var k in _tex) { var t = _tex[k]; if (t && t.anisotropy !== a) { t.anisotropy = a; t.needsUpdate = true; } }
  }
  // Free every shared texture (and the PMREM of `renderer`, if given). Only for a
  // full teardown of the 3D view: registered materials are dropped too.
  function disposeShared(renderer) {
    for (var k in _tex) { if (_tex[k] && _tex[k].dispose) _tex[k].dispose(); }
    _tex = {}; _texMeta = {}; _skinFieldCache = null; _internalCaustic = null; _vizTime = 0;
    _registry.length = 0;
    if (renderer) disposeEnvironment(renderer);
  }
  // Debug helper for previews: paints a DataTexture's bytes onto a canvas.
  function debugCanvas(tex) {
    if (typeof document === 'undefined') return null;
    var img = tex.image, cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    var ctx = cv.getContext('2d'), id = ctx.createImageData(img.width, img.height);
    id.data.set(img.data); ctx.putImageData(id, 0, 0);
    return cv;
  }

  /* ═══════════════════════════════ 4. Colour references ═════════════════════ */
  // Linear RGB from RESEARCH §D2 (physicallybased.info skin types). "medium" sits
  // between III and IV (tanned), "deep" between V and VI.
  // sss = strength of the warm wrap/terminator shift; raised in round 1 (0.65/0.55/0.35 → 0.70/0.75/0.55)
  // because under the cyan pool key the medium tone rendered pale olive-grey with no warmth reaching the screen.
  var TONES = {
    light:  { linear: [0.799, 0.485, 0.347], sss: 0.70 },
    medium: { linear: [0.520, 0.320, 0.215], sss: 0.75 },
    deep:   { linear: [0.170, 0.088, 0.046], sss: 0.55 }
  };
  // Vertex-colour multipliers the body builder may bake into a `color`
  // attribute (pass vertexColors:true to makeSkin): RESEARCH §D2 regional tints.
  var SKIN_VERTEX_TINTS = {
    neutral: [1.0, 1.0, 1.0],
    joint:   [1.0, 0.86, 0.84],   // knuckles, elbows, knees, ears, nose, cheeks
    palm:    [1.12, 1.0, 0.95],   // palms / soles
    torso:   [0.97, 0.97, 0.97]
  };
  // toWetMaterial's emissive 0x7fc4e8 is used RAW as linear values today; keep
  // the exact same numbers so the nets read identically.
  var CAUSTIC_COLOR = [0x7f / 255, 0xc4 / 255, 0xe8 / 255];

  // Normalise a tone option: a TONES key, a finite sRGB hex number, or a THREE.Color
  // (taken as already linear). Anything else (NaN, unknown string, null) → 'medium'.
  function normTone(tone) {
    if (typeof tone === 'string' && TONES.hasOwnProperty(tone)) return tone;
    if (typeof tone === 'number' && isFinite(tone)) return tone;
    if (tone && tone.isColor) return tone;
    return 'medium';
  }
  function toneColor(tone) {
    var THREE = T(), c = new THREE.Color();
    tone = normTone(tone);
    if (typeof tone === 'number') { c.setHex(tone); c.convertSRGBToLinear(); return c; }
    if (tone.isColor) return c.copy(tone);
    var t = TONES[tone];
    c.setRGB(t.linear[0], t.linear[1], t.linear[2]);
    return c;
  }
  function toneSss(tone) { tone = normTone(tone); return (typeof tone === 'string') ? TONES[tone].sss : 0.5; }
  // sRGB hex (number or CSS string) → linear Color; a THREE.Color is taken as already linear.
  // Non-finite numbers fall back to `dflt`.
  function hexToLinear(hex, dflt) {
    var THREE = T(), c = new THREE.Color();
    if (hex && hex.isColor) return c.copy(hex);
    if (typeof hex === 'number') { if (!isFinite(hex)) hex = (dflt !== undefined ? dflt : 0x0f2a44); c.setHex(hex); c.convertSRGBToLinear(); return c; }
    if (typeof hex === 'string') { c.set(hex); c.convertSRGBToLinear(); return c; }
    c.setHex(dflt !== undefined ? dflt : 0x0f2a44); c.convertSRGBToLinear(); return c;
  }

  /* ═══════════════════════════════ 5. Shader patch (caustics + SSS) ═════════ */
  var _registry = [];     // every material that carries the caustic patch
  var _internalCaustic = null;

  var VERT_PARS = '\n// TL caustics\nvarying vec3 vTLWorldPos;\n';
  var VERT_MAIN = '#include <worldpos_vertex>\n\tvTLWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;\n';
  var FRAG_PARS = [
    '// TL caustics / wrap-SSS',
    'varying vec3 vTLWorldPos;',
    'uniform sampler2D uCausticMap;',
    'uniform vec2 uCausticOffset;',
    'uniform float uCausticRepeat;',
    'uniform vec3 uCausticColor;',
    'uniform float uCausticIntensity;',
    'uniform float uCausticGain;',
    'uniform float uWrap;',
    'uniform vec3 uSssTint;',
    'uniform float uSssAmount;',
    'float tlCaustic = 0.0;',
    '// two scales of the same seamless net (site texture), counter-drifting, softened:',
    '// one scrolling tile reads as a painted pattern in a still frame, two do not.',
    'float tlSampleCaustic( vec2 p ) {',
    '\tfloat a = texture2D( uCausticMap, p * uCausticRepeat + uCausticOffset ).r;',
    '\tfloat b = texture2D( uCausticMap, p * uCausticRepeat * 1.9 + vec2( 0.37, 0.61 ) - uCausticOffset * 0.6 ).r;',
    '\t// keep the gaps between the nets dark (crisp light lines, not grey marbling)',
    '\tfloat c = a * 0.7 + b * 0.3;',
    '\treturn c * c * ( 1.6 - 0.6 * c );',
    '}',
    'float tlCausticTriplanar( vec3 p, vec3 n ) {',
    '\tvec3 w = n * n; w = w * w; w /= ( w.x + w.y + w.z + 1e-5 );',
    '\tfloat c = tlSampleCaustic( p.zy ) * w.x + tlSampleCaustic( p.xz ) * w.y + tlSampleCaustic( p.xy ) * w.z;',
    '\t// the light nets are refracted sunlight from the surface ABOVE: full on upward faces,',
    '\t// fading across the sides, none on the underside (which only sees floor bounce)',
    '\tfloat top = smoothstep( -0.35, 0.65, n.y );',
    '\treturn c * top;',
    '}',
    ''
  ].join('\n');
  var FRAG_NORMAL = '#include <normal_fragment_begin>\n\t{ vec3 tlWN = inverseTransformDirection( geometryNormal, viewMatrix ); tlCaustic = tlCausticTriplanar( vTLWorldPos, tlWN ); }\n';
  var FRAG_EMISSIVE = '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += uCausticColor * ( uCausticIntensity * tlCaustic );\n';
  // Round-4 review ("lips invisible underwater; pores everywhere incl. palms"): skin REGIONS from the bind-space position / normal
  // (`position` / `normal` in the vertex shader are body.js's rest mesh in the body frame: head bone at (0, 0.62, 0.005), the lips
  // at body y 0.596-0.620 / |x| ≤ 0.021 / z ≥ 0.072; the A-pose hands at |x| ≥ 0.27, y ≤ −0.05, palm normal −z). The lips get a
  // darker, redder albedo and −0.1 roughness; the pore normal map is faded off the lips and the palms.
  var REGION_VERT_PARS = '\n// TL skin regions\nvarying vec3 vTlBindP;\nvarying vec3 vTlBindN;\n';
  var REGION_VERT_MAIN = '#include <begin_vertex>\n\tvTlBindP = position.xyz;\n\tvTlBindN = normal.xyz;\n';
  var REGION_FRAG_PARS = '\n// TL skin regions\nvarying vec3 vTlBindP;\nvarying vec3 vTlBindN;\nfloat tlLipMask = 0.0;\nfloat tlPoreMask = 1.0;\n';
  var REGION_FRAG_COLOR = '#include <color_fragment>\n\t{\n' +
    '\t\tvec3 bp = vTlBindP;\n' +
    '\t\tfloat ly = smoothstep( 0.594, 0.599, bp.y ) * ( 1.0 - smoothstep( 0.6175, 0.6225, bp.y ) );\n' +
    '\t\tfloat lx = 1.0 - smoothstep( 0.017, 0.0225, abs( bp.x ) );\n' +
    '\t\tfloat lz = smoothstep( 0.070, 0.076, bp.z );\n' +
    '\t\ttlLipMask = ly * lx * lz;\n' +
    '\t\tfloat palm = smoothstep( 0.26, 0.30, abs( bp.x ) ) * ( 1.0 - smoothstep( -0.06, -0.02, bp.y ) ) * smoothstep( 0.2, 0.6, -vTlBindN.z );\n' +
    '\t\ttlPoreMask = ( 1.0 - 0.85 * palm ) * ( 1.0 - 0.9 * tlLipMask );\n' +
    '\t\tdiffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 0.94, 0.70, 0.68 ), tlLipMask );\n' +
    '\t}\n';
  function regionChunk(name, from, to) { var THREE = T(), src = THREE.ShaderChunk[name] || ''; return src.indexOf(from) >= 0 ? src.replace(from, to) : null; }

  // Anchors inside r128's lights_physical_pars_fragment (tabs are significant).
  var A_DOTNL = '\tfloat dotNL = saturate( dot( geometry.normal, directLight.direction ) );\n\tvec3 irradiance = dotNL * directLight.color;\n\t#ifndef PHYSICALLY_CORRECT_LIGHTS\n\t\tirradiance *= PI;\n\t#endif\n';
  var A_DIFFUSE = '\treflectedLight.directDiffuse += ( 1.0 - clearcoatDHR ) * irradiance * BRDF_Diffuse_Lambert( material.diffuseColor );\n';

  function patchedLightsChunk(sss) {
    var THREE = T(), src = THREE.ShaderChunk.lights_physical_pars_fragment;
    if (src.indexOf(A_DOTNL) < 0 || src.indexOf(A_DIFFUSE) < 0) {
      // Not r128 — leave the lighting untouched (caustics still work).
      return null;
    }
    var dotnl = '\tfloat dotNLraw = dot( geometry.normal, directLight.direction );\n' +
      '\tfloat dotNL = saturate( dotNLraw );\n' +
      '\tvec3 irradiance = dotNL * directLight.color;\n' +
      '\tirradiance *= 1.0 + uCausticGain * tlCaustic;\n' +
      (sss
        ? '\tfloat tlWrapNL = saturate( ( dotNLraw + uWrap ) / ( 1.0 + uWrap ) ) / ( 1.0 + 0.5 * uWrap );\n' +
          '\tvec3 tlDiffIrr = tlWrapNL * directLight.color * ( 1.0 + uCausticGain * tlCaustic );\n' +
          // Penner-style pre-integrated look: the diffuse reddens as N·L falls (broad) and most at the terminator (sharp)
          '\tfloat tlTerm = 0.55 * ( 1.0 - dotNL ) + 0.45 * ( 1.0 - abs( dotNLraw ) ) * ( 1.0 - abs( dotNLraw ) );\n' +
          '\tvec3 tlSss = mix( vec3( 1.0 ), uSssTint, uSssAmount * tlTerm );\n'
        : '\tvec3 tlDiffIrr = irradiance;\n\tvec3 tlSss = vec3( 1.0 );\n') +
      // tlDiffIrr is a COPY taken before the PI step, so it must get the same PI in BOTH branches
      // (a missing PI here made the suit/cap diffuse 1/π too dark while their specular was not).
      '\t#ifndef PHYSICALLY_CORRECT_LIGHTS\n\t\tirradiance *= PI;\n\t\ttlDiffIrr *= PI;\n\t#endif\n';
    var diffuse = '\treflectedLight.directDiffuse += ( 1.0 - clearcoatDHR ) * tlDiffIrr * BRDF_Diffuse_Lambert( material.diffuseColor ) * tlSss;\n';
    return src.replace(A_DOTNL, dotnl).replace(A_DIFFUSE, diffuse);
  }

  // Attach the caustic projection (and optionally the wrap/SSS diffuse) to a
  // MeshPhysicalMaterial. Uniform objects are created NOW and shared with the
  // compiled shader, so they can be tweaked before or after the first render.
  function isTex(t) { return !!(t && t.isTexture && t.offset); }
  function applyCausticPatch(material, o) {
    var THREE = T();
    var tex = isTex(o.causticsTex) ? o.causticsTex : getInternalCaustic();   // anything that is not a Texture → fallback
    var uniforms = {
      uCausticMap: { value: tex },
      uCausticOffset: { value: tex.offset },             // SAME Vector2 as causticsTex.offset
      uCausticRepeat: { value: num(o.repeat, 1.8) },     // tiles per metre (world space)
      uCausticColor: { value: new THREE.Vector3(CAUSTIC_COLOR[0], CAUSTIC_COLOR[1], CAUSTIC_COLOR[2]) },
      uCausticIntensity: { value: o.intensity !== undefined ? o.intensity : 0.28 },
      uCausticGain: { value: o.gain !== undefined ? o.gain : 0.5 },
      uWrap: { value: o.wrap !== undefined ? o.wrap : 0.3 },
      uSssTint: { value: new THREE.Vector3(1.0, 0.55, 0.45) },
      uSssAmount: { value: o.sssAmount !== undefined ? o.sssAmount : 0.5 }
    };
    var sss = !!o.sss, regions = !!o.skinRegions;
    var key = 'tl-caustic-v1' + (sss ? '-sss' : '') + (regions ? '-regions-v1' : '');
    material.onBeforeCompile = function (shader) {
      for (var k in uniforms) shader.uniforms[k] = uniforms[k];
      var vs = shader.vertexShader, fs = shader.fragmentShader;
      vs = vs.replace('#include <common>', '#include <common>' + VERT_PARS).replace('#include <worldpos_vertex>', VERT_MAIN);
      fs = fs.replace('#include <common>', '#include <common>\n' + FRAG_PARS)
             .replace('#include <normal_fragment_begin>', FRAG_NORMAL)
             .replace('#include <emissivemap_fragment>', FRAG_EMISSIVE);
      var lights = patchedLightsChunk(sss);
      if (lights) fs = fs.replace('#include <lights_physical_pars_fragment>', lights);
      if (regions) {
        vs = vs.replace('#include <common>', '#include <common>' + REGION_VERT_PARS).replace('#include <begin_vertex>', REGION_VERT_MAIN);
        fs = fs.replace('#include <common>', '#include <common>' + REGION_FRAG_PARS).replace('#include <color_fragment>', REGION_FRAG_COLOR);
        // the masks are computed in color_fragment, which r128 runs before the roughness / normal chunks
        var nm = regionChunk('normal_fragment_maps', 'mapN.xy *= normalScale;', 'mapN.xy *= normalScale * tlPoreMask;');
        if (nm) fs = fs.replace('#include <normal_fragment_maps>', nm);
        var cn = regionChunk('clearcoat_normal_fragment_maps', 'clearcoatMapN.xy *= clearcoatNormalScale;', 'clearcoatMapN.xy *= clearcoatNormalScale * tlPoreMask;');
        if (cn) fs = fs.replace('#include <clearcoat_normal_fragment_maps>', cn);
        fs = fs.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n\troughnessFactor = max( roughnessFactor - 0.1 * tlLipMask, 0.05 );\n');
      }
      shader.vertexShader = vs; shader.fragmentShader = fs;
      material.userData.shader = shader;
    };
    material.customProgramCacheKey = function () { return key; };
    material.userData.caustic = {
      offset: tex.offset,           // integrator may copy causticsTex.offset here (it already IS it)
      texture: tex,
      uniforms: uniforms,
      setTexture: function (t) {
        if (!isTex(t)) t = getInternalCaustic();         // null/garbage → back to the fallback, never a broken sampler
        uniforms.uCausticMap.value = t; uniforms.uCausticOffset.value = t.offset;
        material.userData.caustic.offset = t.offset; material.userData.caustic.texture = t;
      }
    };
    _registry.push(material);
    // material.dispose() (rig.dispose → mats.own[i].dispose()) drops it from the rebind registry automatically
    if (typeof material.addEventListener === 'function') material.addEventListener('dispose', function onDispose() { unregister(material); });
    return material;
  }
  function getInternalCaustic() {
    if (!_internalCaustic) _internalCaustic = getTexture('caustic');
    return _internalCaustic;
  }
  // Point every registered material at the site's shared causticsTex (e.g. if
  // the body was built before initViz3D created it).
  function setCausticsTexture(tex) {
    if (!isTex(tex)) tex = getInternalCaustic();        // null → everyone back on the fallback
    for (var i = 0; i < _registry.length; i++) {
      var c = _registry[i].userData && _registry[i].userData.caustic;
      if (c && c.texture !== tex) c.setTexture(tex);
    }
    return tex;
  }
  // Standalone scroll for the internal fallback texture — the exact animate3D
  // formula (index.html 4529-4532). No-op when the site's texture is in use.
  var _vizTime = 0;
  function tick(dt) {
    if (!_internalCaustic) return;
    if (typeof dt !== 'number' || dt !== dt || dt < 0 || dt > 1) dt = 1 / 60;   // NaN / negative / tab-was-hidden spikes
    _vizTime += dt;
    _internalCaustic.offset.x = Math.sin(_vizTime * 0.12) * 0.25 + _vizTime * 0.02;
    _internalCaustic.offset.y = _vizTime * 0.035;
  }
  function unregister(material) { var i = _registry.indexOf(material); if (i >= 0) _registry.splice(i, 1); }

  /* ═══════════════════════════════ 6. Materials ═════════════════════════════ */

  // Wet human skin. MeshPhysicalMaterial: base GGX lobe (roughness ≈ 0.55) for
  // the skin itself + a clearcoat "water film" (0.35 / 0.28, patchy 0.78-1.0) + micro-normal
  // pores + wrap/SSS diffuse + world-space caustics. Round-1 review: the previous
  // 0.6 / 0.15 film gave one broad white sheen (glazed ceramic); the film is now weaker, rougher
  // and broken into sheets, and the pores/lines are stronger so they still read at 0.5 m.
  function makeSkin(opts) {
    var THREE = T(); opts = opts || {};
    var wet = opts.wet !== false;
    var tone = normTone(opts.tone);
    var repeat = posNum(opts.uvRepeat, 10);
    var albedo = getTexture('skinAlbedo', repeat);
    var normal = getTexture('skinNormal', repeat);
    var packed = getTexture('skinPacked', repeat);
    var meanMul = (_texMeta.skinAlbedo && _texMeta.skinAlbedo.meanLinear) || 0.93;
    var base = toneColor(tone);
    var color = base.clone().multiplyScalar((wet ? 0.9 : 1.0) / meanMul);
    var m = new THREE.MeshPhysicalMaterial({
      color: color,
      map: albedo,
      normalMap: normal,
      normalScale: new THREE.Vector2(0.55, 0.55),        // round-4: 0.85 read as sandpaper under water / pebbled hide above it; pores are now two octaves at half depth
      clearcoatNormalMap: normal,                     // the water film follows the pores: breaks up the film highlight
      clearcoatNormalScale: new THREE.Vector2(0.45, 0.45),
      roughnessMap: packed,
      roughness: wet ? 0.55 : 0.6,
      metalness: 0.0,
      clearcoat: wet ? 0.35 : 0.08,
      clearcoatRoughness: wet ? 0.28 : 0.4,
      clearcoatMap: packed,
      clearcoatRoughnessMap: packed,
      envMapIntensity: num(opts.envMapIntensity, 0.4),   // round-2: 0.55 → 0.4 — the single broad IBL sheen flattened the underside (SPEC §8.3 said 0.5-0.7; still above the 0.25 taming level)
      emissive: new THREE.Color(0x000000),
      vertexColors: !!opts.vertexColors,
      skinning: opts.skinning !== false,
      dithering: true
    });
    m.ior = 1.4;                                   // F0 ≈ 0.028 (RESEARCH §D3)
    if (isTex(opts.envMap)) m.envMap = opts.envMap;
    m.name = 'TL_skin_' + (typeof tone === 'string' ? tone : 'custom');
    m.userData.tlHuman = 'skin';
    m.userData.tone = tone;
    m.userData.baseColor = base;
    m.userData.wet = wet;
    applyCausticPatch(m, {
      causticsTex: opts.causticsTex, intensity: wet ? 0.2 : 0.1, gain: 0.25,
      repeat: opts.causticRepeat, sss: opts.sss !== false, wrap: 0.35, sssAmount: toneSss(tone),
      skinRegions: opts.regions !== false          // round-4: lips tint + pore masks from the bind-space position (body.js's rest pose)
    });
    return m;
  }
  // Re-tone an existing skin material without rebuilding textures/shader.
  function setSkinTone(material, tone) {
    if (!material || !material.color) return material;
    tone = normTone(tone);
    var meanMul = (_texMeta.skinAlbedo && _texMeta.skinAlbedo.meanLinear) || 0.93;
    var base = toneColor(tone);
    material.color.copy(base).multiplyScalar((material.userData.wet ? 0.9 : 1.0) / meanMul);
    material.userData.tone = tone; material.userData.baseColor = base;
    var c = material.userData.caustic; if (c) c.uniforms.uSssAmount.value = toneSss(tone);
    return material;
  }

  // Technical lycra/elastane suit: matte cloth (r128 sheen = Charlie lobe),
  // fine diagonal weave, a faint wet clearcoat, darkened because it is soaked.
  function suitColorLinear(hex) { return hexToLinear(hex).multiplyScalar(0.72); }
  // Round-3: suit DETAIL in the shader, drawn from the bind-pose (body-space) position — `position` in the vertex shader is the
  // rest mesh, so seams stay glued to the cloth under skinning. Male jammer: outseams down the lateral midline, a centre-back
  // seam on the seat, a dashed hem stitch 12 mm above each leg opening, a white drawcord + knot at the front of the waistband,
  // a white hip logo panel with two dark chevrons. Female kneeskin: outseams, centre-back seam under the open back, front
  // princess (compression-panel) lines from the underbust to the knee, a knee panel line, the hip logo. Each seam is a 2.5 mm
  // darker groove with a 1 mm lighter thread beside it and +0.15 roughness in the groove (thread stitching catches the light).
  var SUIT_VERT_PARS = '\n// TL suit detail\nvarying vec3 vTlBind;\n';
  var SUIT_VERT_MAIN = '#include <begin_vertex>\n\tvTlBind = position.xyz;\n';
  var SUIT_FRAG_PARS = [
    '// TL suit detail (bind-space seams, stitching, drawcord, logo)',
    'varying vec3 vTlBind;',
    'uniform float uTlSuitFemale;',
    'float tlSuitGroove = 0.0;',
    'float tlLine( float d, float w ) { return 1.0 - smoothstep( w * 0.55, w, abs( d ) ); }',
    'float tlBox( float v, float a, float b, float f ) { return smoothstep( a - f, a + f, v ) * ( 1.0 - smoothstep( b - f, b + f, v ) ); }',
    'void tlSuitDetail( vec3 p, inout vec3 col ) {',
    '\tfloat ax = abs( p.x ); float female = uTlSuitFemale;',
    '\tfloat legs = tlBox( p.y, -0.46, -0.12, 0.004 );',
    '\tfloat suitY = tlBox( p.y, -0.46, mix( 0.09, 0.42, female ), 0.004 );',
    '\t// outseam: the lateral midline (z = 0) of each hip/leg, lateral of x 0.11',
    '\tfloat outseam = tlLine( p.z, 0.0025 ) * step( 0.11, ax ) * suitY;',
    '\tfloat outthread = tlLine( p.z - 0.0028, 0.0011 ) * step( 0.11, ax ) * suitY;',
    '\t// centre-back seam on the seat (male) / below the open back (female)',
    '\tfloat back = tlLine( p.x, 0.0025 ) * step( p.z, -0.03 ) * tlBox( p.y, -0.14, mix( 0.09, 0.27, female ), 0.004 );',
    '\tfloat backthread = tlLine( p.x - 0.0028, 0.0011 ) * step( p.z, -0.03 ) * tlBox( p.y, -0.14, mix( 0.09, 0.27, female ), 0.004 );',
    '\t// hem stitch: dashed, 12 mm above the leg opening',
    '\tfloat az = atan( p.z, ax - 0.115 );',
    '\tfloat dash = step( 0.45, fract( az * 2.2 ) );',
    '\tfloat hem = tlLine( p.y + 0.428, 0.0016 ) * dash * step( 0.06, ax );',
    '\t// female: front princess lines from the underbust to the knee, a knee-panel line, a horizontal underbust seam',
    '\tfloat px = 0.030 + 0.085 * smoothstep( -0.44, 0.10, p.y );',
    '\tfloat princess = tlLine( ax - px, 0.0025 ) * step( 0.02, p.z ) * tlBox( p.y, -0.44, 0.34, 0.004 ) * female;',
    '\tfloat princessThread = tlLine( ax - px - 0.0028, 0.0011 ) * step( 0.02, p.z ) * tlBox( p.y, -0.44, 0.34, 0.004 ) * female;',
    '\tfloat kneeLine = tlLine( p.y + 0.30, 0.0025 ) * step( 0.0, p.z ) * step( 0.06, ax ) * female;',
    '\tfloat bust = tlLine( p.y - 0.235, 0.0025 ) * step( 0.0, p.z ) * female;',
    '\tfloat groove = max( max( outseam, back ), max( princess, max( kneeLine, bust ) ) );',
    '\tfloat thread = max( max( outthread, backthread ), max( princessThread, hem ) );',
    '\tcol *= 1.0 - 0.42 * groove;',
    '\tcol *= 1.0 + 0.45 * thread;',
    '\ttlSuitGroove = groove;',
    '\t// male drawcord: two white cords hanging from a knot at the front of the waistband',
    '\tfloat front = step( 0.05, p.z );',
    '\tfloat cordY = tlBox( p.y, 0.010, 0.056, 0.002 );',
    '\tfloat cords = max( tlLine( p.x - 0.011, 0.0022 ), tlLine( p.x + 0.011, 0.0022 ) ) * cordY * front * ( 1.0 - female );',
    '\tfloat knot = ( 1.0 - smoothstep( 0.005, 0.0075, length( vec2( p.x, ( p.y - 0.059 ) * 1.4 ) ) ) ) * front * ( 1.0 - female );',
    '\tfloat cordM = max( cords, knot );',
    '\tcol = mix( col, vec3( 0.75, 0.75, 0.72 ), cordM );',
    '\t// hip logo panel (left front hip): white with two dark chevrons',
    '\tfloat logo = tlBox( p.x, 0.098, 0.146, 0.0012 ) * tlBox( p.y, mix( -0.004, 0.06, female ), mix( 0.027, 0.091, female ), 0.0012 ) * step( 0.02, p.z );',
    '\tfloat ly = p.y - mix( -0.004, 0.06, female );',
    '\tfloat chev = step( abs( fract( ( p.x - 0.098 - abs( ly - 0.0155 ) ) * 55.0 ) - 0.5 ), 0.16 ) * tlBox( ly, 0.004, 0.027, 0.0008 );',
    '\tcol = mix( col, mix( vec3( 0.80, 0.80, 0.78 ), vec3( 0.02, 0.02, 0.025 ), chev ), logo );',
    '}',
    ''
  ].join('\n');
  var SUIT_FRAG_COLOR = '#include <color_fragment>\n\ttlSuitDetail( vTlBind, diffuseColor.rgb );\n';
  var SUIT_FRAG_ROUGH = '#include <roughnessmap_fragment>\n\troughnessFactor = clamp( roughnessFactor + 0.15 * tlSuitGroove, 0.0, 1.0 );\n';
  function applySuitDetail(material, female) {
    var THREE = T();
    var prev = material.onBeforeCompile, prevKey = material.customProgramCacheKey;
    var uni = { uTlSuitFemale: { value: female ? 1 : 0 } };
    material.onBeforeCompile = function (shader, renderer) {
      if (prev) prev.call(material, shader, renderer);
      shader.uniforms.uTlSuitFemale = uni.uTlSuitFemale;
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>' + SUIT_VERT_PARS).replace('#include <begin_vertex>', SUIT_VERT_MAIN);
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\n' + SUIT_FRAG_PARS).replace('#include <color_fragment>', SUIT_FRAG_COLOR).replace('#include <roughnessmap_fragment>', SUIT_FRAG_ROUGH);
    };
    material.customProgramCacheKey = function () { return (prevKey ? prevKey.call(material) : material.type) + '|tl-suit-detail-v1'; };
    material.userData.suitDetail = uni;
    return material;
  }
  function makeSuit(opts) {
    var THREE = T(); opts = opts || {};
    var hex = opts.color !== undefined && opts.color !== null ? opts.color : 0x0f2a44;
    var repeat = posNum(opts.uvRepeat, 40);
    var col = suitColorLinear(hex);
    var m = new THREE.MeshPhysicalMaterial({
      color: col,
      roughness: 0.7,
      metalness: 0.0,
      normalMap: getTexture('weaveNormal', repeat),
      normalScale: new THREE.Vector2(0.5, 0.5),
      clearcoat: 0.06,
      clearcoatRoughness: 0.4,
      envMapIntensity: 0.2,
      emissive: new THREE.Color(0x000000),
      skinning: opts.skinning !== false,
      dithering: true
    });
    if (opts.sheen !== false && ('sheen' in m)) m.sheen = new THREE.Color().copy(col).multiplyScalar(0.35).addScalar(0.08);
    m.name = 'TL_suit';
    m.userData.tlHuman = 'suit';
    m.userData.colorHex = hex;
    applyCausticPatch(m, { causticsTex: opts.causticsTex, intensity: 0.11, gain: 0.3, repeat: opts.causticRepeat, sss: false });
    if (opts.detail !== false) applySuitDetail(m, opts.sex === 'female' || opts.female === true);
    return m;
  }
  // Recolour a suit (used per stroke: STROKES[key].color) — no rebuild.
  function setSuitColor(material, hex) {
    if (!material || !material.color) return material;
    if (typeof hex === 'number' && !isFinite(hex)) return material;   // NaN: keep the current colour
    var col = suitColorLinear(hex);
    material.color.copy(col);
    if (material.sheen) material.sheen.copy(col).multiplyScalar(0.35).addScalar(0.08);
    material.userData.colorHex = hex;
    return material;
  }

  // Silicone cap: SATIN, not glass. Round-1 review: roughness 0.32 / clearcoat 1.0 / clearcoatRoughness 0.06 /
  // envMapIntensity 0.8 rendered as a glass balloon and made the head a bobblehead. A wet stretched silicone cap has a
  // soft broad highlight (0.48 / 0.25 / 0.30 / 0.4) with meridional stretch wrinkles and a moulded crown seam
  // (capNormal at uvRepeat 2 → the seam lands on the front/back meridian). Default colour white (0xf2f2ee): a plain
  // white/black cap reads far more real than a cap dyed the suit colour; the integrator may still pass any colour.
  var CAP_DEFAULT = 0xf2f2ee;
  function makeCap(opts) {
    var THREE = T(); opts = opts || {};
    var hex = opts.color !== undefined && opts.color !== null ? opts.color : CAP_DEFAULT;
    var m = new THREE.MeshPhysicalMaterial({
      color: hexToLinear(hex, CAP_DEFAULT),
      roughness: 0.48,
      metalness: 0.0,
      normalMap: getTexture('capNormal', posNum(opts.uvRepeat, 2)),
      normalScale: new THREE.Vector2(0.55, 0.55),
      clearcoat: 0.25,
      clearcoatRoughness: 0.30,
      envMapIntensity: 0.4,
      emissive: new THREE.Color(0x000000),
      skinning: opts.skinning !== false,
      dithering: true
    });
    m.ior = 1.41;                                  // PDMS silicone
    m.name = 'TL_cap';
    m.userData.tlHuman = 'cap';
    m.userData.colorHex = hex;
    applyCausticPatch(m, { causticsTex: opts.causticsTex, intensity: 0.12, gain: 0.35, repeat: opts.causticRepeat, sss: false });
    return m;
  }
  function setCapColor(material, hex) {
    if (!material || !material.color) return material;
    if (typeof hex === 'number' && !isFinite(hex)) return material;
    material.color.copy(hexToLinear(hex, CAP_DEFAULT)); material.userData.colorHex = hex; return material;
  }

  // Goggles: dark smoke polycarbonate lens (r128 transmission is a stub → used
  // only at 0.15 for a hint of see-through), TPE gasket, silicone strap.
  function makeGoggles(opts) {
    var THREE = T(); opts = opts || {};
    var lens = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(0.012, 0.028, 0.045),
      roughness: 0.05,
      metalness: 0.0,
      clearcoat: 0.5,
      clearcoatRoughness: 0.04,
      envMapIntensity: 0.6,
      transparent: true,
      opacity: 0.78,                                   // round-2: 0.97 → 0.78 so the orbit/eye recess shows through the smoke lens
      skinning: !!opts.skinning
    });
    // polycarbonate (n 1.585) seen UNDER WATER (n 1.33): relative ior ≈ 1.19 → F0 ≈ 0.008,
    // far less mirror-like than in air; the clearcoat adds the tight surface glint.
    lens.ior = 1.2;
    if ('transmission' in lens) lens.transmission = 0.1;
    lens.name = 'TL_goggle_lens'; lens.userData.tlHuman = 'goggles';
    var frame = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.012, 0.012, 0.014), roughness: 0.5, metalness: 0.0, envMapIntensity: 0.6, skinning: !!opts.skinning });
    frame.name = 'TL_goggle_frame'; frame.userData.tlHuman = 'goggles';
    var strap = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.02, 0.024, 0.03), roughness: 0.38, metalness: 0.0, envMapIntensity: 0.8, skinning: !!opts.skinning });
    strap.name = 'TL_goggle_strap'; strap.userData.tlHuman = 'goggles';
    return { lens: lens, frame: frame, strap: strap };
  }

  /* ═══════════════════════════════ 7. Environment (PMREM) ═══════════════════ */
  // A procedural underwater "room": Snell's-window sky overhead (bright, with a
  // sun disc and rippled highlight blobs), a teal total-internal-reflection ring,
  // fog-coloured walls, a dark floor. Rendered once through PMREMGenerator.
  var _envCache = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;
  function buildEnvScene(THREE, opts) {
    var s = new THREE.Scene();
    // The site feeds its hexes to THREE.Color RAW (no sRGB→linear) for fog, background and the
    // floor, so the IBL must use the same raw values to match what is actually on screen.
    var fog = new THREE.Color(opts.fogColor !== undefined ? opts.fogColor : 0x0a4a6e);
    var floorC = new THREE.Color(opts.floorColor !== undefined ? opts.floorColor : 0x155276);
    var zen = new THREE.Color(2.05, 2.12, 2.22);              // Snell window centre: HDR refracted sky/sun — near-white, faintly cool
    var win = new THREE.Color(0.5, 0.82, 0.95);               // window edge (low sky through the surface)
    var tir = new THREE.Color(0.12, 0.42, 0.56);              // TIR ring = the water body / lit floor mirrored in the underside of the surface
    var hor = fog.clone();                                    // = the rendered fog/background
    var flr = floorC.clone().multiplyScalar(2.1).add(new THREE.Color(0.03, 0.04, 0.04));   // the caustic-lit floor as it renders (round-2: +0.3 EV so the underside is lit, not glazed grey)
    var nad = floorC.clone().multiplyScalar(0.3);             // straight down = the swimmer's own shadow on the floor
    var geo = new THREE.SphereGeometry(20, 64, 40);
    var pos = geo.attributes.position, cols = new Float32Array(pos.count * 3), c = new THREE.Color();
    for (var i = 0; i < pos.count; i++) {
      var ny = pos.getY(i) / 20;                               // -1 nadir … +1 zenith
      var ang = Math.acos(Math.max(-1, Math.min(1, ny))) * 180 / Math.PI;   // 0 at zenith
      if (ang < 42) c.copy(zen).lerp(win, smoothstep(0, 42, ang));
      else if (ang < 56) c.copy(win).lerp(tir, smoothstep(42, 56, ang));
      else if (ang < 92) c.copy(tir).lerp(hor, smoothstep(56, 92, ang));
      else if (ang < 118) c.copy(hor).lerp(flr, smoothstep(92, 118, ang));   // fog → the lit floor coming into view
      else if (ang < 145) c.copy(flr);                                        // bright caustic-lit floor around the swimmer
      else c.copy(flr).lerp(nad, smoothstep(145, 178, ang));                  // the swimmer's own shadow directly below
      cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    s.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
    // sun through the surface, aligned with the key light (1.2, 6, 1.5)
    var sunDir = new THREE.Vector3(1.2, 6, 1.5).normalize();
    var sun = new THREE.Mesh(new THREE.SphereGeometry(0.9, 16, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(9, 8.6, 7.6) }));
    sun.position.copy(sunDir).multiplyScalar(17); s.add(sun);
    var halo = new THREE.Mesh(new THREE.SphereGeometry(3.0, 16, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.9, 2.1, 2.2) }));
    halo.position.copy(sunDir).multiplyScalar(18.5); s.add(halo);
    // rippled surface highlights: soft elongated blobs inside the window
    var rng = mulberry32(SEED + 101), blobGeo = new THREE.SphereGeometry(1, 12, 8), blobMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.95, 2.1) });
    for (var b = 0; b < 12; b++) {
      var a = rng() * Math.PI * 2, r = 4 + rng() * 9, y = 14 + rng() * 3;
      var blob = new THREE.Mesh(blobGeo, blobMat);
      blob.position.set(Math.cos(a) * r, y, Math.sin(a) * r);
      blob.scale.set(1.2 + rng() * 2.2, 0.35 + rng() * 0.3, 0.6 + rng() * 0.8);
      blob.rotation.y = rng() * Math.PI;
      s.add(blob);
    }
    // dark lane stripe on the floor and two lane-rope lines at the surface give
    // the reflections some structure
    var stripe = new THREE.Mesh(new THREE.PlaneGeometry(40, 1.2), new THREE.MeshBasicMaterial({ color: nad.clone().multiplyScalar(0.35) }));
    stripe.rotation.x = -Math.PI / 2; stripe.position.y = -17; s.add(stripe);
    var ropeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.9, 0.35, 0.3) });
    for (var z = -1; z <= 1; z += 2) {
      var rope = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 40, 6), ropeMat);
      rope.rotation.z = Math.PI / 2; rope.position.set(0, 12.5, z * 8); s.add(rope);
    }
    return s;
  }
  function disposeScene(s) {
    s.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
      if (o.material) { if (Array.isArray(o.material)) o.material.forEach(function (m) { m.dispose(); }); else o.material.dispose(); }
    });
  }
  // With an IBL present the hemisphere would double-count the ambient → soften it.
  // Shared by makeEnvironment and enhanceLighting so their call order does not matter.
  function capHemisphere(scene) {
    var st = scene && scene.userData && scene.userData.tlLighting, hemi = st && st.hemi;
    if (!hemi) return;
    hemi.intensity = scene.environment ? Math.min(hemi.intensity, 0.3) : Math.max(hemi.intensity, 0.5);
  }
  function disposeEnvironment(renderer) {
    if (!_envCache || !renderer) return;
    var old = _envCache.get(renderer);
    if (old) { if (old.dispose) old.dispose(); _envCache.delete(renderer); }
  }
  function makeEnvironment(renderer, scene, opts) {
    var THREE = T(); opts = opts || {};
    if (!renderer || !renderer.capabilities) return null;
    if (_envCache && !opts.force && _envCache.get(renderer)) {
      var cached = _envCache.get(renderer);
      if (scene) { scene.environment = cached; scene.userData.tlEnvMap = cached; capHemisphere(scene); }
      return cached;
    }
    try { _maxAniso = renderer.capabilities.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 1; } catch (e) { _maxAniso = 1; }
    if (typeof _maxAniso !== 'number' || !isFinite(_maxAniso)) _maxAniso = 1;
    applyAnisotropy();
    var tex = null, envScene = null, pmrem = null;
    try {
      if (typeof THREE.PMREMGenerator !== 'function') throw new Error('THREE.PMREMGenerator missing');
      pmrem = new THREE.PMREMGenerator(renderer);
      envScene = buildEnvScene(THREE, opts);
      tex = pmrem.fromScene(envScene, num(opts.sigma, 0.035)).texture;
      tex.name = 'TL_poolEnv';
    } catch (err) {
      if (GLOBAL.console) console.warn('TL_HumanMaterials.makeEnvironment failed:', err);
      tex = null;
    } finally {
      if (pmrem) pmrem.dispose();
      if (envScene) disposeScene(envScene);
    }
    if (!tex) return null;
    if (opts.force) disposeEnvironment(renderer);          // free the previous PMREM instead of leaking it
    if (_envCache) _envCache.set(renderer, tex);
    if (scene) { scene.environment = tex; scene.userData.tlEnvMap = tex; capHemisphere(scene); }
    return tex;
  }

  /* ═══════════════════════════════ 8. Lighting ══════════════════════════════ */
  // Keeps the pool feel (one overhead key through the surface, floor bounce,
  // hemisphere) and improves: 2048² key shadow with a soft penumbra (VSM when
  // available), acne bias, tight ortho frustum, ONE cool rim light from the
  // surface direction, IBL tamed on non-human materials. Idempotent.
  function findLights(scene) {
    var out = [];
    scene.traverse(function (o) { if (o.isLight) out.push(o); });
    return out;
  }
  function tameEnvironment(scene, intensity) {
    var k = intensity !== undefined ? intensity : 0.25, n = 0;
    scene.traverse(function (o) {
      if (!o.isMesh || !o.material) return;
      var mats = Array.isArray(o.material) ? o.material : [o.material];
      for (var i = 0; i < mats.length; i++) {
        var m = mats[i];
        if (!m || m.envMapIntensity === undefined || (m.userData && m.userData.tlHuman) || (m.userData && m.userData.tlEnvTamed)) continue;
        m.envMapIntensity = k; m.userData.tlEnvTamed = true; n++;
      }
    });
    return n;
  }
  function enhanceLighting(scene, renderer, opts) {
    var THREE = T(); opts = opts || {};
    if (!scene || typeof scene.traverse !== 'function' || !scene.userData) return null;
    var state = scene.userData.tlLighting;
    if (state && !opts.force) { tameEnvironment(scene); capHemisphere(scene); return state; }
    var caps = (renderer && renderer.capabilities) || {};
    var maxTex = posNum(caps.maxTextureSize, 2048);
    var isMobile = (typeof navigator !== 'undefined') && /Mobi|Android/i.test(navigator.userAgent || '');
    var size = Math.min(posNum(opts.shadowSize, isMobile ? 1024 : 2048), maxTex >= 4096 ? 2048 : 1024);
    if (!isPow2(size)) size = 1024;
    var lights = findLights(scene), key = null, rim = null, hemi = null, bounce = null, warm = null;
    for (var i = 0; i < lights.length; i++) {
      var L = lights[i];
      if (L.userData && L.userData.tlRim) rim = L;
      else if (L.userData && L.userData.tlWarmFill) warm = L;
      else if (L.isDirectionalLight && L.castShadow && !key) key = L;
      else if (L.isHemisphereLight) hemi = L;
      else if (L.isDirectionalLight && L.position.y < 0) bounce = L;
    }
    if (!key) { for (i = 0; i < lights.length; i++) if (lights[i].isDirectionalLight && lights[i].position.y > 0 && lights[i] !== rim) { key = lights[i]; break; } }
    var shadowType = 'unchanged';
    if (key) {
      key.castShadow = true;
      var sh = key.shadow;
      if (sh.mapSize.x !== size) {
        if (sh.map) { sh.map.dispose(); sh.map = null; }
        if (sh.mapPass) { sh.mapPass.dispose(); sh.mapPass = null; }
        sh.mapSize.set(size, size);
      }
      sh.bias = -0.0005;
      if ('normalBias' in sh) sh.normalBias = 0.02;
      sh.radius = posNum(opts.shadowRadius, 4);
      var cam = sh.camera;
      if (cam && cam.isOrthographicCamera) {
        cam.left = -3.2; cam.right = 3.2; cam.top = 3.2; cam.bottom = -3.2; cam.near = 0.5; cam.far = 20;
        cam.updateProjectionMatrix();
      }
      if (renderer && renderer.shadowMap) {
        var want = opts.shadowType || 'vsm';
        if (want === 'vsm' && THREE.VSMShadowMap !== undefined && !isMobile) {
          if (renderer.shadowMap.type !== THREE.VSMShadowMap) {
            renderer.shadowMap.type = THREE.VSMShadowMap;
            renderer.shadowMap.needsUpdate = true;
            // shader define changes → recompile everything already built
            scene.traverse(function (o) {
              if (!o.material) return;
              var mats = Array.isArray(o.material) ? o.material : [o.material];
              for (var j = 0; j < mats.length; j++) if (mats[j]) mats[j].needsUpdate = true;
            });
          }
          shadowType = 'vsm';
        } else {
          shadowType = 'pcfsoft';
          // PCFSoft ignores radius: the 2048 map + normalBias still helps
        }
      }
    }
    if (!rim) {
      rim = new THREE.DirectionalLight(0x9fd8ff, num(opts.rimIntensity, 0.26));
      rim.position.set(-2.6, 1.7, -3.2);          // from the surface, behind the swimmer, opposite the key; low so the floor barely sees it
      rim.userData.tlRim = true; rim.name = 'tl-rim';
      scene.add(rim);
    }
    if (bounce) { bounce.intensity = Math.min(bounce.intensity, 0.3); }
    // WARM fill from below-front (≈ 2800 K, 0.30): the floor bounce and the IBL nadir are both cyan, so without it the
    // underside of the swimmer rendered as flat cyan-grey plastic (round-1 review); real pool floors bounce warmer light.
    if (!warm) {
      warm = new THREE.DirectionalLight(0xffb070, num(opts.warmFillIntensity, 0.30));   // round-2: 0.15 → 0.30 (skin from below was grey-olive)
      warm.position.set(0.9, -2.2, 1.3);
      warm.userData.tlWarmFill = true; warm.name = 'tl-warm-fill';
      scene.add(warm);
    }
    if (renderer && typeof renderer.toneMappingExposure === 'number') {
      var ex = renderer.toneMappingExposure;
      if ((ex < 0.8 || ex > 1.4) && GLOBAL.console) console.warn('TL_HumanMaterials.enhanceLighting: toneMappingExposure ' + ex + ' is outside the tuned range 1.0-1.3 (left untouched)');
    }
    var tamed = tameEnvironment(scene);
    state = { key: key, rim: rim, warm: warm, hemi: hemi, bounce: bounce, shadowSize: size, shadowType: shadowType, tamedMaterials: tamed };
    scene.userData.tlLighting = state;
    capHemisphere(scene);
    return state;
  }

  /* ═══════════════════════════════ 9. Export ════════════════════════════════ */
  GLOBAL.TL_HumanMaterials = {
    VERSION: VERSION,
    makeSkin: makeSkin,
    setSkinTone: setSkinTone,
    makeSuit: makeSuit,
    setSuitColor: setSuitColor,
    makeCap: makeCap,
    setCapColor: setCapColor,
    makeGoggles: makeGoggles,
    makeEnvironment: makeEnvironment,
    disposeEnvironment: disposeEnvironment,
    enhanceLighting: enhanceLighting,
    tameEnvironment: tameEnvironment,
    setCausticsTexture: setCausticsTexture,
    getCausticTexture: getInternalCaustic,
    tick: tick,
    getTexture: getTexture,
    debugCanvas: debugCanvas,
    disposeShared: disposeShared,
    unregister: unregister,
    toneColor: toneColor,
    TONES: TONES,
    SKIN_VERTEX_TINTS: SKIN_VERTEX_TINTS,
    CAUSTIC_COLOR: CAUSTIC_COLOR,
    recommendedExposure: 1.15,
    _internal: {
      mulberry32: mulberry32, makeFbm: makeFbm, makeCells: makeCells, worley: worley,
      skinHeightField: skinHeightField, normalFromHeight: normalFromHeight,
      genSkinNormal: genSkinNormal, genSkinPacked: genSkinPacked, genSkinAlbedo: genSkinAlbedo,
      genWeaveNormal: genWeaveNormal, genPeelNormal: genPeelNormal, genCapNormal: genCapNormal, genCaustic: genCaustic,
      patchedLightsChunk: patchedLightsChunk, anchors: { dotNL: A_DOTNL, diffuse: A_DIFFUSE },
      buildEnvScene: buildEnvScene, registry: _registry, texMeta: _texMeta, SEED: SEED
    }
  };
})();

// Tidelyne — human/motion.js  →  window.TL_HumanMotion
// Motion layer for the procedural human swimmer (SPEC §9.3). Plain script, IIFE, no
// top-level THREE access (Three is lazy-loaded; everything resolves window.THREE at call time).
//
//   applyPose / applyLegPose / applyFlutterKick   drop-in replacements, identical maths (SPEC §2.2-2.4)
//   interpolatePhases / applyPoseSpline / poseFrame  C1 non-uniform Catmull-Rom (Hermite form, shape-limited)
//                                                  over the phase ring on the angle vectors; keyframes exact
//   applySecondary                                 wrist, forearm/wrist twist (palm solver), fingers, ankle/foot,
//                                                  scapula, hip counter-roll, head redistribution + counter-roll
//   resolveClearance                               arm vs torso/neck/head (body.js-fitted ellipsoids) guard via a
//                                                  minimal additive abduction on the RECOVERING shoulder only
//   bodyWave                                       travelling trunk wave + bob + breath lift for strokes that define sd.wave
//                                                  (butterfly + dolphin: sinusoid params; breaststroke: a knot table); every other
//                                                  stroke gets EXACTLY the page's old single-hinge formula
//   STROKE_PATCHES / applyPatches                  coaching corrections to the STROKES table in index.html (clone, never mutate); copies rate / wave / hold; may
//                                                  append keyframes (butterfly: a 7th `Entry` keyframe at u 0.90, technique pass 4)
//
// Body-local axes: +Y head, +X anatomical LEFT, +Z anterior. Prone: +Z = down (water). Supine: +Z = up.
// Nothing here allocates per frame after the first call (scratch is created lazily once).
(function () {
  'use strict';

  var VERSION = '1.11.0';  // technique pass 6 (dolphin re-fix): progressive upkick knee (10.5° / 22° at u 0.65 / 0.83), head-node wave (bob / chest lag 0.04 + neckAmp −3°), 96 kicks/min, depth 0.44
  var DEG = Math.PI / 180;
  var TAU = Math.PI * 2;
  function num(v) { v = +v; return v === v && v !== Infinity && v !== -Infinity ? v : 0; }   // finite number or 0

  // ── THREE resolution + lazily created scratch (never allocate per frame) ──────────
  var _T = null;
  function T() {
    if (_T) return _T;
    _T = (typeof window !== 'undefined' && window.THREE) || (typeof globalThis !== 'undefined' && globalThis.THREE) || null;
    if (!_T) throw new Error('TL_HumanMotion: THREE is not loaded yet');
    return _T;
  }
  var S = null;
  function scratch() {
    if (S) return S;
    var THREE = T();
    S = {
      qA: new THREE.Quaternion(), qB: new THREE.Quaternion(), qC: new THREE.Quaternion(), qD: new THREE.Quaternion(),
      qNeckInv: new THREE.Quaternion(), qHeadInv: new THREE.Quaternion(),
      e: new THREE.Euler(0, 0, 0, 'XYZ'),
      v1: new THREE.Vector3(), v2: new THREE.Vector3(), v3: new THREE.Vector3(), v4: new THREE.Vector3(), v5: new THREE.Vector3(),
      headOff: new THREE.Vector3(),
      m1: new THREE.Matrix4(), m2: new THREE.Matrix4(), m3: new THREE.Matrix4(),
      pts: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
    };
    return S;
  }
  var _seulOrder = 'XYZ';
  function setQuatFromDeg(q, xDeg, yDeg, zDeg) {
    var s = scratch();
    s.e.set(num(xDeg) * DEG, num(yDeg) * DEG, num(zDeg) * DEG, _seulOrder);
    return q.setFromEuler(s.e);
  }
  function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
  function clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function smoothstep(a, b, x) { var t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  // ── Tunables (integrator may override at runtime) ───────────────────────────────
  var config = {
    // interpolation: 'limited' = non-uniform Catmull-Rom tangents, zeroed at local extrema and capped (Fritsch–Carlson)
    // so the spline never overshoots an authored keyframe; 'catmull' = raw Barry–Goldman (may overshoot ±15°).
    spline: 'limited',
    // shoulder path between keyframes: 'quat' = the same limited spline on rotation vectors in the keyframe's log map (the
    // geodesic-based path, round-2 default — Euler-family choices no longer swing the arm out of the water); 'euler' = the
    // component-wise Euler spline (identical to the leg channels; SPEC parity mode used by the tests' Euler-path checks).
    shoulderSpline: 'quat',
    // SPEC §2.2 keeps the authored elbow sign in supine (sx=+1), which bends the human's elbow toward the olecranon
    // (hyperextension, up to 90° in backstroke). true → the elbow always flexes toward the biceps (anatomical) and
    // applyPatches() uses the backstroke keyframes authored for it. Default false = exact SPEC/driver parity.
    anatomicalElbow: false,
    // Flutter kick. false = SPEC §2.4 parity (hip ±0.13 rad, knee 0.10 + 0.30·max(0, sin(φ+0.7)) — the knee bends at the TOP
    // of the up-beat, so on the human the shin lifted 28 cm out of the water, round-1 review). true = applyFlutterKickAnatomical:
    // the thigh oscillates about a flexed mean under the body line and the knee bends only while the thigh drives DOWN
    // (peak a quarter-beat after the hip's top → the shin stays inside the body's shadow, toes reach the surface, ≈ 35 cm range).
    anatomicalKick: false,
    kickHipBias: -0.19,              // rad; negative = flexed: the thigh swings about −11° (below the body line)
    kickHipAmp: 0.19,                // rad; thigh swing ±11° → level at the top (the rolled-up side's heel just breaks the surface) / −22° down
    kickKneeMin: 0.05,               // rad; the up-beat leg is straight
    kickKneeAmp: 0.60,               // rad; peak knee bend ≈ 37° (RESEARCH F1: 30-60° on the down-kick)
    kickKneeLag: 2.28,               // rad; the knee starts bending as the thigh passes neutral going DOWN (φ = lag) and
                                     // peaks at φ = π/2 + lag (thigh ≈ −17°): the shin stays level with the surface,
                                     // then whips down through the bottom of the thigh's swing
    kickKneeLagSupine: 5.31,         // rad; backstroke: the knee bends on the way up and is straight at the top (toes at the surface)
    ankleKickLagAnatomical: -2.26,   // plantarflexion peaks at the bottom of the whip (the foot snaps last)
    ankleKickLagAnatomicalSupine: 0.9, // supine: the foot snaps at the top of the up-beat
    // wrist
    wristFlexMax: 18 * DEG,          // palmar flexion at catch/pull (coaching 15-20°)
    wristFlexBlend: 0.15,            // lateral-component half-width over which the flexion sign ramps −1 … +1 (was a hard flip)
    lpTau: 0.012,                    // cycle fractions; low-pass time constant of the wrist target (≈ 1.3 frames at 60 fps, 1×)
    lpJump: 0.06,                    // |Δu| above this = a phase jump (stroke change / arrow keys): snap instead of filtering
    // forearm / wrist twist split (LBS-safe caps: no twist bones in the base 24-bone rig)
    forearmTwistMax: 45 * DEG,
    wristTwistMax: 30 * DEG,
    // when the rig exposes armX.forearmTwist (body.js ≥ 1.3: a zero-length bone at the elbow whose weights ramp 0 → 1 along the
    // forearm, so pronation distributes over its length like the real radius/ulna) the forearm budget is this instead
    forearmTwistBoneMax: 100 * DEG,
    // the palm solver fades out where the required twist approaches the ±180° ambiguity (a sign flip would spin the hand);
    // round-2: 110–150° stranded every catch palm at ~45° — with the twist bone budget the fade starts much later
    twistFadeStart: 150 * DEG,
    twistFadeEnd: 176 * DEG,
    palmRest: -1,                    // sign of the hand's rest palm normal on local Z (-1 = palm faces posterior; body.js hands)
    // fingers (only if the rig exposes armX.fingers[]: body.js ≥ 1.4). Round-3 review ("starfish in every pull and in the
    // streamline"): the fingers are TOGETHER (the body's rest hand) and spread by ≤ fingerSpread only while the palm solver
    // reports pulling; the thumb stays adducted along the index finger (thumbAbduct extra, only in the pull).
    fingerSpread: 3 * DEG,     // round-4: 4° opened 5 mm tip gaps on the pressed-together hand (body.js 1.5); 3° keeps them ≤ 4 mm in the pull
    thumbAbduct: 3 * DEG,
    // ankle
    ankleRest: 1.15,
    ankleFlutterAmp: 10 * DEG,       // ±10° around rest in the flutter kick
    ankleKickLag: 0.7,               // rad behind the hip phase (= the knee's lag in applyFlutterKick)
    ankleDorsiflex: 0.55,            // rad, breaststroke heel-draw (feet turned out, dorsiflexed)
    footTurnout: 28 * DEG,
    // breaststroke heel-draw / whip (technique pass 2, strokes whose sd.wave.kick === 'breast'): the feet FLEX over breastFlexKnee (deg)
    // during the draw to breastDorsiflex (rad; ankleDorsiflex when undefined), TURN OUT over breastTurnoutKnee (breastFlexKnee when
    // undefined), hold both through the whip until the first phase fraction of breastWhipHold and point again by the second.
    // Technique pass 5 (critic F2): flat by kn 95 (was 0.55 rad by 122 — the still-pointed feet stood 12 cm out of the water with
    // the shin vertical), turned out late (real feet flex before they evert), pointed by localT 0.88 of the one-segment whip.
    breastFlexKnee: [35, 95],
    breastTurnoutKnee: [95, 124],
    breastWhipHold: [0.50, 0.88],
    breastDorsiflex: 0.15,
    footInversionFlutter: 5 * DEG,
    // shoulder girdle
    scapularShift: 0.012,            // m of shoulder-bone elevation on the recovering side (0 disables)
    scapulaRot: 8 * DEG,             // used instead when a `scapula` bone exists
    // roll distribution
    hipRollRatio: 0.65,              // hips roll 65 % of the shoulders (coaching 60-70 %)
    headRollRatio: 0.35,             // head rolls 35 % of the shoulders when not breathing
    headShare: 0.6,                  // breathing turn redistributed head:neck = 0.6:0.4 when a head Bone exists
    // clearance
    clearance: 0.012,                // skin gap added to every test point radius (m)
    pointRadii: [0.036, 0.032, 0.028, 0.012, 0.008],   // elbow, forearm mid, wrist, hand centre, fingertip
    maxAbductionNudge: 25 * DEG,     // cap on the additive abduction (task: ≤ 25°)
    scanSteps: 12,                   // coarse bracket of the smallest clearing angle (~2° steps at the cap; ≤ 63)
    bisectionSteps: 7,               // refinement inside the bracket (→ 0.02°)
    nudgeRamp: 12 * DEG / 0.01,      // rad of abduction per metre of penetration (12° per cm → the cap at ~2 cm)
    softMinTau: 0.004,               // m; soft-min temperature when no angle clears
    fingertipLen: 0.19,              // wrist → fingertip (SPEC §9.1)
    headBoneOffset: [0, 0.10, 0.005] // neck-local head pivot when the rig has no head bone
  };

  // Clearance shapes = the body.js torso/neck/head primitives (male; conservative for female), as ellipsoids.
  // frame: 'body' = hips-local (rest), 'spine' = spine-local (body y − 0.10), 'head' = head-bone-local.
  // c = centre, h = half-axes. (mirror entries are expanded at load)
  var SHAPES = [];
  (function buildShapes() {
    function add(frame, c, h, mirror) {
      SHAPES.push({ frame: frame, c: c, h: h });
      if (mirror) SHAPES.push({ frame: frame, c: [-c[0], c[1], c[2]], h: h });
    }
    add('body', [0, -0.02, 0.0], [0.148, 0.092, 0.098]);                 // pelvis
    add('body', [0.084, -0.06, -0.075], [0.078, 0.078, 0.062], true);   // gluteus
    add('body', [0, 0.13, 0.006], [0.124, 0.16, 0.088]);                 // waist / abdomen
    add('spine', [0, 0.23, -0.004], [0.141, 0.155, 0.101]);              // ribcage (body y 0.33)
    add('spine', [0, 0.34, -0.012], [0.15, 0.055, 0.076]);               // shoulder girdle (body y 0.44)
    add('spine', [0.118, 0.20, -0.035], [0.046, 0.115, 0.07], true);     // latissimus (body y 0.30)
    add('spine', [0.072, 0.265, 0.086], [0.078, 0.052, 0.036], true);    // pectoralis (body y 0.365)
    add('spine', [0, 0.44, 0.008], [0.058, 0.085, 0.056]);               // neck (body y 0.485…0.60)
    add('head', [0, 0.085, -0.012], [0.078, 0.089, 0.094]);              // cranium (+cap)
    add('head', [0, 0.03, 0.045], [0.062, 0.075, 0.055]);                // face / jaw
  })();

  // ═════════════════════════════════════════════════════════════════════════════════
  // 1. Drop-in driver functions (SPEC §2.2-2.4) — identical maths to index.html 4200-4236
  // ═════════════════════════════════════════════════════════════════════════════════
  function elbowSign(supine) { return supine ? (config.anatomicalElbow ? -1 : 1) : -1; }
  // Missing / non-numeric keyframe fields read as 0 (the original engine would throw or emit NaN — the site's
  // validator never lets that happen for AI motions; the guards only matter for hand-built data).
  var ZERO3 = [0, 0, 0], ZERO1 = [0];
  function fld(side, key, zero) { var v = side && side[key]; return v && v.length !== undefined ? v : zero; }
  function applyPose(rig, sideObj, A, B, e, supine) {
    var s = scratch();
    var sx = supine ? 1 : -1, ex = elbowSign(supine);
    var ash = fld(A, 'sh', ZERO3), bsh = fld(B, 'sh', ZERO3), ael = fld(A, 'el', ZERO1), bel = fld(B, 'el', ZERO1);
    e = num(e);
    setQuatFromDeg(s.qA, sx * num(ash[0]), ash[1], ash[2]);
    setQuatFromDeg(s.qB, sx * num(bsh[0]), bsh[1], bsh[2]);
    sideObj.shoulder.quaternion.copy(s.qA).slerp(s.qB, e);
    var elA = num(ael[0]) * DEG, elB = num(bel[0]) * DEG;
    sideObj.elbow.rotation.set(ex * (elA + (elB - elA) * e), 0, 0);
  }
  function applyLegPose(legObj, A, B, e) {
    var s = scratch();
    var ahi = fld(A, 'hi', ZERO3), bhi = fld(B, 'hi', ZERO3), akn = fld(A, 'kn', ZERO1), bkn = fld(B, 'kn', ZERO1);
    e = num(e);
    setQuatFromDeg(s.qA, -num(ahi[0]), ahi[1], ahi[2]);
    setQuatFromDeg(s.qB, -num(bhi[0]), bhi[1], bhi[2]);
    legObj.hipJ.quaternion.copy(s.qA).slerp(s.qB, e);
    var knA = num(akn[0]) * DEG, knB = num(bkn[0]) * DEG;
    legObj.knee.rotation.set(knA + (knB - knA) * e, 0, 0);
  }
  function applyFlutterKick(swimmer, u) {
    var s = scratch();
    var kp = num(u) * Math.PI * 2 * 3; // 6-beat
    for (var i = 0; i < 2; i++) {
      var leg = i === 0 ? swimmer.legL : swimmer.legR, off = i === 0 ? 0 : Math.PI;
      var sn = Math.sin(kp + off);
      s.e.set(sn * 0.13, 0, 0, 'XYZ');
      leg.hipJ.quaternion.setFromEuler(s.e);
      leg.knee.rotation.set(0.10 + Math.max(0, Math.sin(kp + off + 0.7)) * 0.30, 0, 0);
    }
  }
  // Anatomical 6-beat flutter (config.anatomicalKick, see the config comment). Same phase convention as
  // applyFlutterKick (L at φ = 3·2π·u, R half a beat later) so the ankle schedule and the tests line up.
  // Supine (backstroke): the knee can only bend toward the dorsal side (= down), so the world path is not a mirror: the thigh
  // swings about the same line below the body, the knee bends while the thigh comes UP (shin lagging below) and snaps straight
  // at the top so the toes just break the surface — the propulsive up-beat.
  function applyFlutterKickAnatomical(swimmer, u, supine) {
    var s = scratch();
    var kp = num(u) * TAU * 3, sgn = supine ? -1 : 1, lag = supine ? config.kickKneeLagSupine : config.kickKneeLag;
    for (var i = 0; i < 2; i++) {
      var leg = i === 0 ? swimmer.legL : swimmer.legR, ph = kp + (i === 0 ? 0 : Math.PI);
      var hip = sgn * (config.kickHipBias + config.kickHipAmp * Math.sin(ph));
      var w = Math.max(0, Math.sin(ph - lag));
      var kn = config.kickKneeMin + config.kickKneeAmp * w * Math.sqrt(w);   // sharper peak, longer straight-leg up-beat
      s.e.set(hip, 0, 0, 'XYZ');
      leg.hipJ.quaternion.setFromEuler(s.e);
      leg.knee.rotation.set(kn, 0, 0);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════════════
  // 2. C1 interpolation — non-uniform Catmull-Rom over the phase ring (cubic Hermite form)
  // ═════════════════════════════════════════════════════════════════════════════════
  // Angle vector per side: [sh.x, sh.y, sh.z, el, hi.x, hi.y, hi.z, kn]  (authored degrees)
  // Knots are the cumulative phase durations (t0=-d0, t1=0, t2=d1, t3=d1+d2). The Barry–Goldman
  // non-uniform Catmull-Rom is the cubic Hermite with tangent m_k = (Δ_{k-1}·d_k + Δ_k·d_{k-1})/(d_{k-1}+d_k)
  // (secant slopes weighted by the opposite interval — verified numerically against crWeights()). With
  // config.spline==='limited' the tangent is zeroed at local extrema and capped at 3·min|Δ| (Fritsch–Carlson),
  // which keeps C1 and removes the ±15° overshoot the raw form produces after a big swing (backstroke entry).
  // Values at the knots are exactly the authored keyframes either way. Angles are unwrapped along the ring
  // (consecutive differences via wrap180) so the spline takes the short way round like the driver's slerp.
  // hold=true: eased zero-tangent Hermite = the driver's eased lerp (zero velocity at every keyframe → a pause).
  var NV = 8;
  var EMPTY_PHASE = { dur: 0 };
  var _P = [new Float64Array(NV), new Float64Array(NV), new Float64Array(NV), new Float64Array(NV)];
  var _outL = new Float64Array(NV), _outR = new Float64Array(NV);
  var _res = { L: _outL, R: _outR };

  function readSide(side, out) {
    var sh = fld(side, 'sh', ZERO3), el = fld(side, 'el', ZERO1), hi = fld(side, 'hi', ZERO3), kn = fld(side, 'kn', ZERO1);
    out[0] = num(sh[0]); out[1] = num(sh[1]); out[2] = num(sh[2]); out[3] = num(el[0]);
    out[4] = num(hi[0]); out[5] = num(hi[1]); out[6] = num(hi[2]); out[7] = num(kn[0]);
    return out;
  }
  function phaseDur(p) { var d = +p.dur; return d > 1e-6 ? d : 1e-6; }   // NaN / ≤0 / missing → tiny (never divide by 0)
  function wrap180(d) { d = (d + 180) % 360; if (d < 0) d += 360; return d - 180; }
  // Barry–Goldman weights for control points P0..P3 with knots t0<t1<t2<t3, evaluated at t ∈ [t1,t2] (raw CR).
  function crWeights(t, t0, t1, t2, t3, w) {
    var a10 = (t1 - t) / (t1 - t0), a11 = (t - t0) / (t1 - t0);
    var a21 = (t2 - t) / (t2 - t1), a22 = (t - t1) / (t2 - t1);
    var a32 = (t3 - t) / (t3 - t2), a33 = (t - t2) / (t3 - t2);
    var b1a = (t2 - t) / (t2 - t0), b1b = (t - t0) / (t2 - t0);
    var b2a = (t3 - t) / (t3 - t1), b2b = (t - t1) / (t3 - t1);
    var c1 = (t2 - t) / (t2 - t1), c2 = (t - t1) / (t2 - t1);
    w[0] = c1 * b1a * a10;
    w[1] = c1 * (b1a * a11 + b1b * a21) + c2 * b2a * a21;
    w[2] = c1 * b1b * a22 + c2 * (b2a * a22 + b2b * a32);
    w[3] = c2 * b2b * a33;
    return w;
  }
  // Knot tangent from the two neighbouring secant slopes (dA = (p_k − p_{k−1})/d_{k−1}, dB = (p_{k+1} − p_k)/d_k).
  function tangent(dA, dB, da, db, limited) {
    var m = (dA * db + dB * da) / (da + db);
    if (!limited) return m;
    if (dA * dB <= 0) return 0;                       // local extremum (or flat): no overshoot
    var cap = 3 * Math.min(Math.abs(dA), Math.abs(dB));
    return m > cap ? cap : (m < -cap ? -cap : m);
  }
  // Interpolate the authored angle vectors for both sides at (idx, localT) over the ring `phases`.
  function interpolatePhases(phases, idx, localT, hold, outL, outR) {
    var n = (phases && phases.length) | 0;
    outL = outL || _outL; outR = outR || _outR;
    _res.L = outL; _res.R = outR;
    var k;
    if (n <= 0) { for (k = 0; k < NV; k++) { outL[k] = 0; outR[k] = 0; } return _res; }
    var P0 = phases[0] || EMPTY_PHASE;
    if (n === 1) { readSide(P0.L, outL); readSide(P0.R, outR); return _res; }
    idx = Math.floor(num(idx));                                  // NaN / string / ±∞ → 0 / coerced; ring-wrapped below
    var i0 = ((idx - 1) % n + n) % n, i1 = ((idx % n) + n) % n, i2 = (i1 + 1) % n, i3 = (i1 + 2) % n;
    P0 = phases[i0] || EMPTY_PHASE;                              // sparse / null entries read as an empty phase
    var P1 = phases[i1] || EMPTY_PHASE, P2 = phases[i2] || EMPTY_PHASE, P3 = phases[i3] || EMPTY_PHASE;
    var d0 = phaseDur(P0), d1 = phaseDur(P1), d2 = phaseDur(P2);
    var lt = clamp01(num(localT));
    var limited = config.spline !== 'catmull';
    var sN, h00, h10, h01, h11, tp;
    if (hold) { tp = easeInOut(lt); h00 = 1 - tp; h01 = tp; h10 = 0; h11 = 0; }
    else { sN = lt; var s2 = sN * sN, s3 = s2 * sN; h00 = 2 * s3 - 3 * s2 + 1; h10 = s3 - 2 * s2 + sN; h01 = -2 * s3 + 3 * s2; h11 = s3 - s2; }
    for (var side = 0; side < 2; side++) {
      var key = side === 0 ? 'L' : 'R', out = side === 0 ? outL : outR;
      readSide(P0[key], _P[0]); readSide(P1[key], _P[1]); readSide(P2[key], _P[2]); readSide(P3[key], _P[3]);
      for (var c = 0; c < NV; c++) {
        var p1 = _P[1][c];
        var e01 = wrap180(p1 - _P[0][c]), e12 = wrap180(_P[2][c] - p1), e23 = wrap180(_P[3][c] - _P[2][c]);
        if (hold) { out[c] = p1 + e12 * tp; continue; }
        var m1 = tangent(e01 / d0, e12 / d1, d0, d1, limited);
        var m2 = tangent(e12 / d1, e23 / d2, d1, d2, limited);
        out[c] = h00 * p1 + h01 * (p1 + e12) + d1 * (h10 * m1 + h11 * m2);
      }
    }
    return _res;
  }
  // Apply an angle vector to one arm (and optionally one leg) with the driver's sign conventions.
  function applyArmVector(sideObj, v, supine) {
    var sx = supine ? 1 : -1, ex = elbowSign(supine);
    setQuatFromDeg(sideObj.shoulder.quaternion, sx * v[0], v[1], v[2]);
    sideObj.elbow.rotation.set(ex * v[3] * DEG, 0, 0);
  }
  // ── Shoulder spline in ROTATION space (round-2, config.shoulderSpline = 'quat') ──────────────────────────────────────
  // The Euler-component spline above is exact at the keyframes but its PATH between them is whatever the three Euler
  // angles do on the way: a catch authored with the humerus rotated ~170° (sh.y ≈ −172) next to a push in the y ≈ 0
  // family sent the arm 34 cm out of the water and through the torso mid-transition (round-2 lab). The original driver
  // slerped quaternions. This keeps the same non-uniform Catmull-Rom / Fritsch–Carlson machinery but applies it to the
  // rotation VECTORS of the four control keyframes expressed in the log map of the segment's start keyframe:
  //   r_j = log(Q1⁻¹ · Q_j)  (r_1 = 0),  r(t) = Hermite(0, r_2, tangents from the neighbours),  Q(t) = Q1 · exp(r(t)).
  // Exact at the knots, C1 up to the (second-order) curvature of the log map, and the path between two keyframes is the
  // geodesic bent only by the neighbour tangents — the arm moves the short way like a slerp would.
  var _qs = null;
  function qscratch() {
    if (_qs) return _qs;
    var THREE = T();
    _qs = { q: [new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion()], qi: new THREE.Quaternion(), qr: new THREE.Quaternion(),
            r: [new Float64Array(3), new Float64Array(3), new Float64Array(3), new Float64Array(3)], e: new Float64Array(9), out: new Float64Array(3) };
    return _qs;
  }
  // rotation vector (axis·angle, angle ∈ [0, π]) of a unit quaternion
  function qlog(q, out) {
    var w = q.w, x = q.x, y = q.y, z = q.z;
    if (w < 0) { w = -w; x = -x; y = -y; z = -z; }                  // shortest arc
    var s = Math.sqrt(x * x + y * y + z * z);
    if (s < 1e-9) { out[0] = out[1] = out[2] = 0; return out; }
    var th = 2 * Math.atan2(s, w), k = th / s;
    out[0] = x * k; out[1] = y * k; out[2] = z * k; return out;
  }
  function qexp(r, q) {
    var th = Math.sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]);
    if (th < 1e-12) { q.set(0, 0, 0, 1); return q; }
    var s = Math.sin(th / 2) / th;
    q.set(r[0] * s, r[1] * s, r[2] * s, Math.cos(th / 2)); return q;
  }
  function shoulderQuatSpline(phases, idx, localT, hold, supine, sideKey, outQ) {
    var n = (phases && phases.length) | 0, S2 = qscratch(), sx = supine ? 1 : -1, k;
    if (n <= 0) { outQ.set(0, 0, 0, 1); return outQ; }
    idx = Math.floor(num(idx));
    var i0 = ((idx - 1) % n + n) % n, i1 = ((idx % n) + n) % n, i2 = (i1 + 1) % n, i3 = (i1 + 2) % n;
    var P0 = phases[i0] || EMPTY_PHASE, P1 = phases[i1] || EMPTY_PHASE, P2 = phases[i2] || EMPTY_PHASE, P3 = phases[i3] || EMPTY_PHASE;
    var d0 = phaseDur(P0), d1 = phaseDur(P1), d2 = phaseDur(P2), lt = clamp01(num(localT));
    var sh0 = fld(P0[sideKey], 'sh', ZERO3), sh1 = fld(P1[sideKey], 'sh', ZERO3), sh2 = fld(P2[sideKey], 'sh', ZERO3), sh3 = fld(P3[sideKey], 'sh', ZERO3);
    setQuatFromDeg(S2.q[0], sx * num(sh0[0]), sh0[1], sh0[2]); setQuatFromDeg(S2.q[1], sx * num(sh1[0]), sh1[1], sh1[2]);
    setQuatFromDeg(S2.q[2], sx * num(sh2[0]), sh2[1], sh2[2]); setQuatFromDeg(S2.q[3], sx * num(sh3[0]), sh3[1], sh3[2]);
    if (n === 1) { outQ.copy(S2.q[1]); return outQ; }
    S2.qi.copy(S2.q[1]).invert();
    qlog(S2.qr.copy(S2.qi).multiply(S2.q[0]), S2.r[0]);
    S2.r[1][0] = S2.r[1][1] = S2.r[1][2] = 0;
    qlog(S2.qr.copy(S2.qi).multiply(S2.q[2]), S2.r[2]);
    qlog(S2.qr.copy(S2.qi).multiply(S2.q[3]), S2.r[3]);
    var limited = config.spline !== 'catmull', tp, h00, h10, h01, h11;
    if (hold) { tp = easeInOut(lt); }
    else { var s2 = lt * lt, s3 = s2 * lt; h00 = 2 * s3 - 3 * s2 + 1; h10 = s3 - 2 * s2 + lt; h01 = -2 * s3 + 3 * s2; h11 = s3 - s2; }
    for (k = 0; k < 3; k++) {
      var e01 = -S2.r[0][k], e12 = S2.r[2][k], e23 = S2.r[3][k] - S2.r[2][k];
      if (hold) { S2.out[k] = e12 * tp; continue; }
      var m1 = tangent(e01 / d0, e12 / d1, d0, d1, limited), m2 = tangent(e12 / d1, e23 / d2, d1, d2, limited);
      S2.out[k] = h01 * e12 + d1 * (h10 * m1 + h11 * m2);
    }
    qexp(S2.out, S2.qr);
    outQ.copy(S2.q[1]).multiply(S2.qr);
    return outQ;
  }
  function applyLegVector(legObj, v) {
    setQuatFromDeg(legObj.hipJ.quaternion, -v[4], v[5], v[6]);
    legObj.knee.rotation.set(v[7] * DEG, 0, 0);
  }
  var _poseCache = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;
  function cacheFor(swimmer) {
    var c = _poseCache ? _poseCache.get(swimmer) : swimmer.__tlm;
    if (!c) {
      c = { L: new Float64Array(NV), R: new Float64Array(NV), valid: false, rest: null, fingersDone: false,
            neckValid: false, neckInX: 0, neckInY: 0, neckOutX: 0, neckOutY: 0,
            wristValid: false, lastU: 0, wristX: [0, 0], twist: [0, 0] };
      if (_poseCache) _poseCache.set(swimmer, c); else swimmer.__tlm = c;
    }
    return c;
  }
  // Replaces applyPose×2 + applyLegPose×2 in updateSwimmer (legs skipped when sd.flutter).
  function applyPoseSpline(swimmer, sd, phases, idx, localT) {
    if (!swimmer) return;
    sd = sd || EMPTY_PHASE;
    var c = cacheFor(swimmer);
    interpolatePhases(phases || sd.phases, idx, localT, !!sd.hold, c.L, c.R);
    c.valid = true;
    var supine = !!sd.supine, ph = phases || sd.phases, quat = config.shoulderSpline === 'quat' && ph && ph.length > 1;
    if (swimmer.armL) { applyArmVector(swimmer.armL, c.L, supine); if (quat) shoulderQuatSpline(ph, idx, localT, !!sd.hold, supine, 'L', swimmer.armL.shoulder.quaternion); }
    if (swimmer.armR) { applyArmVector(swimmer.armR, c.R, supine); if (quat) shoulderQuatSpline(ph, idx, localT, !!sd.hold, supine, 'R', swimmer.armR.shoulder.quaternion); }
    if (!sd.flutter) { if (swimmer.legL) applyLegVector(swimmer.legL, c.L); if (swimmer.legR) applyLegVector(swimmer.legR, c.R); }
  }
  // One call for the whole driver pose block: spline arms/legs + flutter.
  function poseFrame(swimmer, sd, phases, idx, localT, u) {
    if (!swimmer) return;
    applyPoseSpline(swimmer, sd, phases, idx, localT);
    if (sd && sd.flutter && swimmer.legL && swimmer.legR) { if (config.anatomicalKick) applyFlutterKickAnatomical(swimmer, u, !!sd.supine); else applyFlutterKick(swimmer, u); }
  }

  // ═════════════════════════════════════════════════════════════════════════════════
  // 2b. Body wave (technique pass) — the driver's spine / bob / neck block for strokes that define sd.wave
  // ═════════════════════════════════════════════════════════════════════════════════
  // Returns { spineX, bob, neckX } — spineX in rad on the spine pivot (+ = chest DOWN / ventral, the driver's sign), bob in
  // metres on swimmerOrient (whole body, world y), neckX in rad on the neck (− = face forward / up). The page ADDS these to its
  // own spineX / bob / neckX, which are 0 when it takes this branch (index.html updateSwimmer; see README.md
  // "Maintainer notes"). u = cycle position, b = the driver's breath envelope (0..1).
  //   sd.wave = { chestAmp (deg), chestPhase (u of the chest-press peak), breathLift (deg of chest-UP folded in with b),
  //               bobAmp (m), bobPhase (u of the highest hip line), breathBob (m·b), neckBreath (rad·b, face forward),
  //               neckAmp? (deg, + = face down) at neckPhase? (defaults to chestPhase) — the dolphin's head-node term (pass 6) }
  //   or      = { kick: 'breast', knots: [[u, spineDeg, bobM, neckDeg], …] } — a knot table (technique pass 2, breaststroke):
  //             spineDeg > 0 = chest UP, neckDeg < 0 = face forward / up, smoothstep between neighbouring knots (bodyWaveKnots).
  // Butterfly: chest pressed deepest just after the entry (u 0.05, hips highest), chest-up peak at the exit / breath (u 0.58,
  // hips lowest) — the Λ then V shapes a coach looks for (RESEARCH §F4 line 442, §F5 line 455). Dolphin (technique pass 3): the
  // same sinusoid with u = 0 at the top of the kick — chest UP 8.6° / hips lowest at u 0 (the arch, heels up), chest DOWN 8.6° /
  // hips highest at u 0.5 (the press, legs straight) — plus ankleAmp / anklePhase, which only applySecondary reads (the foot whip).
  // Technique pass 6 (dolphin re-fix): the bob trails the chest press by 0.04 cycle (bobPhase 0.48 / chestPhase 0.52) and neckAmp −3°
  // counter-pitches the head (neckX = −0.35 × spineX), so the head is the node of the wave (p-p 0.04 m vs shoulders 0.06, hips 0.16).
  // Without sd.wave (freestyle, backstroke, every AI motion) this is EXACTLY the page's old formula: the single-hinge sine when
  // sd.undulate plus the front-breath chest lift — nothing else changes.
  function bodyWave(sd, u, b) {
    b = clamp01(num(b)); u = num(u);
    var w = sd && sd.wave;
    if (!w) {
      var spineX = 0, bob = 0, neckX = 0;
      if (sd && sd.undulate) { spineX += Math.sin(u * TAU) * 0.18; bob += Math.sin(u * TAU + 0.6) * 0.05; }
      if (sd && sd.breath && sd.breath.type === 'front' && b > 0) { spineX -= b * 0.38; neckX = -b * 0.55; bob += b * 0.055; }
      return { spineX: spineX, bob: bob, neckX: neckX };
    }
    if (w.knots && w.knots.length) return bodyWaveKnots(w.knots, u);
    var neckX = -num(w.neckBreath) * b;                                                                     // rad, − = face forward / up
    // Technique pass 6 (dolphin re-fix, coach critic fix 2): an optional head-node term on the neck / head ONLY (never spine.x) —
    // neckAmp (deg, + = face DOWN / chin tuck) at neckPhase (u of its face-down peak; defaults to chestPhase, so neckAmp = −0.35 × chestAmp
    // is the counter-pitch neckX = −0.35 × spineX). Only a record that sets neckAmp takes it (the dolphin); the butterfly's result is
    // untouched bit-for-bit (test 5j compares every input against v1.10.0).
    if (w.neckAmp) neckX += DEG * num(w.neckAmp) * Math.cos(TAU * (u - num(w.neckPhase !== undefined ? w.neckPhase : w.chestPhase)));
    return {
      spineX: DEG * (num(w.chestAmp) * Math.cos(TAU * (u - num(w.chestPhase))) - num(w.breathLift) * b),   // + = chest DOWN (ventral)
      bob:    num(w.bobAmp) * Math.cos(TAU * (u - num(w.bobPhase))) + num(w.breathBob) * b,                 // m, world, whole body
      neckX:  neckX
    };
  }
  // Knot-table wave (technique pass 2, breaststroke — technique-breaststroke.md §3.3): knots = [[u, spineDeg, bobM, neckDeg], …]
  // sorted by u over [0, 1]. spineDeg > 0 = chest UP (returned as spineX = −spineDeg·DEG, the driver's ventral-positive sign),
  // bob in metres on swimmerOrient, neckDeg < 0 = face forward / up (neckX = neckDeg·DEG; applySecondary splits it 60/40 head/neck).
  // Smoothstep between neighbouring knots: zero slope at every knot → C1, and a knot placed on an eased (hold) keyframe has zero
  // velocity there too, so the trunk and the limbs never fight. u ring-wraps; outside the table's u range the nearest end holds.
  // Breaststroke: the chest rises to 28° with the hips 8 cm down at the in-sweep / breath (u 0.46), the head dives (chin tucks)
  // into the recovery, the hips ride 2 cm ABOVE the glide line through the squeeze (u 0.66-0.72), then a flat glide.
  var ZERO4 = [0, 0, 0, 0];
  function knot(K, i) { var k = K[i]; return (k && k.length !== undefined) ? k : ZERO4; }
  function knotOut(k) { return { spineX: (0 - num(k[1])) * DEG, bob: num(k[2]), neckX: num(k[3]) * DEG }; }   // (0 − x): never a −0
  function bodyWaveKnots(K, u) {
    var n = K.length, i, a, c;
    u = u - Math.floor(u);
    if (n === 1 || u <= num(knot(K, 0)[0])) return knotOut(knot(K, 0));
    for (i = 0; i < n - 1; i++) {
      a = knot(K, i); c = knot(K, i + 1);
      if (u <= num(c[0])) {
        var d = num(c[0]) - num(a[0]), t = d > 0 ? clamp01((u - num(a[0])) / d) : 1, s = t * t * (3 - 2 * t);
        return { spineX: (0 - lerp(num(a[1]), num(c[1]), s)) * DEG, bob: lerp(num(a[2]), num(c[2]), s), neckX: lerp(num(a[3]), num(c[3]), s) * DEG };
      }
    }
    return knotOut(knot(K, n - 1));
  }

  // ═════════════════════════════════════════════════════════════════════════════════
  // 3. Secondary motion (joints the driver never touches)
  // ═════════════════════════════════════════════════════════════════════════════════
  function armOk(A) { return !!(A && A.shoulder && A.upperArm && A.elbow && A.forearm && A.wrist && A.hand); }
  function restOf(swimmer) {
    var c = cacheFor(swimmer);
    if (c.rest) return c.rest;
    var r = { shL: armOk(swimmer.armL) ? swimmer.armL.shoulder.position.clone() : null, shR: armOk(swimmer.armR) ? swimmer.armR.shoulder.position.clone() : null };
    c.rest = r;
    return r;
  }
  function bone(o) { return o && o.isObject3D ? o : null; }
  function setFingersOnce(swimmer) {
    var c = cacheFor(swimmer);
    if (c.fingersDone) return;
    c.fingersDone = true;
    var s, i, b;
    for (s = 0; s < 2; s++) {
      var L = s === 0 ? swimmer.legL : swimmer.legR;
      var toes = L && L.toes;
      if (toes) for (i = 0; i < toes.length; i++) { b = bone(toes[i]); if (b) b.rotation.x = -6 * DEG; }
    }
  }
  // Per frame: finger abduction = pull weight × config.fingerSpread (≤ 4° per finger, symmetric about the middle finger), the
  // thumb adds config.thumbAbduct in the pull and stays adducted otherwise. Body-local: fingers run −Y, rotation.z abducts in the
  // palm plane (positive = toward +X = the thumb side on the left hand, away from it on the right — the sign flips per side).
  function setFingers(A, side, pull) {
    var f = A && A.fingers; if (!f || !f.length) return;
    var mid = (f.length - 1) / 2, sgn = side === 0 ? 1 : -1, i, b;
    for (i = 0; i < f.length; i++) {
      b = bone(f[i]); if (!b) continue;
      var k = (i - mid) / Math.max(1, mid);           // thumb −1 … little +1
      // LEFT hand-local: the thumb sits at −X, the little finger at +X; rotation.z = +θ swings a finger (0,−1,0) toward +X. So the
      // little finger (k > 0) abducts with +z and the index (k < 0) with −z: z = +k·spread; the right hand is mirrored in x (sgn).
      b.rotation.z = sgn * k * config.fingerSpread * pull * (i === 0 ? 0 : 1);
      if (i === 0) { b.rotation.z = -sgn * config.thumbAbduct * pull; b.rotation.y = 0; }   // thumb: toward −X (away from the fingers) only in the pull
    }
  }

  // Arm geometry in SPINE-local space from the driver channels (shoulder quaternion, elbow.rotation.x).
  // du = upper-arm direction, df = forearm direction, dh = unit hand direction from the shoulder.
  function armGeometry(sideObj, s, out) {
    var qsh = sideObj.shoulder.quaternion;
    out.du.set(0, -1, 0).applyQuaternion(qsh);
    s.qA.copy(qsh).multiply(sideObj.upperArm.quaternion).multiply(sideObj.elbow.quaternion);
    out.df.set(0, -1, 0).applyQuaternion(s.qA);
    var ua = sideObj.elbow.position.length() || 0.30, fa = sideObj.wrist.position.length() || 0.27;
    out.dh.copy(out.du).multiplyScalar(ua).addScaledVector(out.df, fa + 0.07);
    out.handDist = out.dh.length();
    out.dh.normalize();
    return out;
  }
  var _geoL = null, _geoR = null;
  function geo(side) {
    if (!_geoL) {
      var THREE = T();
      _geoL = { du: new THREE.Vector3(), df: new THREE.Vector3(), dh: new THREE.Vector3(), handDist: 0 };
      _geoR = { du: new THREE.Vector3(), df: new THREE.Vector3(), dh: new THREE.Vector3(), handDist: 0 };
    }
    return side === 0 ? _geoL : _geoR;
  }
  // 0 = upper arm in the water (pulling / streamline), 1 = upper arm clearly on the air side (recovering).
  function armAirWeight(sideObj, supine) {
    var s = scratch();
    s.v1.set(0, -1, 0).applyQuaternion(sideObj.shoulder.quaternion);
    var waterSign = supine ? -1 : 1;
    return smoothstep(0.05, 0.45, -waterSign * s.v1.z);
  }

  function applySecondary(swimmer, sd, u, b, phases, idx, localT) {
    if (!swimmer) return;
    sd = sd || EMPTY_PHASE;
    var s = scratch();
    var supine = !!sd.supine;
    var waterSign = supine ? -1 : 1;     // body-Z sign that points into the water
    b = clamp01(num(b)); u = num(u);
    var c = cacheFor(swimmer);
    setFingersOnce(swimmer);
    var rest = restOf(swimmer);
    // frame-to-frame low-pass state for the wrist (and anything else that needs it): Δu in cycle fractions, ring-wrapped;
    // a jump (stroke change, arrow-key stepping, first call) snaps to the target so a paused/stepped pose is exact
    var du = c.wristValid ? (u - c.lastU) : 0;
    du = du - Math.round(du);                                   // ring wrap → (-0.5, 0.5]
    var jump = !c.wristValid || Math.abs(du) > config.lpJump;
    var alphaLP = jump ? 1 : Math.min(1, Math.abs(du) / config.lpTau);
    if (du === 0 && c.wristValid) alphaLP = 0;                   // same frame twice → idempotent
    // Round-2: the water ("down") and feet directions expressed in SPINE-local space through the driver's roll, the hip
    // counter-roll and the chest lift (spine.rotation.x). The previous code assumed spine-local +Z = down and −Y = feet, so
    // during the breaststroke breath (chest lifted 18°) a hand resting forward on the surface read as "pulling" and the
    // pull solver twisted it toward the feet instead of the glide solver turning it palm-down.
    var rootQ = swimmer.root ? swimmer.root.quaternion : null, hipsQ = swimmer.hips ? swimmer.hips.quaternion : null, spineQ = swimmer.spine ? swimmer.spine.quaternion : null;
    s.qC.set(0, 0, 0, 1);
    if (rootQ) s.qC.multiply(rootQ); if (hipsQ) s.qC.multiply(hipsQ); if (spineQ) s.qC.multiply(spineQ);
    s.qC.invert();
    s.v4.set(0, 0, waterSign).applyQuaternion(s.qC);            // down (into the water), spine-local
    s.v5.set(0, -1, 0).applyQuaternion(s.qC);                   // feet, spine-local

    // ── arms: wrist flexion, forearm/wrist twist, scapula ─────────────────────────
    for (var side = 0; side < 2; side++) {
      var A = side === 0 ? swimmer.armL : swimmer.armR;
      if (!armOk(A)) continue;
      var sgn = side === 0 ? 1 : -1;      // +X is the left side
      var twistBone = bone(A.forearmTwist);                     // body.js ≥ 1.3 forearm twist bone (else the forearm bone twists)
      var foreMax = twistBone ? config.forearmTwistBoneMax : config.forearmTwistMax;
      var twistCap = foreMax + config.wristTwistMax;
      var G = armGeometry(A, s, geo(side));
      // pulling weight: hand on the water side of the shoulder, not in streamline
      var waterSide = G.dh.dot(s.v4), fwdHand = -G.dh.dot(s.v5), fwdUpper = -G.du.dot(s.v5);
      var pull = smoothstep(0.12, 0.45, waterSide) * (1 - smoothstep(0.86, 0.97, fwdHand));
      // recovering weight: upper arm on the air side
      var air = smoothstep(0.05, 0.45, -G.du.dot(s.v4));
      setFingers(A, side, pull);                                 // fingers together except while pulling (≤ 4°)

      // forearm frame (shoulder·upperArm·elbow·forearm-rest) and the feet direction expressed in it
      s.qA.copy(A.shoulder.quaternion).multiply(A.upperArm.quaternion).multiply(A.elbow.quaternion);
      s.qB.copy(s.qA).invert();
      s.v1.copy(s.v5).applyQuaternion(s.qB);             // feet direction in forearm-local

      // wrist flexion toward the feet (palmar flexion in the pull): Rx(θ)(0,-1,0) has z = -sinθ.
      // Round-2 review: the sign used to be a hard `v1.z >= 0 ? -1 : 1` — when the hand crossed the shoulder line mid-pull the
      // wrist flipped −18° → +18° in ONE frame (hand centre jumped 44 mm, freestyle u ≈ 0.38, both arms every cycle). The sign
      // is now a continuous ramp of the lateral component (zero flexion when flexing about x cannot point the palm at the feet
      // anyway) and the wrist target is low-passed across frames (state keyed on u; a phase jump snaps).
      var flexSign = -clamp(s.v1.z / config.wristFlexBlend, -1, 1);
      var wristTarget = flexSign * config.wristFlexMax * pull;
      if (!c.wristValid || jump) c.wristX[side] = wristTarget;
      else c.wristX[side] += (wristTarget - c.wristX[side]) * alphaLP;
      A.wrist.rotation.x = c.wristX[side];

      // ── twist about the forearm axis (split forearm 60 % / wrist 40 %, capped at 75° total) ──
      // pull: solve the twist ψ that turns the rest palm normal (0,0,palmRest) toward the feet,
      // projected perpendicular to the forearm axis: Ry(ψ)·(0,0,pr) = (pr·sinψ, 0, pr·cosψ)
      var pr = config.palmRest;
      var fx = s.v1.x, fz = s.v1.z, fLen = Math.sqrt(fx * fx + fz * fz);
      var psiRaw = fLen > 1e-6 ? Math.atan2(pr * fx, pr * fz) : 0;
      var wFlip = 1 - smoothstep(config.twistFadeStart, config.twistFadeEnd, Math.abs(psiRaw));  // fade near the ±180° ambiguity
      var wProj = smoothstep(0.2, 0.5, fLen);                                // fade when the forearm is along the body axis
      var psiPull = clamp(psiRaw, -twistCap, twistCap) * wFlip * wProj;
      // schedule outside the pull: supine = thumb-up exit → pinky-down entry (the backstroke hand rotation),
      // prone = relaxed hand with a slight inward turn on the recovery
      // prone recovery: the schema leaves the dangling hand palm-up (palm ⟂ the elbow flex plane), so the same
      // solver turns it toward the feet/body with weight `air` — a relaxed, palm-in recovery hand
      var wSolve = supine ? pull : Math.max(pull, 0.85 * air);
      var psiSched = supine ? (-sgn * twistCap * clamp(fwdUpper / 0.8, -1, 1)) : 0;
      // prone glide / recovery with the hands forward (breaststroke [3]→[0], fly entry): turn the palm toward the WATER so the
      // hands are flat, palms down, fingertips leading (round-1: the breaststroke recovery had the palms facing forward)
      if (!supine) {
        s.v2.copy(s.v4).applyQuaternion(s.qB);                    // water direction in forearm-local
        var gx = s.v2.x, gz = s.v2.z, gLen = Math.sqrt(gx * gx + gz * gz);
        var psiG = gLen > 1e-6 ? Math.atan2(pr * gx, pr * gz) : 0;
        var wG = (1 - smoothstep(config.twistFadeStart, config.twistFadeEnd, Math.abs(psiG))) * smoothstep(0.2, 0.5, gLen);
        var wGlide = (1 - pull) * (1 - air) * smoothstep(0.55, 0.85, fwdHand);
        psiSched = clamp(psiG, -twistCap, twistCap) * wG * wGlide;
      }
      var psiT = wSolve * psiPull + (1 - wSolve) * psiSched;
      if (config.debugArm === side) config._dbg = { pull: pull, air: air, wSolve: wSolve, psiRaw: psiRaw / DEG, psiPull: psiPull / DEG, psiSched: psiSched / DEG, psiT: psiT / DEG, dhy: G.dh.y, dhz: G.dh.z, fLen: fLen, wFlip: wFlip, wProj: wProj };   // dev aid (tests/labs only)
      // low-pass the twist too (same Δu-keyed filter as the wrist flexion): the palm solver's target is continuous, but its
      // rate can spike where the forearm sweeps through the body axis (wProj) — the filter keeps the hand from spinning
      if (!c.wristValid || jump) c.twist[side] = psiT; else c.twist[side] += (psiT - c.twist[side]) * alphaLP;
      var psi = c.twist[side];
      var fShare = foreMax / twistCap;
      var foreTwist = clamp(psi * fShare, -foreMax, foreMax);
      if (twistBone) { twistBone.rotation.y = foreTwist; A.forearm.rotation.y = 0; } else A.forearm.rotation.y = foreTwist;
      A.wrist.rotation.y = clamp(psi * (1 - fShare), -config.wristTwistMax, config.wristTwistMax);
      A.wrist.rotation.z = 0;

      // scapular elevation / protraction on the recovering side
      if (A.scapula && A.scapula.isObject3D) {
        A.scapula.rotation.z = sgn * config.scapulaRot * air;   // elevation
        A.scapula.rotation.y = -sgn * config.scapulaRot * 0.5 * air; // protraction
      } else {
        var r0 = side === 0 ? rest.shL : rest.shR;
        if (r0) A.shoulder.position.set(r0.x + sgn * config.scapularShift * 0.4 * air, r0.y + config.scapularShift * air, r0.z - waterSign * config.scapularShift * 0.5 * air);
      }
    }

    // ── legs: ankle / foot ─────────────────────────────────────────────────────────
    for (side = 0; side < 2; side++) {
      var L = side === 0 ? swimmer.legL : swimmer.legR; sgn = side === 0 ? 1 : -1;
      if (!L || !L.ankle || !L.knee) continue;
      var ax, ay = 0;
      if (sd.flutter) {
        var kp = u * TAU * 3 + (side === 0 ? 0 : Math.PI);
        // plantarflexion peaks mid-downbeat, lagging the knee (whose lag is +0.7 in applyFlutterKick); with the anatomical
        // kick the foot whips at the bottom of the down-beat instead
        ax = config.ankleRest - config.ankleFlutterAmp * Math.cos(kp + (config.anatomicalKick ? (supine ? config.ankleKickLagAnatomicalSupine : config.ankleKickLagAnatomical) : config.ankleKickLag));
        ay = -sgn * config.footInversionFlutter;                 // slightly pigeon-toed
      } else {
        var kn = Math.abs(L.knee.rotation.x) / DEG;
        if (sd.wave && sd.wave.kick === 'breast') {
          // Technique pass 2 — breaststroke (technique-breaststroke.md §3.4): the feet flex and turn out late in the heel-draw
          // (phase 1, config.breastFlexKnee = kn 70 → 122, complete at the top of the draw — the spec's 100 → 128 left the pointed
          // feet 13 cm out of the water for ~5 % of the cycle with the shin vertical; 70 → 122 keeps the toes ≤ 10 cm up and the heel
          // just touching the surface, every §4 number still met), stay dorsiflexed + turned out through the
          // propulsive out-back-round sweep (phase 2 until localT 0.45, SW 7.5) and point for the squeeze / glide (localT ≥ 0.85).
          // Continuous at both phase boundaries (kn 126 at the 1→2 boundary gives w 1 → 1; 0 → 0 at 2→3). Never the
          // generic kn-keyed heel-draw below, which flexed the foot from kn 75 and pointed it while the feet were still sweeping.
          var plantarB = config.ankleRest + 0.22 * smoothstep(5, 45, kn), pi = Math.floor(num(idx)), lt = clamp01(num(localT));
          var fk = config.breastFlexKnee || ZERO4, tk = config.breastTurnoutKnee || fk, wh = config.breastWhipHold || ZERO4;
          // technique pass 5 (breaststroke re-fix, critic F2): the foot FLEXES first (breastFlexKnee) and turns out later (breastTurnoutKnee) —
          // real feet flex before they evert — to a breast-specific target (breastDorsiflex; ankleDorsiflex when unset); both hold through
          // the whip and point together (breastWhipHold)
          var wPoint = pi === 2 ? 1 - smoothstep(num(wh[0]), num(wh[1]), lt) : 0;
          var wB = pi === 1 ? smoothstep(num(fk[0]), num(fk[1]), kn) : wPoint;
          var wT = pi === 1 ? smoothstep(num(tk[0]), num(tk[1]), kn) : wPoint;
          ax = lerp(plantarB, config.breastDorsiflex !== undefined ? num(config.breastDorsiflex) : config.ankleDorsiflex, wB);
          ay = sgn * config.footTurnout * wT;
        } else if (sd.wave && sd.wave.ankleAmp) {
          // Technique pass 3 — the underwater dolphin kick (technique-dolphin.md §3.4): the foot whip is keyed to the CYCLE, not to
          // the knee — peak plantarflexion (ankleRest + ankleAmp = 1.35 rad, 77°) at u = anklePhase (0.30, mid-downkick, the shins
          // snapping straight), least pointed (0.95 rad, 54°: the water pushing the dorsum through the upkick) half a cycle later,
          // 62° at the top of the kick (RESEARCH §F5 line 452: peak 64-66°, validation 60-70°). The knee-keyed mappings below
          // pointed this foot hardest at the TOP with the knees bent — an inverted whip. No turnout.
          ax = config.ankleRest + num(sd.wave.ankleAmp) * Math.cos(TAU * (u - num(sd.wave.anklePhase)));
        } else if (sd.wave) {
          // Technique pass — dolphin-kick strokes that define sd.wave (butterfly): the foot LOADS (less pointed, 44.7°) at the
          // top of the beat while the knee is bent and WHIPS to its peak plantarflexion (67.6°) at the bottom of the down-beat
          // as the leg straightens (RESEARCH §F5 line 452: peak 64-66°; validation 60-70°, line 456). The generic mapping
          // below points the foot MORE when the knee is bent — an inverted whip on a two-beat kick. (Breaststroke's sd.wave
          // carries kick: 'breast' and takes the branch above.)
          ax = config.ankleRest + 0.03 - 0.40 * smoothstep(12, 58, kn);
        } else {
          // pointed foot at rest (streamline = exactly 1.15); more knee bend → more plantarflexion (whip), up to ~1.37 rad
          var plantar = config.ankleRest + 0.22 * smoothstep(5, 45, kn);
          // breaststroke heel-draw: feet dorsiflexed and turned out as the heels come up
          var draw = smoothstep(75, 110, kn);
          ax = lerp(plantar, config.ankleDorsiflex, draw);
          ay = sgn * config.footTurnout * draw;
        }
      }
      L.ankle.rotation.set(ax, ay, 0);
    }

    // ── roll distribution: hips roll less than the shoulders (spine counter-rotates) ──
    var roll = swimmer.root ? swimmer.root.rotation.y : 0;
    var spine = swimmer.spine, hips = swimmer.hips;
    if (spine && hips) {
      if (spine.rotation.order === 'XYZ') spine.rotation.order = 'YXZ';   // exact: net = Rx(spineX)
      var phi = (1 - config.hipRollRatio) * roll;
      hips.rotation.y = -phi;
      spine.rotation.y = phi;
    }

    // ── head: keep the driver's breathing, redistribute onto the head bone, counter-roll ──
    // Idempotent: if the neck still holds exactly what we wrote last time (the driver has not run in
    // between), the driver's original values are taken from the cache, so a second call on the same
    // frame neither halves the turn again nor stacks the counter-roll.
    var neck = swimmer.neck, head = swimmer.head;
    var counter = -(1 - config.headRollRatio) * roll * (1 - b);
    if (neck) {
      var nx = neck.rotation.x, ny = neck.rotation.y;
      if (c.neckValid && nx === c.neckOutX && ny === c.neckOutY) { nx = c.neckInX; ny = c.neckInY; }
      c.neckInX = nx; c.neckInY = ny;
      if (head && head.isBone) {
        head.rotation.x = nx * config.headShare;
        head.rotation.y = ny * config.headShare + counter;
        neck.rotation.x = nx * (1 - config.headShare);
        neck.rotation.y = ny * (1 - config.headShare);
      } else {
        neck.rotation.x = nx;
        neck.rotation.y = ny + counter;
      }
      c.neckOutX = neck.rotation.x; c.neckOutY = neck.rotation.y; c.neckValid = true;
    }
    c.lastU = u; c.wristValid = true;
  }

  // Restore every joint applySecondary touches (call if the hook is disabled).
  function resetSecondary(swimmer) {
    if (!swimmer) return;
    var c = cacheFor(swimmer), rest = restOf(swimmer), i, j, b;
    for (i = 0; i < 2; i++) {
      var A = i === 0 ? swimmer.armL : swimmer.armR; if (!armOk(A)) continue;
      A.wrist.rotation.set(0, 0, 0); A.forearm.rotation.set(0, 0, 0); A.upperArm.rotation.set(0, 0, 0);
      if (bone(A.forearmTwist)) A.forearmTwist.rotation.set(0, 0, 0);
      var r0 = i === 0 ? rest.shL : rest.shR; if (r0) A.shoulder.position.copy(r0);
      if (bone(A.scapula)) A.scapula.rotation.set(0, 0, 0);
      if (A.fingers) for (j = 0; j < A.fingers.length; j++) { b = bone(A.fingers[j]); if (b) b.rotation.set(0, 0, 0); }
    }
    for (i = 0; i < 2; i++) {
      var L = i === 0 ? swimmer.legL : swimmer.legR; if (!L) continue;
      if (L.ankle) L.ankle.rotation.set(config.ankleRest, 0, 0);
      if (L.toes) for (j = 0; j < L.toes.length; j++) { b = bone(L.toes[j]); if (b) b.rotation.set(0, 0, 0); }
    }
    c.fingersDone = false;   // the next applySecondary re-applies the static finger/toe spread
    c.wristValid = false; c.wristX[0] = c.wristX[1] = 0; c.twist[0] = c.twist[1] = 0;   // low-pass state: the next call snaps to its target
    if (swimmer.hips) swimmer.hips.rotation.y = 0;
    if (swimmer.spine) swimmer.spine.rotation.y = 0;
    if (swimmer.head && swimmer.head.isBone) swimmer.head.rotation.set(0, 0, 0);
    if (swimmer.neck && c.neckValid && swimmer.neck.rotation.x === c.neckOutX && swimmer.neck.rotation.y === c.neckOutY) {
      swimmer.neck.rotation.x = c.neckInX; swimmer.neck.rotation.y = c.neckInY;   // give the neck the driver's full turn back
    }
    c.neckValid = false;
  }

  // ═════════════════════════════════════════════════════════════════════════════════
  // 4. Clearance — elbow / forearm / wrist / hand / fingertip vs torso + neck + head
  // ═════════════════════════════════════════════════════════════════════════════════
  var SCAN_MAX = 63;
  var _scanPen = new Float64Array(SCAN_MAX + 1);
  var stats = { frames: 0, engagements: 0, skippedPulling: 0, unresolved: 0, ramped: 0, maxNudgeDeg: 0, lastNudgeDeg: [0, 0], lastGate: [0, 0], lastPenetration: [0, 0], maxPenetrationBefore: 0, maxPenetrationAfter: 0 };
  function resetStats() {
    stats.frames = 0; stats.engagements = 0; stats.skippedPulling = 0; stats.unresolved = 0; stats.ramped = 0; stats.maxNudgeDeg = 0;
    stats.lastNudgeDeg[0] = stats.lastNudgeDeg[1] = 0; stats.lastGate[0] = stats.lastGate[1] = 0; stats.lastPenetration[0] = stats.lastPenetration[1] = 0;
    stats.maxPenetrationBefore = 0; stats.maxPenetrationAfter = 0;
  }

  // Approximate signed distance to an ellipsoid (Inigo Quilez): k0 = |p/h|, k1 = |p/h²|, d = k0(k0−1)/k1.
  function sdEllipsoid(px, py, pz, sh) {
    var x = (px - sh.c[0]) / sh.h[0], y = (py - sh.c[1]) / sh.h[1], z = (pz - sh.c[2]) / sh.h[2];
    var k0 = Math.sqrt(x * x + y * y + z * z);
    if (k0 < 1e-9) return -Math.min(sh.h[0], sh.h[1], sh.h[2]);
    var x1 = x / sh.h[0], y1 = y / sh.h[1], z1 = z / sh.h[2];
    var k1 = Math.sqrt(x1 * x1 + y1 * y1 + z1 * z1);
    return k0 * (k0 - 1) / k1;
  }
  // Per-frame body frames (computed once in prepareFrames): spine-local → hips-local and → head-local.
  var _fr = { ok: false };
  function prepareFrames(swimmer, s) {
    var spine = swimmer.spine, neck = swimmer.neck, head = swimmer.head;
    _fr.spinePos = spine ? spine.position : null; _fr.spineQ = spine ? spine.quaternion : null;
    _fr.neckPos = neck ? neck.position : null;
    if (neck) s.qNeckInv.copy(neck.quaternion).invert(); else s.qNeckInv.set(0, 0, 0, 1);
    if (head && head.isObject3D) { s.headOff.copy(head.position); s.qHeadInv.copy(head.quaternion).invert(); }
    else { s.headOff.set(config.headBoneOffset[0], config.headBoneOffset[1], config.headBoneOffset[2]); s.qHeadInv.set(0, 0, 0, 1); }
    _fr.ok = true;
  }
  // Signed clearance (m, <0 inside) of a SPINE-local point against the union of body shapes.
  function bodyDistance(p, s) {
    var best = 1e9, d, i, sh;
    // hips-local: p_body = spinePos + spineQ·p
    s.v2.copy(p); if (_fr.spineQ) s.v2.applyQuaternion(_fr.spineQ); if (_fr.spinePos) s.v2.add(_fr.spinePos);
    // head-local: p_head = headQ⁻¹·(neckQ⁻¹·(p − neckPos) − headOff)
    s.v3.copy(p); if (_fr.neckPos) s.v3.sub(_fr.neckPos); s.v3.applyQuaternion(s.qNeckInv).sub(s.headOff).applyQuaternion(s.qHeadInv);
    for (i = 0; i < SHAPES.length; i++) {
      sh = SHAPES[i];
      if (sh.frame === 'spine') d = sdEllipsoid(p.x, p.y, p.z, sh);
      else if (sh.frame === 'body') d = sdEllipsoid(s.v2.x, s.v2.y, s.v2.z, sh);
      else d = sdEllipsoid(s.v3.x, s.v3.y, s.v3.z, sh);
      if (d < best) best = d;
    }
    return best;
  }
  // Penetration depth (m, >0 inside) of a SPINE-local point with radius r (default 0) + config.clearance.
  function penetrationDepth(p, r) {
    var s = scratch();
    if (!_fr.ok) { _fr.spinePos = null; _fr.spineQ = null; _fr.neckPos = null; s.qNeckInv.set(0, 0, 0, 1); s.qHeadInv.set(0, 0, 0, 1); s.headOff.set(0, 0.10, 0.005); }
    return (r || 0) + config.clearance - bodyDistance(p, s);
  }
  // Fill s.pts with spine-local test points of one arm for a given shoulder quaternion.
  function armPoints(A, qsh, s) {
    var m = s.m1;
    m.compose(A.shoulder.position, qsh, A.shoulder.scale);
    A.upperArm.updateMatrix(); m.multiply(A.upperArm.matrix);
    A.elbow.updateMatrix(); m.multiply(A.elbow.matrix);
    s.pts[0].setFromMatrixPosition(m);                        // elbow
    A.forearm.updateMatrix(); m.multiply(A.forearm.matrix);
    if (A.forearmTwist && A.forearmTwist.isObject3D) { A.forearmTwist.updateMatrix(); m.multiply(A.forearmTwist.matrix); }   // body.js ≥ 1.3
    A.wrist.updateMatrix(); s.m2.copy(m).multiply(A.wrist.matrix);
    s.pts[2].setFromMatrixPosition(s.m2);                     // wrist
    s.pts[1].copy(s.pts[0]).add(s.pts[2]).multiplyScalar(0.5); // forearm mid
    A.hand.updateMatrix(); s.m3.copy(s.m2).multiply(A.hand.matrix);
    s.pts[3].setFromMatrixPosition(s.m3);                     // hand centre
    s.v1.set(0, -config.fingertipLen, 0).applyMatrix4(s.m2);
    s.pts[4].copy(s.v1);                                      // fingertip
    return s.pts;
  }
  function maxPenetration(A, qsh, s) {
    var pts = armPoints(A, qsh, s), worst = -1e9, R = config.pointRadii || ZERO1;
    for (var i = 0; i < pts.length; i++) {
      var d = num(R[i]) + config.clearance - bodyDistance(pts[i], s);
      if (d > worst) worst = d;
    }
    return worst;
  }
  // One directional scan: bracket the smallest clearing angle in [0, cap] along direction `dir` (±1 about the
  // shoulder's local Z, sgn-corrected by the caller), then bisect; when nothing clears, a soft-min over the scan
  // (τ = softMinTau) picks the penetration-minimising angle instead of an argmin, which flips on flat curves.
  // Results land in `out` (no allocation): delta ≥ 0 (magnitude), cleared, first (penetration at the first step).
  var _scanA = { delta: 0, cleared: false, first: 0 };
  function scanDirection(A, q0, dir, cap, K, pen0, s, out) {
    var lo = 0, hi = -1, k, penMin = pen0, tau = config.softMinTau > 0 ? config.softMinTau : 0.004;
    for (k = 1; k <= K; k++) {
      var trial = cap * k / K;
      s.e.set(0, 0, dir * trial, 'XYZ'); s.qD.setFromEuler(s.e);
      s.qA.copy(q0).multiply(s.qD);
      var penK = maxPenetration(A, s.qA, s);
      if (penK < penMin) penMin = penK;
      _scanPen[k] = penK;
      if (k === 1) out.first = penK;
      if (penK <= 0) { hi = trial; break; }
      lo = trial;
    }
    if (hi < 0) {
      var sumW = 0, sumWD = 0;
      _scanPen[0] = pen0;
      for (k = 0; k <= K; k++) { var w = Math.exp(-(_scanPen[k] - penMin) / tau); sumW += w; sumWD += w * (cap * k / K); }
      out.delta = sumWD / sumW; out.cleared = false;
      return out;
    }
    for (var it = 0, nIt = clamp(config.bisectionSteps | 0, 0, 30); it < nIt; it++) {
      var mid = 0.5 * (lo + hi);
      s.e.set(0, 0, dir * mid, 'XYZ'); s.qD.setFromEuler(s.e);
      s.qA.copy(q0).multiply(s.qD);
      if (maxPenetration(A, s.qA, s) > 0) lo = mid; else hi = mid;
    }
    out.delta = hi; out.cleared = true;
    return out;
  }
  function resolveClearance(swimmer, sd) {
    if (!swimmer || !armOk(swimmer.armL) || !armOk(swimmer.armR)) return;
    var s = scratch();
    var supine = !!(sd && sd.supine);
    stats.frames++;
    prepareFrames(swimmer, s);
    for (var side = 0; side < 2; side++) {
      var A = side === 0 ? swimmer.armL : swimmer.armR, sgn = side === 0 ? 1 : -1;
      var q0 = s.qC.copy(A.shoulder.quaternion);
      var pen0 = maxPenetration(A, q0, s);
      stats.lastPenetration[side] = pen0;
      stats.lastNudgeDeg[side] = 0; stats.lastGate[side] = 0;
      if (!(pen0 === pen0)) continue;                    // NaN pose (broken quaternion): leave it alone
      if (pen0 > stats.maxPenetrationBefore) stats.maxPenetrationBefore = pen0;
      // only the recovering arm may be moved; the allowed nudge fades in with the air weight so the
      // correction is continuous through entry/exit
      var air = armAirWeight(A, supine);
      stats.lastGate[side] = air;
      if (pen0 <= 0) { continue; }
      if (air <= 0) { stats.skippedPulling++; if (pen0 > stats.maxPenetrationAfter) stats.maxPenetrationAfter = pen0; continue; }
      stats.engagements++;
      // penetration is not monotone in the abduction angle (a different test point can become the deepest),
      // so bracket the SMALLEST clearing angle with a coarse scan first, then bisect inside that bracket.
      // Continuity: (a) when no angle clears, a soft-min over the scan (not an argmin, which flips on flat
      // curves) picks the penetration-minimising angle; (b) the result is bounded by a ramp proportional to
      // the depth, so a first touch of a few mm gets a few degrees even when the minimal clearing angle is
      // large — the correction grows with the penetration instead of snapping in.
      // Direction: +sh.z (abduction) only. Because the Euler chain is Rx·Ry·Rz, a +z nudge moves the upper arm
      // laterally by cos(sh.z)·cos(sh.y) — MEDIALLY when |sh.y| > 90° (e.g. the patched freestyle recovery,
      // sh.y = 140°, where the solver never engages; the AI validator clamps sh.y to ±90°). In that regime the
      // scan finds no clearing angle and the soft-min returns ≈ 0, i.e. the solver degrades to a no-op rather
      // than flipping direction (a sign flip is a discontinuity; measured 40° frame jumps when tried).
      var cap = config.maxAbductionNudge * air, K = clamp(config.scanSteps | 0, 1, SCAN_MAX);
      var P = scanDirection(A, q0, sgn, cap, K, pen0, s, _scanA);
      var delta = P.delta;
      if (!P.cleared) stats.unresolved++;
      var ramp = pen0 * config.nudgeRamp;
      if (ramp < delta) { delta = ramp; stats.ramped++; }
      s.e.set(0, 0, sgn * delta, 'XYZ'); s.qD.setFromEuler(s.e); s.qA.copy(q0).multiply(s.qD);
      var penFinal = maxPenetration(A, s.qA, s);
      if (penFinal > stats.maxPenetrationAfter) stats.maxPenetrationAfter = penFinal;
      A.shoulder.quaternion.copy(s.qA);
      stats.lastNudgeDeg[side] = delta / DEG;
      if (delta / DEG > stats.maxNudgeDeg) stats.maxNudgeDeg = delta / DEG;
    }
  }
  // Diagnostic: max penetration of both arms for the CURRENT pose (no nudging). Returns [L, R].
  var _pen = [0, 0];
  function measurePenetration(swimmer) {
    var s = scratch();
    prepareFrames(swimmer, s);
    _pen[0] = maxPenetration(swimmer.armL, swimmer.armL.shoulder.quaternion, s);
    _pen[1] = maxPenetration(swimmer.armR, swimmer.armR.shoulder.quaternion, s);
    return _pen;
  }

  // ═════════════════════════════════════════════════════════════════════════════════
  // 5. STROKE_PATCHES — coaching corrections (the numbers and their sources are in each patch's `notes` string below)
  // ═════════════════════════════════════════════════════════════════════════════════
  // Format: { [stroke]: { rollAmp?, breath?, depth?, rate?, wave?, hold?, append?: { at, phases: [full phase objects] }, phases?: { [i]: { name?, desc?, dur?, drag?, thrust?, lift?, vel?, eff?, L?: {sh?,el?,hi?,kn?}, R?: {...} } },
  //           rate: tempo multiplier on the page's global 0.55 cycles/s clock (technique pass; the page reads sd.rate),
  //           wave: bodyWave() parameters (technique pass; the page's undulation block reads sd.wave),
  //           phasesAnatomical?: same shape, used instead of `phases` when config.anatomicalElbow is true,
  //           notes: what changed and the measured result, sources: the RESEARCH.md §F entries / rules behind the numbers } }
  // Freestyle keeps the site's opposition rule R[i] = mirror(L[i+3]) (y,z negated).
  var STROKE_PATCHES = {
    freestyle: {
      notes: 'Round 1: catch/pull re-authored with the humerus internally rotated (sh.y ≈ −135/−151) so the forearm hangs UNDER the elbow: at max hand depth the hand is 2-16 cm BEHIND the elbow (was 12 cm ahead = dropped elbow), the elbow ≤ 24 cm below the shoulder, palm back 0.56 in the pull; the max hand depth (0.56-0.58 m) is what a 0.64 m arm gives with the 35° roll. Roll sign inverted vs the arm cycle (recovering shoulder rolled DOWN) → rollAmp -24 and the side-breath window moved to the right-arm recovery (start 0.12) so the face turns to the high side. Recovery re-authored (exact-solved from target upper-arm/forearm directions, humerus internally rotated) as a HIGH-ELBOW recovery: at the peak the elbow is 33 cm above the water, lateral of the shoulder (never across the back), the forearm hangs relaxed with the hand 18 cm over the water; the arm then straightens and slopes down into a narrow entry in front of the shoulder (hand at the surface 7 cm lateral of the shoulder line, palm down, fingertips first). Measured over the whole cycle: zero torso/head penetration, hand ≤ 36 cm above the water, elbow clears the back by ≥ 5 cm. The keyframe schema slaves the palm to the elbow flex plane, so a bent-elbow entry would enter palm-up — hence the straight-arm entry (see NOTES-motion.md). Catch = high elbow / early vertical forearm; pull keeps the elbow above the hand. R[i] = mirror(L[i+3]).',
      sources: 'RESEARCH §F1: USMS freestyle guide (entry shoulder-width, fingertips first, hand flat; recovery elbow high, hand low; breathing: rotate the head with the body, one goggle in the water); USMS pull guide + Vanderbilt pose-estimation study (elbow ≈ 87.5° in the pull, high elbow / early vertical forearm); Virag et al. 2014 PMC4000476 (dropped-elbow recovery and crossover entry as the most common errors); shoulder-vs-hip roll data (ResearchGate 256197437).',
      rollAmp: -22,
      depth: 0.03,                       // round-2: the body sits 3 cm lower so the water plane no longer slices the face (the driver reads sd.depth)
      breath: { type: 'side', start: 0.12, dur: 0.30 },
      phases: {
        1: { name: 'Catch & Breath', desc: 'The elbow stays high and forward while the forearm and hand press down and back under it — the early vertical forearm — as the head turns with the roll to breathe toward the recovering arm, one goggle in the water.',
             L: { sh: [8, 37, 154], el: [97] }, R: { sh: [-105, -140, 21], el: [117] } },
        2: { desc: 'The pull: the elbow points out and stays above the hand, the forearm and palm face straight back and the hand passes under the shoulder — the hand trails the elbow, it never leads it.',
             L: { sh: [-31, 16, 38], el: [103] }, R: { sh: [90, 72, -90], el: [36] } },
        4: { name: 'High-Elbow Recovery', desc: 'The elbow leads the recovery, lifted well clear of the water and out to the side, the forearm and hand hanging relaxed just above the surface as the body rolls onto the pulling side.',
             L: { sh: [-105, 140, -21], el: [117] }, R: { sh: [8, -37, -154], el: [97] } },
        5: { desc: 'The elbow leads forward, still bent, and the forearm reaches in front of the shoulder to a narrow entry — fingertips first, palm down, the hand never higher than the elbow — then the arm extends under the surface while the opposite arm drives through its pull.',
             L: { sh: [90, -72, 90], el: [36] }, R: { sh: [-31, -16, -38], el: [103] } }
        // Round-4 review ("windmill: hand +0.373 m and 22 cm ABOVE the elbow at u 0.22, straight-arm swing into a high entry"): the
        // straight forward-down entry [176, 30, 7]/8 made the quaternion path from the high-elbow peak swing the forearm over the
        // top. r4-fs-search.js (path metrics over exit → peak → entry → extension on the stub rig): a bent-elbow entry
        // [90, −72, 90]/36 (upper arm forward + 18° lateral at the surface, forearm angled back in front of the shoulder) keeps the
        // hand ≤ +0.18 m, 6-10 cm BELOW the elbow until it passes the shoulder line, elbow peak +0.30 unchanged, entry hand −0.01 m
        // with the fingertips 2 cm under the wrist, palm down 0.95, 1 cm lateral of the shoulder; phase 0 then extends the arm.
      }
    },
    backstroke: {
      notes: 'Round 1: rollAmp 26 → 32 (ref 30-40°) and the anatomical catch [1] bends the elbow to 80° as the hand sinks (was 14° → a straight arm sweeping 68 cm deep between catch and out-sweep); max hand depth now 0.60 m with a 106° elbow, the elbow is the deepest point at the out-sweep. The underwater pull was authored with the prone sign (upper arm anterior = out of the water in supine): Catch/In-Sweep hands were +14…+19 cm ABOVE the surface. Re-authored: pinky-first entry at 11 o\'clock with the hand at the surface, hand sinks ~30 cm at the catch, bent elbow with the elbow as the deepest point, in-sweep to the hip, push down past the thigh (thumb exits), straight-arm recovery vertical over the shoulder. R = mirror(L[i+3]). `phases` keeps the SPEC §2.2 supine elbow sign (el bends toward the olecranon on a real arm, so the pull is authored with a straighter arm); `phasesAnatomical` is used when config.anatomicalElbow is on: catch 14° with the hand 37 cm deep, mid-pull 111° with the elbow 42 cm deep and the hand 30 cm deep sweeping to the hip, push past the thigh 34 cm deep; every keyframe bends the elbow toward the biceps.',
      sources: 'RESEARCH §F2: swimlikeafish + Special Olympics backstroke guide (little-finger-first entry at 11 and 1 o\'clock, hand sinks ≈ 30 cm, elbow ≈ 90° with the elbow the deepest point, thumb exits first); USMS backstroke guide (straight-arm vertical recovery, pinky leads); World Aquatics SW 6.2 (roll < 90°).',
      phases: {
        0: { L: { sh: [-176, 0, 12], el: [6] }, R: { sh: [28, 0, -18], el: [20] } },
        1: { L: { sh: [152, 10, 32], el: [30] }, R: { sh: [8, 0, -12], el: [8] } },
        2: { L: { sh: [95, 5, 60], el: [90] }, R: { sh: [-100, 4, -12], el: [8] } },
        3: { L: { sh: [28, 0, 18], el: [20] }, R: { sh: [-176, 0, -12], el: [6] } },
        4: { L: { sh: [8, 0, 12], el: [8] }, R: { sh: [152, -10, -32], el: [30] } },
        5: { L: { sh: [-100, -4, 12], el: [8] }, R: { sh: [95, -5, -60], el: [90] } }
      },
      rollAmp: 32,
      depth: 0.0,
      phasesAnatomical: {
        0: { L: { sh: [-176, 0, 12], el: [6] }, R: { sh: [37, 0, -20], el: [10] } },
        1: { desc: 'The hand sinks and the elbow bends straight away — the elbow drops toward the bottom while the hand stays above it, setting up the deep-elbow catch.',
             L: { sh: [-90, -10, 90], el: [80] }, R: { sh: [8, 0, -12], el: [8] } },
        2: { L: { sh: [22, 22, 54], el: [80] }, R: { sh: [-100, 4, -12], el: [8] } },
        3: { L: { sh: [37, 0, 20], el: [10] }, R: { sh: [-176, 0, -12], el: [6] } },
        4: { L: { sh: [8, 0, 12], el: [8] }, R: { sh: [-90, 10, -90], el: [80] } },
        5: { L: { sh: [-100, -4, 12], el: [8] }, R: { sh: [22, -22, -54], el: [80] } }
      }
    },
    breaststroke: {
      // Technique pass 5 (2026-09-16, technique-breaststroke-review-1.md — the coach critic's round 1 on pass 2): the pass-2 stroke
      // STOPPED in the middle of its kick (an eased `hold` keyframe at u 0.59 with the knees at 50° — foot speed 8.2 → 0.06 m/cycle, a
      // 0.3 s freeze at 0.3×), stood its still-pointed feet 12 cm out of the water on the heel-draw (the foot flexed late and only to
      // 0.55 rad), lifted the whole head out at the breath with the hips only 16 cm deep, and sculled the in-sweep with the elbows
      // 8.7 cm BELOW the hands (0.285 m deep). Now: the C1 spline instead of the eased lerp (`hold: false` — P4 == P0 keeps the glide
      // static; every other keyframe carries velocity where its channels are monotone, so the out-sweep corner is a slow-down, not a
      // stop), the whole whip is ONE segment from the top of the draw (u 0.46) to the squeeze finish (u 0.66: legs straight and
      // together 11° below the hip line, feet pointed, arms locked out), the foot flexes flat (0.15 rad) as the heels rise (kn 35 → 95)
      // and turns out late (kn 95 → 124), the hips sink to 0.21 m at the breath (chest 30°, shoulders at the surface, chin at the
      // water), and the in-sweep keyframes were re-solved (c3-arm-grid.js) so the elbows stay within 2 cm of the hands and never
      // deeper than 0.22 m — elbows 13 cm deep at the finish. Verified with human/test/c3-breast-design.js (--json prints this block).
      rate: 1.3,                          // 0.55 × 1.3 = 0.715 Hz = 43 cycles/min (elite 200 m / slow 100 m; 1.40 s per cycle at 1×, 4.7 s at 0.3×)
      depth: 0.03,
      hold: false,                        // technique pass 5: the C1 spline; the page's mannequin fallback lerps linearly between the same keyframes
      breath: { type: 'front', start: 0.32, dur: 0.30 },   // b peaks at u 0.47 = the in-sweep keyframe; only applySecondary's head split reads it now
      wave: { kick: 'breast', knots: [
        //  u     spine°  bob m   neck°     spine° > 0 = chest UP; neck° < 0 = face forward / up (the head takes 60 %)
        [0.00,    0,   0.000,    0],
        [0.20,    0,   0.000,    0],
        [0.30,    1,  -0.010,    0],       // out-sweep corner: the chin starts to rise
        [0.38,    9,  -0.080,   -4],
        [0.46,   30,  -0.128,  -10],       // breath peak = the in-sweep keyframe: chest up 30°, hips 12.8 cm down (0.21 m deep), face forward 10°
        [0.53,   20,  -0.150,   -2],       // the hips stay deep through the first half of the whip (the feet sweep back-and-down under the surface)
        [0.59,    8,  -0.076,    6],       // lunge: head diving, chin tucking, as the hands shoot forward (bob on the 0.53 → 0.66 smoothstep: one 16.5 cm rise)
        [0.66,    0,   0.015,    3],       // the squeeze drives the hips up to 1.5-2 cm ABOVE the glide line
        [0.72,   -3,   0.020,    0],       // slightly head-down
        [0.85,    0,  -0.005,    0],       // a 0.5 cm settle in the glide
        [1.00,    0,   0.000,    0] ] },
      notes: 'Technique pass 5: five keyframes at u 0 / 0.30 / 0.46 / 0.66 / 0.74 (dur 0.30 0.16 0.20 0.08 0.26), C1 spline (hold false) — Glide & Streamline (hands 0.137 m apart 4.6 cm under, legs together, feet pointed; P4 identical so the glide is static), Out-Sweep & Catch (u 0.30: hands 1.14 m apart 0.17 m deep, arms 6°, elbows 0.14 m deep, the legs relaxed 16° down), In-Sweep, Breath & Heel-Draw (u 0.46: elbows 0.13 m deep and 0.60 m apart, hands 0.15 m apart 7 cm deep in front of the chin, elbow 70°; heels drawn to the buttocks hi [31,−18,8] / kn 126, feet flat 0.15 rad + turned out 28°), Squeeze into the Glide (u 0.66: arms locked [180,2,−12]/5, legs straight hi [11,−3,3] / kn 3, feet pointed), Streamline Glide (u 0.74 = P0). Trunk = bodyWave() knot table: chest up 30° with the hips 12.8 cm below the glide line at u 0.46 (hips 0.208 m deep, shoulders −0.028, head bone +0.054, face 10° forward), 20° / −0.15 at 0.53, 8° / −0.076 at 0.59 (the hips rise 16.5 cm in one smooth sweep from 0.53 to 0.66), hips 1.5-2 cm above the glide line at 0.66-0.72, a 0.5 cm settle at 0.85. Ankle (config.breastFlexKnee / breastTurnoutKnee / breastWhipHold / breastDorsiflex): flat by kn 95 (0.15 rad), turned out over kn 95 → 124, held through the sweep until localT 0.50 of the whip, pointed by 0.88 (u 0.63). Stub rig, 720 samples, page driver semantics (human/test/c3-breast-design.js): toe speed 5.6 m/cycle peak at u 0.53, ≥ 42 % of it until kn ≤ 20 and ≥ 23 mm per 0.02 cycle to kn ≤ 5 (no stall), |dkn/du| ≥ 313°/cycle to kn ≤ 10, kn strictly decreasing; hand forward speed ≥ 30 % of its peak until el ≤ 30 and the hand never moves back; toe tip (page-like, 0.22 m) ≤ +0.010 everywhere, heel marker ≤ +0.002 (the heel pad skin still shows ~4 cm for ~4 % of the cycle mid-draw, u 0.39-0.44, with the ankle joint at the surface); breath peak spineX −30.0 / hips −0.208 / shoulders −0.028 / head bone +0.054 / thigh 33.5° (trunk-thigh 57°) / hands 0.151 apart 7.0 cm deep / elbows −0.134; in-sweep elbow − hand ≥ −0.019 over u 0.30-0.42, elbows ≤ 0.220 deep, hands ≤ 0.243; corner hand speed 23 % of the peak; glide 41 %, feet widest 0.72 at 0.51, toes 0.29 deep at the finish (0.633), zero penetration (max −0.019, 0 engagements), continuity 0.8 mm second difference / 10.6 mm step.',
      sources: 'RESEARCH §F3 lines 433-438 (cycle pull → breathe → kick → glide; out-sweep to shoulder width or slightly wider with the elbows near the surface; in-sweep with the chin and shoulders rising and the hands meeting in front of the chin; heels to the buttocks, knee 120-130°, hip flexion 40-50°, feet dorsiflexed and turned out; the kick starts slow and ends fast; elite leg glide 46.5 ± 3.6 % of the 100 m cycle; tempo 100 m 43.7-53.3 / 200 m 35.7-43.0 cycles/min); World Aquatics SW 7.2 (one arm stroke and one leg kick in that order), 7.3 (elbows under water, hands on/under the surface, never behind the hip line), 7.4 (the head breaks the surface every cycle), 7.5 (feet turned outwards in the propulsive part of the kick); coaching (rocketswim, swim-teach, swimrightacademy): chest up ~25-30° with the hips sinking at the breath, head dives between the arms into the lunge, hips ride up to the surface as the legs squeeze; technique-breaststroke-review-1.md (coach critic round 1: one continuous accelerating whip, feet in the water on the draw, hips 19-23 cm deep at the breath with the chin at the water, elbows high through the in-sweep).',
      phases: {
        0: { name: 'Glide & Streamline', dur: 0.30, drag: 18, thrust: 4, lift: 2, vel: 1.68, eff: 82, desc: 'Legs together, feet pointed, hands 14 cm apart just under the surface, head between the arms; the body rides flat for a third of the cycle before the hands slide apart into the out-sweep.',
             L: { sh: [180, 2, -12], el: [5], hi: [2, 0, 0], kn: [2] }, R: { sh: [180, -2, 12], el: [5], hi: [2, 0, 0], kn: [2] } },
        1: { name: 'Out-Sweep & Catch', dur: 0.16, drag: 46, thrust: 40, lift: 18, vel: 1.50, eff: 60, desc: 'Hands press out to 1.1 m apart, 17 cm deep, arms straight with the elbows high near the surface; the legs relax a little downward and the chin starts to rise as the hands turn the corner.',
             L: { sh: [134, -35, 48], el: [6], hi: [16, 0, 0], kn: [10] }, R: { sh: [134, 35, -48], el: [6], hi: [16, 0, 0], kn: [10] } },
        2: { name: 'In-Sweep, Breath & Heel-Draw', dur: 0.20, drag: 84, thrust: 130, lift: 24, vel: 1.42, eff: 52, desc: 'Elbows stay high near the surface and bend to 70 degrees as the forearms scull in and up under them, the hands meeting in front of the chin; the chest lifts 30 degrees, the hips sink and the shoulders reach the surface; the heels draw to the buttocks with the feet flat and turned out.',
             L: { sh: [96, -56, 37], el: [70], hi: [31, -18, 8], kn: [126] }, R: { sh: [96, 56, -37], el: [70], hi: [31, 18, -8], kn: [126] } },
        3: { name: 'Squeeze into the Glide', dur: 0.08, drag: 48, thrust: 80, lift: 24, vel: 1.84, eff: 74, desc: 'One continuous whip has brought the legs straight and together, feet pointed again and still angled a little below the hip line; the arms are locked out, the head is back between the arms and the hips ride up to the surface as the body lunges forward.',
             L: { sh: [180, 2, -12], el: [5], hi: [11, -3, 3], kn: [3] }, R: { sh: [180, -2, 12], el: [5], hi: [11, 3, -3], kn: [3] } },
        4: { name: 'Streamline Glide', dur: 0.26, drag: 20, thrust: 4, lift: 2, vel: 1.86, eff: 84, desc: 'The streamline holds: hands stacked just under the surface, head down between the arms, legs together with the feet pointed, the body riding flat and settling for the last quarter of the cycle.',
             L: { sh: [180, 2, -12], el: [5], hi: [2, 0, 0], kn: [2] }, R: { sh: [180, -2, 12], el: [5], hi: [2, 0, 0], kn: [2] } }
      }
    },
    butterfly: {
      // Technique pass 4 (2026-09-16, technique-butterfly-review-1.md, the coach critic's round 1 on pass 1): the pass-1 fly HOVERED
      // its arms over the water for the last sixth of the cycle (hand speed 11.8 → 0.5 m/cycle over u 0.65-0.99, 45 % of the cycle
      // over the water), pinched the hands to 0.28 m right after the entry, caught with a dropped vertical forearm and the hands
      // OUTSIDE the elbows, stalled then flung at the exit (1.7 → 11.8 m/cycle), recovered a little high (+0.21) and sat on bent
      // knees for 52 % of the cycle. Now SEVEN keyframes: the ring starts at the press (hands 15 cm under, 0.63 m apart, elbows high)
      // and the Entry is its own keyframe at u 0.90 just under the surface, so the hands cross the surface at u 0.88 on the spline
      // at 3+ m/cycle (over-water fraction 0.33), press down and OUT (gap ≥ 0.50 until the in-sweep starts), catch with the hands
      // inside and behind high wide elbows (108°), push deep and fast to an exit at u 0.556 with the elbow still extending, and
      // recover in ONE world-axis sweep (Exit → T → Entry = the same 76° rotation about a near-vertical axis: the T keyframe carries
      // its full spline tangent, the crease faces medial at the exit / back at the T / lateral at the entry = pinky-first exit,
      // thumbs-down recovery, palms-out entry). Kick 1 bottoms 0.11 after the entry; the knees are bent > 30° for 28 % of the cycle
      // and the thighs come up through the body line (hip 5-6°) on both up-beats. Every keyframe was solved from WORLD hand /
      // elbow / crease targets under the wave with human/test/c2-fly-design.js (--json prints this block); the sweep keyframes are
      // rotations of the Exit frame, so do not re-express any `sh` triple in another Euler form without re-running that tool.
      rate: 1.6,                          // 0.55 × 1.6 = 0.88 Hz = 52.8 cycles/min (real 100 m 56-61, 200 m 50-55; slow end so 1× stays studyable)
      depth: 0.027,                       // was 0.03: with bobAmp 0.05 the hip line tops out at −0.025 (buttocks at the surface) and bottoms at −0.125
      breath: { type: 'front', start: 0.46, dur: 0.24 },   // was 0.44 / 0.28: same peak (u 0.58), the head is back under by u 0.66 (critic F8)
      wave: { chestAmp: 15, chestPhase: -0.01, breathLift: 7, bobAmp: 0.05, bobPhase: 0, breathBob: 0, neckBreath: 0.42 },   // press peak / hips highest at u 0.99-1.00, right after the entry
      notes: 'Technique pass 4: 7 keyframes at u 0 / 0.15 / 0.345 / 0.43 / 0.55 / 0.71 / 0.90 (dur 0.15 0.195 0.085 0.12 0.16 0.19 0.10) — Press & Outsweep (u 0: hands 0.15 m under, 0.63 m apart, x 1.06, elbows 8 cm under and high, 28°; the chest at its deepest, hips at the surface, kick 1 at its bottom), Catch (0.15: elbows −0.09 m and 0.81 m apart, hands 0.41 m deep, 0.70 m apart, 8 cm BEHIND and 6 cm inside the elbows, 108°), Keyhole In-sweep (0.345: hands 0.22 m apart under the chest, 0.34 m deep, elbows 122°), Push (0.43: hands 0.31 m deep at x +0.03 driving back — the fastest part of the pull, 5.9 m/cycle), Exit (0.55: hand at x −0.19 just under the surface, elbow 17° and still extending, the crossing at u 0.556 on the spline; kick 2 at its bottom), Recovery (0.71: the T = the Exit frame swept 76° about a near-vertical world axis, hand +0.13 / elbow +0.02, 1.47 m apart, 8°), Entry (0.90: swept 155°, hand 4 cm under at x 1.08, 0.58 m apart, 3°; the crossing at u 0.883 with the hand at 3.2 m/cycle; knee 66° / thigh 31° = the top of kick 1). Trunk = bodyWave(): press +15° / hips −0.025 at u 0.99-1.00, chest-up −20.3° / hips −0.125 at u 0.50-0.55, breath peak u 0.58 (face −24.1°), head bone −0.00 at u 0.66 / −0.08 at 0.74. Stub rig, 720 samples, page driver semantics (human/test/t2-fly-accept.js = c2-fly-design.js on the shipped record): over-water fraction 0.326 (0.556 → 0.883), hand speed ≥ 3.2 m/cycle over the water, (T→entry)/(exit→T) path rate 0.85, exit speed min 2.57 m/cycle over u 0.52-0.70 (max/min 2.7), hand max +0.140 at u 0.77 with the elbow 0.113 below it at the T, min hand gap 0.51 over [entry, 0.22] and 0.85 at u 0.05, deepest hand −0.415 at u 0.154 with the hand 6 cm inside the elbows (0.70 vs 0.82 apart), keyhole gap 0.22 at 0.33, push gap ≤ 0.95, knee > 30° for 28 % of the cycle, hip flexion 5-6° on both up-beats, toe range ≥ 0.055 m in every 0.10 window, kick-1 bottom 0.11 after the entry, toes −0.033 … −0.541 (amplitude 0.51), heels ≤ −0.002, ankle 67.6° / 44.7°, zero penetration (max −0.093, 0 engagements), hand continuity 1.7 mm second difference / 9.6 mm step, both hands at equal height every frame (SW 8.2). Kept from pass 1: the ankle whip mapping, the keyhole, rate 1.6, the sinusoid wave form.',
      sources: 'RESEARCH §F4 lines 441-448 (undulation from the chest, hips up as the hands go in; simultaneous shoulder-width entry, fingertips first, hands press OUT to the catch; high wide elbows, keyhole out-in-out, hands accelerate to exit at the hips/thighs; low straight-ish simultaneous recovery, thumbs down; two kicks per cycle — down as the hands enter and as they exit; chin forward not lifted; 100 m tempo 56-61 cycles/min) and §F5 lines 450-457 (wave travels head → toe with increasing amplitude; knee peak 59-64°, plantarflexion 64-66°, toe amplitude 0.45-0.6 m); World Aquatics SW 8.2 / 8.3 (arms and legs simultaneous); technique-butterfly-review-1.md (coach critic round 1: over-water fraction 0.30-0.38 with a ballistic recovery, hands never inside 0.50 before the in-sweep, catch hands inside and behind the elbows at 0.38-0.44 deep, continuous exit, recovery 0.14-0.19 high with the elbows within 0.12 of the hands, knees bent > 30° for ≤ 42 %, thighs through the line, toes never dwelling, hips at the surface, head under by u 0.66); arm-coordination phase proportions [Chollet/Seifert, est.].',
      phases: {
        0: { name: 'Press & Outsweep', dur: 0.15, drag: 46, thrust: 36, lift: 20, vel: 1.70, eff: 60, desc: 'The hands press down and out from shoulder-width, elbows high and near the surface, as the chest presses to its deepest and the first kick snaps down behind.',
             L: { sh: [23, 45, 180], el: [28], hi: [24, 0, 0], kn: [4] }, R: { sh: [23, -45, -180], el: [28], hi: [24, 0, 0], kn: [4] } },
        1: { name: 'Catch', dur: 0.195, drag: 54, thrust: 74, lift: 36, vel: 1.66, eff: 66, desc: 'Elbows stay high and wide near the surface as the forearms press back — the hands now inside and behind the elbows, elbow near 105 degrees.',
             L: { sh: [4, 6, 136], el: [108], hi: [14, 0, 0], kn: [8] }, R: { sh: [4, -6, -136], el: [108], hi: [14, 0, 0], kn: [8] } },
        2: { name: 'Keyhole In-sweep', dur: 0.085, drag: 62, thrust: 110, lift: 40, vel: 1.84, eff: 70, desc: 'The keyhole: hands sweep in under the chest until they almost touch, elbows still wide, the chest starting to rise.',
             L: { sh: [-39, -34, 128], el: [122], hi: [5, 0, 0], kn: [18] }, R: { sh: [-39, 34, -128], el: [122], hi: [5, 0, 0], kn: [18] } },
        3: { name: 'Push', dur: 0.12, drag: 70, thrust: 110, lift: 46, vel: 2.04, eff: 73, desc: 'The fastest part of the pull — the hands drive back past the hips as the chest lifts and the knees load for the second kick.',
             L: { sh: [-85, -39, 111], el: [78], hi: [28, 0, 0], kn: [58] }, R: { sh: [-85, 39, -111], el: [78], hi: [28, 0, 0], kn: [58] } },
        4: { name: 'Exit', dur: 0.16, drag: 60, thrust: 36, lift: 26, vel: 2.10, eff: 66, desc: 'The second kick snaps down as the hands leave the water beside the thighs, little finger first and already swinging out — chin forward for the breath.',
             L: { sh: [-140, -68, 121], el: [17], hi: [26, 0, 0], kn: [4] }, R: { sh: [-140, 68, -121], el: [17], hi: [26, 0, 0], kn: [4] } },
        5: { name: 'Recovery', dur: 0.19, drag: 46, thrust: 14, lift: 9, vel: 1.70, eff: 54, desc: 'Straight, relaxed arms sweep low and wide over the water in one continuous swing, thumbs down, as the head goes back under.',
             L: { sh: [-117, -4, 74], el: [8], hi: [6, 0, 0], kn: [4] }, R: { sh: [-117, 4, -74], el: [8], hi: [6, 0, 0], kn: [4] } }
      },
      // the 7th keyframe (the STROKES table in index.html has six): appended by applyPatches only when the record still has exactly six phases
      append: { at: 6, phases: [
        { name: 'Entry', dur: 0.10, drag: 40, thrust: 60, lift: 14, vel: 1.62, eff: 58, desc: 'The hands enter shoulder-width in front of the head with momentum, fingertips first, as the hips rise for the next press and the knees load the first kick.',
          L: { sh: [-156, 40, 9], el: [3], hi: [31, 0, 0], kn: [66] }, R: { sh: [-156, -40, -9], el: [3], hi: [31, 0, 0], kn: [66] } } ] }
    },
    dolphin: {
      // Technique pass 3 (2026-09-16, technique-dolphin.md): the round-2 dolphin was a slow sit-up at 33 kicks/min — the knees bent
      // under a flat, nose-down plank (u 0.17: hip 34° / knee 56° with the trunk pitched 7° head-DOWN and the hips at their HIGHEST),
      // then a jackknife (hip 38°, legs straight, trunk straight), 38 % of the cycle a straight-leg glide, the thighs never above the
      // body line, the hips bobbing AFTER the toes, the head bobbing more than the hips, the foot most pointed with the knees bent.
      // Now u = 0 at the TOP of the kick (heels up, knees 56°, back arched, hips lowest), a 50 % downkick with the knees snapping
      // straight and the hips rising as the chest presses, the thighs 12° above the line at u 0.83, the vertical maxima travelling
      // head → shoulders → hips → knees → ankles → toes. Arms (streamline) untouched.
      // Technique pass 6 (technique-dolphin-review-1.md — coach critic round 1, 8.3 / 10, no blockers): (1) the upkick knee loads
      // PROGRESSIVELY — kn 4 → 10.5 at u 0.65 and 12 → 22 at u 0.83 (the leg was board-straight to u 0.72 and then snapped 12 → 56° in the
      // last sixth); with the thigh still 2° above the line at the top (hi −2 at u 0, the hip passes neutral 0.03 later) the ankle keeps
      // rising to u 0.93 so the maxima still travel knee (0.80) → ankle (0.93) → toe (0.965). (2) The head is the wave node: the bob now
      // trails the chest press by 0.04 cycle (bobPhase 0.48 / chestPhase 0.52, were 0.47 / 0.55 — the head's residual 8 cm was the
      // quadrature part of that 0.08 lag, which no neck term of sane size can cancel) and neckAmp −3° counter-pitches the head
      // (neckX = −0.35 × spineX: level in the world while the chest pitches ±8.6°) — head p-p 0.041 m < shoulders 0.059 < hips 0.160
      // (was head 0.084 ≈ shoulders 0.082). (3) Tempo 89 → 96 kicks/min (rate 2.9 — the critic's taste note: a 0.62 m kick at 89/min read
      // like a warm-up kick; the amplitude is NOT trimmed as well). (4) depth 0.42 → 0.44 so the higher top-of-kick toes stay ≥ 6 cm under.
      rate: 2.9,                         // 0.55 × 2.9 = 1.595 Hz = 96 kicks/min (RESEARCH §F5 line 452: 1.46 / 1.75 Hz at 70 / 80 % speed — the slow half of real, studyable; 0.627 s per kick at 1×, 2.09 s at 0.3×)
      depth: 0.44,                       // was 0.35 (round 2) → 0.42 (pass 3) → 0.44 (pass 6): keeps the toes ≥ 6 cm under at the top of the kick with the 56° knee and the 2° thigh carry-over
      // bodyWave() sinusoid (technique-dolphin.md §3.3 in the module's cos form; pass 6 phases): spineX = 8.6°·cos(2π(u − 0.52)) → −0.149 rad
      // (chest UP, the arch) at u 0, +0.149 (chest DOWN, the press) at u 0.5, level at u 0.27 / 0.77; bob = 0.08·cos(2π(u − 0.48)) → hips
      // highest (+0.079 m) at u 0.48, lowest at u 0.98. neckAmp −3 at chestPhase: neck + head pitch = −3°·cos(2π(u − 0.52)) = −0.35 × spineX
      // (face forward / up as the chest presses, chin down as it rises; the driver writes it on the neck, applySecondary splits it 60 / 40
      // head / neck — never spine.x). No breath (b ≡ 0). ankleAmp / anklePhase: applySecondary's cycle-keyed foot whip (77° at u 0.30, 54° at u 0.80).
      wave: { chestAmp: 8.6, chestPhase: 0.52, bobAmp: 0.08, bobPhase: 0.48, neckAmp: -3, ankleAmp: 0.20, anklePhase: 0.30 },
      notes: 'Technique pass 6 (dolphin re-fix): five keyframes with u = 0 at the TOP of the kick — Heels Up (Load) (u 0, dur 0.20: hip −2° / knee 56°, back arched 8.5° chest-up with the hip line 7.9 cm below its mean, heels drawn up under the surface, foot relaxed 62°), Downbeat Whip (u 0.20, dur 0.25: hip 14° / knee 28° — the thighs press down as the shins snap straight, foot 77° at u 0.30), Downbeat Peak (u 0.45, dur 0.20: hip 20° / knee 6° — legs straight, toes at their lowest, hips highest at u 0.48, chest pressed 8.5° at u 0.52), Upbeat Drive (u 0.65, dur 0.18: hip 6° / knee 10.5° — the legs sweep up through the line as the water starts to fold the knees), Upbeat Peak (u 0.83, dur 0.17: hip −12° / knee 22° — thighs above the body line with the shins lagging, the knees loading 22 → 56° over the last sixth). Arms unchanged on every phase (sh [-173, 2, ∓13] / el 5: hands stacked 0.115 m apart, biceps on the ears). Trunk = bodyWave() sinusoid (chest ±8.6° = 0.149 rad at u 0 / 0.5, hip line ±0.079 m at u 0.98 / 0.48 — lag 0.04) + the head-node counter-pitch (neck + head −3°·cos(2π(u − 0.52))) and the cycle-keyed ankle whip (config.ankleRest + 0.20·cos(2π(u − 0.30))). Tempo rate 2.9 → 96 kicks/min (0.627 s at 1×, 2.09 s at 0.3×). Stub rig, 720 samples, page driver semantics (human/test/t2-dolphin-accept.js): knee 56° at u 0, ≤ 8.0° over u 0.45-0.58, 10.5° at 0.65 (10.3 / 11.2 on the 48-sample grid at 0.646 / 0.667), 22° at 0.83 (22.5 at 0.833), 37.8° at 0.90; hip +20° @0.45 / −12° @0.83 (ROM 32°), hip line p-p 0.160 (max @0.481, min @0.981), trunk line +6.9° @0.02 / −6.9° @0.52, head p-p 0.041 = 0.25 × hips and < shoulders 0.059 (was 0.084 ≈ 0.082), vertical maxima head 0.236 → shoulders 0.410 → hips 0.481 → knee 0.797 → ankle 0.931 → toe 0.965, toe p-p 0.581 (stub toe) / 0.643 (body.js tip marker) = 4.0 × hips, downkick 0.488 of the cycle, heels ≤ −0.20 and toe tip ≤ −0.070 under the surface, hands −0.452…−0.306, head ≤ −0.480, neck + head −3° @0.52 / +3° @0.02, ankle 0.950 rad @0.80 / 1.350 @0.30, zero penetration (measurePenetration ≤ −0.015, 0 engagements), continuity 0.08 mm second difference / 3.5 mm step (toe). Pass 3 kept: the streamline, the 50 % downkick whip, the ankle mapping, the wave amplitudes.',
      sources: 'RESEARCH §F5 lines 450-457: PMC7739797 (elite UUS toe amplitude 0.45 ± 0.06 m, 1.9 ± 0.3 Hz, downkick 48.5 % of the cycle, pelvic tilt ±1.8°, vertical maxima travelling head → toe with increasing amplitude — chest ≈ 5 cm, hips ≈ 15, knees ≈ 30, toes 45-60) and the national-level kinematics (peak knee flexion 59-64°, hip ROM 32-36°, peak hip flexion 21-23° / extension 11-13°, peak plantarflexion 64-66° at mid-downkick, toe speed 3.6-4.1 m/s, 1.46 / 1.75 / 2.11 Hz at 70 / 80 / 90 % speed — frequency, not amplitude, tracks speed); §F4 line 446 (streamline: hands stacked, shoulder flexion ≈ 180°); depth ≥ 0.6 m removes wave drag (line 454) — the scene keeps the swimmer at 0.44 m to stay in frame; technique-dolphin-review-1.md (coach critic round 1: progressive knee flexion through the upkick — the shin lags the thigh from mid-upkick; the head as the node of the wave, shoulders moving a little more; tempo / amplitude pairing).',
      phases: {
        0: { name: 'Heels Up (Load)', dur: 0.20, drag: 48, thrust: 12, lift: 4, vel: 2.10, eff: 70, desc: 'Top of the kick: the back arches slightly — chest up, hips at their lowest, the head held level — the knees are bent about 56° with the thighs still a couple of degrees above the line, the heels drawn up under the surface and the feet relaxed. The wave has reached the knees.',
             L: { sh: [-173, 2, -13], el: [5], hi: [-2, 0, 0], kn: [56] }, R: { sh: [-173, -2, 13], el: [5], hi: [-2, 0, 0], kn: [56] } },
        1: { name: 'Downbeat Whip', dur: 0.25, drag: 56, thrust: 100, lift: 40, vel: 2.00, eff: 78, desc: 'The thighs press down and the knees snap straight — shins and pointed feet whip down at 3-4 m/s; the reaction lifts the hips.',
             L: { sh: [-173, 2, -13], el: [5], hi: [14, 0, 0], kn: [28] }, R: { sh: [-173, -2, 13], el: [5], hi: [14, 0, 0], kn: [28] } },
        2: { name: 'Downbeat Peak', dur: 0.20, drag: 70, thrust: 104, lift: 60, vel: 2.14, eff: 84, desc: 'The feet reach their lowest point, legs straight, toes pointed; the hips are at their highest and the chest presses down — peak thrust.',
             L: { sh: [-173, 2, -13], el: [5], hi: [20, 0, 0], kn: [6] }, R: { sh: [-173, -2, 13], el: [5], hi: [20, 0, 0], kn: [6] } },
        3: { name: 'Upbeat Drive', dur: 0.18, drag: 54, thrust: 58, lift: 38, vel: 2.22, eff: 79, desc: 'The legs sweep up through the body line as the hips drop and the chest rises — the thighs lead and the water starts to fold the knees (about 10°); the upkick gives roughly 30 % of the propulsion.',
             L: { sh: [-173, 2, -13], el: [5], hi: [6, 0, 0], kn: [10.5] }, R: { sh: [-173, -2, 13], el: [5], hi: [6, 0, 0], kn: [10.5] } },
        4: { name: 'Upbeat Peak', dur: 0.17, drag: 56, thrust: 12, lift: 26, vel: 2.24, eff: 76, desc: 'The thighs pass above the body line (hip extension about 12°) with the knees already bent about 22° and still loading — the shins lag the thighs as the wave passes from the hips into the knees; the feet are at their fastest upward speed.',
             L: { sh: [-173, 2, -13], el: [5], hi: [-12, 0, 0], kn: [22] }, R: { sh: [-173, -2, 13], el: [5], hi: [-12, 0, 0], kn: [22] } }
      }
    }
  };
  function deepClone(o) { return JSON.parse(JSON.stringify(o)); }
  var FIELDS = ['sh', 'el', 'hi', 'kn'];
  var PHYS = ['drag', 'thrust', 'lift', 'vel', 'eff'];   // info-panel physics a re-authored phase carries with it
  // Returns a patched deep clone of a STROKES-like object (input untouched). `only` limits to one key.
  function applyPatches(strokes, only) {
    var out = (strokes && typeof strokes === 'object') ? deepClone(strokes) : {};
    for (var key in STROKE_PATCHES) {
      if (!STROKE_PATCHES.hasOwnProperty(key) || !out[key] || typeof out[key] !== 'object') continue;
      if (only && key !== only) continue;
      var P = STROKE_PATCHES[key], sd = out[key];
      if (!sd.phases || !sd.phases.length) continue;          // not a stroke record: leave it as cloned
      if (P.rollAmp !== undefined) sd.rollAmp = P.rollAmp;
      if (P.breath !== undefined) sd.breath = deepClone(P.breath);
      if (P.depth !== undefined) sd.depth = P.depth;          // metres the driver lowers swimmerOrient (0 = the site's default height)
      if (P.rate !== undefined) sd.rate = P.rate;             // tempo multiplier on the page's global clock (technique pass)
      if (P.wave !== undefined) sd.wave = deepClone(P.wave);  // bodyWave() parameters (technique pass)
      if (P.hold !== undefined) sd.hold = !!P.hold;           // eased per-phase lerp (true) or the C1 spline (false) — technique pass 5 (breaststroke re-fix)
      // technique pass 4: extra keyframes appended to the ring (butterfly's 7th `Entry`), only when the record has exactly the phase
      // count the patch was authored for — any other record (an AI motion, a hand-built stub) is left at its own length
      if (P.append && P.append.phases && P.append.phases.length && sd.phases.length === P.append.at) for (var a = 0; a < P.append.phases.length; a++) sd.phases.push(deepClone(P.append.phases[a]));
      var phasePatch = (config.anatomicalElbow && P.phasesAnatomical) ? P.phasesAnatomical : P.phases;
      if (phasePatch) for (var i in phasePatch) {
        if (!phasePatch.hasOwnProperty(i) || !sd.phases[i] || typeof sd.phases[i] !== 'object') continue;
        var pp = phasePatch[i], ph = sd.phases[i];
        if (pp.name !== undefined) ph.name = pp.name;
        if (pp.desc !== undefined) ph.desc = pp.desc;
        if (pp.dur !== undefined) ph.dur = pp.dur;
        // Re-keyed physics travel with the phase (a renamed/re-timed phase must not inherit the old slot's numbers).
        for (var pf = 0; pf < PHYS.length; pf++) if (pp[PHYS[pf]] !== undefined) ph[PHYS[pf]] = pp[PHYS[pf]];
        for (var sIdx = 0; sIdx < 2; sIdx++) {
          var sideKey = sIdx === 0 ? 'L' : 'R';
          if (!pp[sideKey]) continue;
          ph[sideKey] = ph[sideKey] || {};
          for (var f = 0; f < FIELDS.length; f++) if (pp[sideKey][FIELDS[f]]) ph[sideKey][FIELDS[f]] = pp[sideKey][FIELDS[f]].slice();
        }
      }
      sd.patched = true;
    }
    return out;
  }

  var api = {
    VERSION: VERSION,
    config: config,
    stats: stats,
    resetStats: resetStats,
    SHAPES: SHAPES,
    // drop-ins
    applyPose: applyPose, applyLegPose: applyLegPose, applyFlutterKick: applyFlutterKick, applyFlutterKickAnatomical: applyFlutterKickAnatomical,
    // C1 interpolation
    interpolatePhases: interpolatePhases, applyPoseSpline: applyPoseSpline, poseFrame: poseFrame, crWeights: crWeights,
    // body wave (technique pass; optional — the page falls back to its own formula when absent)
    bodyWave: bodyWave,
    // secondary + clearance
    applySecondary: applySecondary, resetSecondary: resetSecondary, armAirWeight: armAirWeight,
    resolveClearance: resolveClearance, measurePenetration: measurePenetration, penetrationDepth: penetrationDepth,
    // patches
    STROKE_PATCHES: STROKE_PATCHES, applyPatches: applyPatches,
    easeInOut: easeInOut
  };
  if (typeof window !== 'undefined') window.TL_HumanMotion = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

/* Tidelyne — procedural human swimmer body (window.TL_Human)
 * Implicit-surface anatomy (tapered elliptical capsules + ellipsoids + rounded boxes, max-blend smooth-min),
 * own marching cubes on a block-sparse grid, weld + Taubin, SDF-derived skin weights, one THREE.SkinnedMesh
 * with material groups (0 skin, 1 suit, 2 cap) + rigid goggles on the head bone.
 * three.js r128 UMD. No top-level THREE access. IIFE, one global.
 */
(function () {
  'use strict';
  var G = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : this);
  var VERSION = '1.5.0';   // round-4: chain prims (nose / jaw / lips / helix), pressed-together fingers + butted toes with surface creases, pointed heel + instep, hybrid LBS/DQS at the shoulders

  // ───────────────────────────── marching-cubes tables (Paul Bourke; identical to three r128 examples) ─────────────────────────────
  var EDGE_TABLE = new Int32Array([0,265,515,778,1030,1295,1541,1804,2060,2309,2575,2822,3082,3331,3593,3840,400,153,915,666,1430,1183,1941,1692,2460,2197,2975,2710,3482,3219,3993,3728,560,825,51,314,1590,1855,1077,1340,2620,2869,2111,2358,3642,3891,3129,3376,928,681,419,170,1958,1711,1445,1196,2988,2725,2479,2214,4010,3747,3497,3232,1120,1385,1635,1898,102,367,613,876,3180,3429,3695,3942,2154,2403,2665,2912,1520,1273,2035,1786,502,255,1013,764,3580,3317,4095,3830,2554,2291,3065,2800,1616,1881,1107,1370,598,863,85,348,3676,3925,3167,3414,2650,2899,2137,2384,1984,1737,1475,1226,966,719,453,204,4044,3781,3535,3270,3018,2755,2505,2240,2240,2505,2755,3018,3270,3535,3781,4044,204,453,719,966,1226,1475,1737,1984,2384,2137,2899,2650,3414,3167,3925,3676,348,85,863,598,1370,1107,1881,1616,2800,3065,2291,2554,3830,4095,3317,3580,764,1013,255,502,1786,2035,1273,1520,2912,2665,2403,2154,3942,3695,3429,3180,876,613,367,102,1898,1635,1385,1120,3232,3497,3747,4010,2214,2479,2725,2988,1196,1445,1711,1958,170,419,681,928,3376,3129,3891,3642,2358,2111,2869,2620,1340,1077,1855,1590,314,51,825,560,3728,3993,3219,3482,2710,2975,2197,2460,1692,1941,1183,1430,666,915,153,400,3840,3593,3331,3082,2822,2575,2309,2060,1804,1541,1295,1030,778,515,265,0]);
  var TRI_TABLE = new Int8Array([-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,0,8,3,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,0,1,9,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,1,8,3,9,8,1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,1,2,10,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,0,8,3,1,2,10,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,9,2,10,0,2,9,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,2,8,3,2,10,8,10,9,8,-1,-1,-1,-1,-1,-1,-1,3,11,2,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,0,11,2,8,11,0,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,1,9,0,2,3,11,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,1,11,2,1,9,11,9,8,11,-1,-1,-1,-1,-1,-1,-1,3,10,1,11,10,3,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,0,10,1,0,8,10,8,11,10,-1,-1,-1,-1,-1,-1,-1,3,9,0,3,11,9,11,10,9,-1,-1,-1,-1,-1,-1,-1,9,8,10,10,8,11,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,4,7,8,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,4,3,0,7,3,4,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,0,1,9,8,4,7,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,4,1,9,4,7,1,7,3,1,-1,-1,-1,-1,-1,-1,-1,1,2,10,8,4,7,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,3,4,7,3,0,4,1,2,10,-1,-1,-1,-1,-1,-1,-1,9,2,10,9,0,2,8,4,7,-1,-1,-1,-1,-1,-1,-1,2,10,9,2,9,7,2,7,3,7,9,4,-1,-1,-1,-1,8,4,7,3,11,2,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,11,4,7,11,2,4,2,0,4,-1,-1,-1,-1,-1,-1,-1,9,0,1,8,4,7,2,3,11,-1,-1,-1,-1,-1,-1,-1,4,7,11,9,4,11,9,11,2,9,2,1,-1,-1,-1,-1,3,10,1,3,11,10,7,8,4,-1,-1,-1,-1,-1,-1,-1,1,11,10,1,4,11,1,0,4,7,11,4,-1,-1,-1,-1,4,7,8,9,0,11,9,11,10,11,0,3,-1,-1,-1,-1,4,7,11,4,11,9,9,11,10,-1,-1,-1,-1,-1,-1,-1,9,5,4,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,9,5,4,0,8,3,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,0,5,4,1,5,0,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,8,5,4,8,3,5,3,1,5,-1,-1,-1,-1,-1,-1,-1,1,2,10,9,5,4,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,3,0,8,1,2,10,4,9,5,-1,-1,-1,-1,-1,-1,-1,5,2,10,5,4,2,4,0,2,-1,-1,-1,-1,-1,-1,-1,2,10,5,3,2,5,3,5,4,3,4,8,-1,-1,-1,-1,9,5,4,2,3,11,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,0,11,2,0,8,11,4,9,5,-1,-1,-1,-1,-1,-1,-1,0,5,4,0,1,5,2,3,11,-1,-1,-1,-1,-1,-1,-1,2,1,5,2,5,8,2,8,11,4,8,5,-1,-1,-1,-1,10,3,11,10,1,3,9,5,4,-1,-1,-1,-1,-1,-1,-1,4,9,5,0,8,1,8,10,1,8,11,10,-1,-1,-1,-1,5,4,0,5,0,11,5,11,10,11,0,3,-1,-1,-1,-1,5,4,8,5,8,10,10,8,11,-1,-1,-1,-1,-1,-1,-1,9,7,8,5,7,9,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,9,3,0,9,5,3,5,7,3,-1,-1,-1,-1,-1,-1,-1,0,7,8,0,1,7,1,5,7,-1,-1,-1,-1,-1,-1,-1,1,5,3,3,5,7,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,9,7,8,9,5,7,10,1,2,-1,-1,-1,-1,-1,-1,-1,10,1,2,9,5,0,5,3,0,5,7,3,-1,-1,-1,-1,8,0,2,8,2,5,8,5,7,10,5,2,-1,-1,-1,-1,2,10,5,2,5,3,3,5,7,-1,-1,-1,-1,-1,-1,-1,7,9,5,7,8,9,3,11,2,-1,-1,-1,-1,-1,-1,-1,9,5,7,9,7,2,9,2,0,2,7,11,-1,-1,-1,-1,2,3,11,0,1,8,1,7,8,1,5,7,-1,-1,-1,-1,11,2,1,11,1,7,7,1,5,-1,-1,-1,-1,-1,-1,-1,9,5,8,8,5,7,10,1,3,10,3,11,-1,-1,-1,-1,5,7,0,5,0,9,7,11,0,1,0,10,11,10,0,-1,11,10,0,11,0,3,10,5,0,8,0,7,5,7,0,-1,11,10,5,7,11,5,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,10,6,5,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,0,8,3,5,10,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,9,0,1,5,10,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,1,8,3,1,9,8,5,10,6,-1,-1,-1,-1,-1,-1,-1,1,6,5,2,6,1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,1,6,5,1,2,6,3,0,8,-1,-1,-1,-1,-1,-1,-1,9,6,5,9,0,6,0,2,6,-1,-1,-1,-1,-1,-1,-1,5,9,8,5,8,2,5,2,6,3,2,8,-1,-1,-1,-1,2,3,11,10,6,5,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,11,0,8,11,2,0,10,6,5,-1,-1,-1,-1,-1,-1,-1,0,1,9,2,3,11,5,10,6,-1,-1,-1,-1,-1,-1,-1,5,10,6,1,9,2,9,11,2,9,8,11,-1,-1,-1,-1,6,3,11,6,5,3,5,1,3,-1,-1,-1,-1,-1,-1,-1,0,8,11,0,11,5,0,5,1,5,11,6,-1,-1,-1,-1,3,11,6,0,3,6,0,6,5,0,5,9,-1,-1,-1,-1,6,5,9,6,9,11,11,9,8,-1,-1,-1,-1,-1,-1,-1,5,10,6,4,7,8,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,4,3,0,4,7,3,6,5,10,-1,-1,-1,-1,-1,-1,-1,1,9,0,5,10,6,8,4,7,-1,-1,-1,-1,-1,-1,-1,10,6,5,1,9,7,1,7,3,7,9,4,-1,-1,-1,-1,6,1,2,6,5,1,4,7,8,-1,-1,-1,-1,-1,-1,-1,1,2,5,5,2,6,3,0,4,3,4,7,-1,-1,-1,-1,8,4,7,9,0,5,0,6,5,0,2,6,-1,-1,-1,-1,7,3,9,7,9,4,3,2,9,5,9,6,2,6,9,-1,3,11,2,7,8,4,10,6,5,-1,-1,-1,-1,-1,-1,-1,5,10,6,4,7,2,4,2,0,2,7,11,-1,-1,-1,-1,0,1,9,4,7,8,2,3,11,5,10,6,-1,-1,-1,-1,9,2,1,9,11,2,9,4,11,7,11,4,5,10,6,-1,8,4,7,3,11,5,3,5,1,5,11,6,-1,-1,-1,-1,5,1,11,5,11,6,1,0,11,7,11,4,0,4,11,-1,0,5,9,0,6,5,0,3,6,11,6,3,8,4,7,-1,6,5,9,6,9,11,4,7,9,7,11,9,-1,-1,-1,-1,10,4,9,6,4,10,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,4,10,6,4,9,10,0,8,3,-1,-1,-1,-1,-1,-1,-1,10,0,1,10,6,0,6,4,0,-1,-1,-1,-1,-1,-1,-1,8,3,1,8,1,6,8,6,4,6,1,10,-1,-1,-1,-1,1,4,9,1,2,4,2,6,4,-1,-1,-1,-1,-1,-1,-1,3,0,8,1,2,9,2,4,9,2,6,4,-1,-1,-1,-1,0,2,4,4,2,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,8,3,2,8,2,4,4,2,6,-1,-1,-1,-1,-1,-1,-1,10,4,9,10,6,4,11,2,3,-1,-1,-1,-1,-1,-1,-1,0,8,2,2,8,11,4,9,10,4,10,6,-1,-1,-1,-1,3,11,2,0,1,6,0,6,4,6,1,10,-1,-1,-1,-1,6,4,1,6,1,10,4,8,1,2,1,11,8,11,1,-1,9,6,4,9,3,6,9,1,3,11,6,3,-1,-1,-1,-1,8,11,1,8,1,0,11,6,1,9,1,4,6,4,1,-1,3,11,6,3,6,0,0,6,4,-1,-1,-1,-1,-1,-1,-1,6,4,8,11,6,8,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,7,10,6,7,8,10,8,9,10,-1,-1,-1,-1,-1,-1,-1,0,7,3,0,10,7,0,9,10,6,7,10,-1,-1,-1,-1,10,6,7,1,10,7,1,7,8,1,8,0,-1,-1,-1,-1,10,6,7,10,7,1,1,7,3,-1,-1,-1,-1,-1,-1,-1,1,2,6,1,6,8,1,8,9,8,6,7,-1,-1,-1,-1,2,6,9,2,9,1,6,7,9,0,9,3,7,3,9,-1,7,8,0,7,0,6,6,0,2,-1,-1,-1,-1,-1,-1,-1,7,3,2,6,7,2,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,2,3,11,10,6,8,10,8,9,8,6,7,-1,-1,-1,-1,2,0,7,2,7,11,0,9,7,6,7,10,9,10,7,-1,1,8,0,1,7,8,1,10,7,6,7,10,2,3,11,-1,11,2,1,11,1,7,10,6,1,6,7,1,-1,-1,-1,-1,8,9,6,8,6,7,9,1,6,11,6,3,1,3,6,-1,0,9,1,11,6,7,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,7,8,0,7,0,6,3,11,0,11,6,0,-1,-1,-1,-1,7,11,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,7,6,11,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,3,0,8,11,7,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,0,1,9,11,7,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,8,1,9,8,3,1,11,7,6,-1,-1,-1,-1,-1,-1,-1,10,1,2,6,11,7,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,1,2,10,3,0,8,6,11,7,-1,-1,-1,-1,-1,-1,-1,2,9,0,2,10,9,6,11,7,-1,-1,-1,-1,-1,-1,-1,6,11,7,2,10,3,10,8,3,10,9,8,-1,-1,-1,-1,7,2,3,6,2,7,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,7,0,8,7,6,0,6,2,0,-1,-1,-1,-1,-1,-1,-1,2,7,6,2,3,7,0,1,9,-1,-1,-1,-1,-1,-1,-1,1,6,2,1,8,6,1,9,8,8,7,6,-1,-1,-1,-1,10,7,6,10,1,7,1,3,7,-1,-1,-1,-1,-1,-1,-1,10,7,6,1,7,10,1,8,7,1,0,8,-1,-1,-1,-1,0,3,7,0,7,10,0,10,9,6,10,7,-1,-1,-1,-1,7,6,10,7,10,8,8,10,9,-1,-1,-1,-1,-1,-1,-1,6,8,4,11,8,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,3,6,11,3,0,6,0,4,6,-1,-1,-1,-1,-1,-1,-1,8,6,11,8,4,6,9,0,1,-1,-1,-1,-1,-1,-1,-1,9,4,6,9,6,3,9,3,1,11,3,6,-1,-1,-1,-1,6,8,4,6,11,8,2,10,1,-1,-1,-1,-1,-1,-1,-1,1,2,10,3,0,11,0,6,11,0,4,6,-1,-1,-1,-1,4,11,8,4,6,11,0,2,9,2,10,9,-1,-1,-1,-1,10,9,3,10,3,2,9,4,3,11,3,6,4,6,3,-1,8,2,3,8,4,2,4,6,2,-1,-1,-1,-1,-1,-1,-1,0,4,2,4,6,2,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,1,9,0,2,3,4,2,4,6,4,3,8,-1,-1,-1,-1,1,9,4,1,4,2,2,4,6,-1,-1,-1,-1,-1,-1,-1,8,1,3,8,6,1,8,4,6,6,10,1,-1,-1,-1,-1,10,1,0,10,0,6,6,0,4,-1,-1,-1,-1,-1,-1,-1,4,6,3,4,3,8,6,10,3,0,3,9,10,9,3,-1,10,9,4,6,10,4,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,4,9,5,7,6,11,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,0,8,3,4,9,5,11,7,6,-1,-1,-1,-1,-1,-1,-1,5,0,1,5,4,0,7,6,11,-1,-1,-1,-1,-1,-1,-1,11,7,6,8,3,4,3,5,4,3,1,5,-1,-1,-1,-1,9,5,4,10,1,2,7,6,11,-1,-1,-1,-1,-1,-1,-1,6,11,7,1,2,10,0,8,3,4,9,5,-1,-1,-1,-1,7,6,11,5,4,10,4,2,10,4,0,2,-1,-1,-1,-1,3,4,8,3,5,4,3,2,5,10,5,2,11,7,6,-1,7,2,3,7,6,2,5,4,9,-1,-1,-1,-1,-1,-1,-1,9,5,4,0,8,6,0,6,2,6,8,7,-1,-1,-1,-1,3,6,2,3,7,6,1,5,0,5,4,0,-1,-1,-1,-1,6,2,8,6,8,7,2,1,8,4,8,5,1,5,8,-1,9,5,4,10,1,6,1,7,6,1,3,7,-1,-1,-1,-1,1,6,10,1,7,6,1,0,7,8,7,0,9,5,4,-1,4,0,10,4,10,5,0,3,10,6,10,7,3,7,10,-1,7,6,10,7,10,8,5,4,10,4,8,10,-1,-1,-1,-1,6,9,5,6,11,9,11,8,9,-1,-1,-1,-1,-1,-1,-1,3,6,11,0,6,3,0,5,6,0,9,5,-1,-1,-1,-1,0,11,8,0,5,11,0,1,5,5,6,11,-1,-1,-1,-1,6,11,3,6,3,5,5,3,1,-1,-1,-1,-1,-1,-1,-1,1,2,10,9,5,11,9,11,8,11,5,6,-1,-1,-1,-1,0,11,3,0,6,11,0,9,6,5,6,9,1,2,10,-1,11,8,5,11,5,6,8,0,5,10,5,2,0,2,5,-1,6,11,3,6,3,5,2,10,3,10,5,3,-1,-1,-1,-1,5,8,9,5,2,8,5,6,2,3,8,2,-1,-1,-1,-1,9,5,6,9,6,0,0,6,2,-1,-1,-1,-1,-1,-1,-1,1,5,8,1,8,0,5,6,8,3,8,2,6,2,8,-1,1,5,6,2,1,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,1,3,6,1,6,10,3,8,6,5,6,9,8,9,6,-1,10,1,0,10,0,6,9,5,0,5,6,0,-1,-1,-1,-1,0,3,8,5,6,10,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,10,5,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,11,5,10,7,5,11,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,11,5,10,11,7,5,8,3,0,-1,-1,-1,-1,-1,-1,-1,5,11,7,5,10,11,1,9,0,-1,-1,-1,-1,-1,-1,-1,10,7,5,10,11,7,9,8,1,8,3,1,-1,-1,-1,-1,11,1,2,11,7,1,7,5,1,-1,-1,-1,-1,-1,-1,-1,0,8,3,1,2,7,1,7,5,7,2,11,-1,-1,-1,-1,9,7,5,9,2,7,9,0,2,2,11,7,-1,-1,-1,-1,7,5,2,7,2,11,5,9,2,3,2,8,9,8,2,-1,2,5,10,2,3,5,3,7,5,-1,-1,-1,-1,-1,-1,-1,8,2,0,8,5,2,8,7,5,10,2,5,-1,-1,-1,-1,9,0,1,5,10,3,5,3,7,3,10,2,-1,-1,-1,-1,9,8,2,9,2,1,8,7,2,10,2,5,7,5,2,-1,1,3,5,3,7,5,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,0,8,7,0,7,1,1,7,5,-1,-1,-1,-1,-1,-1,-1,9,0,3,9,3,5,5,3,7,-1,-1,-1,-1,-1,-1,-1,9,8,7,5,9,7,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,5,8,4,5,10,8,10,11,8,-1,-1,-1,-1,-1,-1,-1,5,0,4,5,11,0,5,10,11,11,3,0,-1,-1,-1,-1,0,1,9,8,4,10,8,10,11,10,4,5,-1,-1,-1,-1,10,11,4,10,4,5,11,3,4,9,4,1,3,1,4,-1,2,5,1,2,8,5,2,11,8,4,5,8,-1,-1,-1,-1,0,4,11,0,11,3,4,5,11,2,11,1,5,1,11,-1,0,2,5,0,5,9,2,11,5,4,5,8,11,8,5,-1,9,4,5,2,11,3,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,2,5,10,3,5,2,3,4,5,3,8,4,-1,-1,-1,-1,5,10,2,5,2,4,4,2,0,-1,-1,-1,-1,-1,-1,-1,3,10,2,3,5,10,3,8,5,4,5,8,0,1,9,-1,5,10,2,5,2,4,1,9,2,9,4,2,-1,-1,-1,-1,8,4,5,8,5,3,3,5,1,-1,-1,-1,-1,-1,-1,-1,0,4,5,1,0,5,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,8,4,5,8,5,3,9,0,5,0,3,5,-1,-1,-1,-1,9,4,5,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,4,11,7,4,9,11,9,10,11,-1,-1,-1,-1,-1,-1,-1,0,8,3,4,9,7,9,11,7,9,10,11,-1,-1,-1,-1,1,10,11,1,11,4,1,4,0,7,4,11,-1,-1,-1,-1,3,1,4,3,4,8,1,10,4,7,4,11,10,11,4,-1,4,11,7,9,11,4,9,2,11,9,1,2,-1,-1,-1,-1,9,7,4,9,11,7,9,1,11,2,11,1,0,8,3,-1,11,7,4,11,4,2,2,4,0,-1,-1,-1,-1,-1,-1,-1,11,7,4,11,4,2,8,3,4,3,2,4,-1,-1,-1,-1,2,9,10,2,7,9,2,3,7,7,4,9,-1,-1,-1,-1,9,10,7,9,7,4,10,2,7,8,7,0,2,0,7,-1,3,7,10,3,10,2,7,4,10,1,10,0,4,0,10,-1,1,10,2,8,7,4,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,4,9,1,4,1,7,7,1,3,-1,-1,-1,-1,-1,-1,-1,4,9,1,4,1,7,0,8,1,8,7,1,-1,-1,-1,-1,4,0,3,7,4,3,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,4,8,7,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,9,10,8,10,11,8,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,3,0,9,3,9,11,11,9,10,-1,-1,-1,-1,-1,-1,-1,0,1,10,0,10,8,8,10,11,-1,-1,-1,-1,-1,-1,-1,3,1,10,11,3,10,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,1,2,11,1,11,9,9,11,8,-1,-1,-1,-1,-1,-1,-1,3,0,9,3,9,11,1,2,9,2,11,9,-1,-1,-1,-1,0,2,11,8,0,11,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,3,2,11,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,2,3,8,2,8,10,10,8,9,-1,-1,-1,-1,-1,-1,-1,9,10,2,0,9,2,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,2,3,8,2,8,10,0,1,8,1,10,8,-1,-1,-1,-1,1,10,2,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,1,3,8,9,1,8,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,0,9,1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,0,3,8,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1]);

  // ───────────────────────────── small math ─────────────────────────────
  var DEG = Math.PI / 180;
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function smoothstep(a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
  function nowMs() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
  function v3(x, y, z) { return [x, y, z]; }
  function vlen(a) { return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); }
  function vnorm(a) { var l = vlen(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  function vsub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function vadd(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function vscale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function vdot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function vcross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  // 3x3 rotation from XYZ euler (degrees), column-major columns = rotated axes; matches THREE 'XYZ'.
  function eulerToAxes(rx, ry, rz) {
    var a = rx * DEG, b = ry * DEG, c = rz * DEG;
    var ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cc = Math.cos(c), sc = Math.sin(c);
    // R = Rx * Ry * Rz
    var m00 = cb * cc, m01 = -cb * sc, m02 = sb;
    var m10 = ca * sc + sa * sb * cc, m11 = ca * cc - sa * sb * sc, m12 = -sa * cb;
    var m20 = sa * sc - ca * sb * cc, m21 = sa * cc + ca * sb * sc, m22 = ca * cb;
    return [[m00, m10, m20], [m01, m11, m21], [m02, m12, m22]]; // columns
  }

  // ───────────────────────────── rig definition (SPEC §1) ─────────────────────────────
  var A_POSE_DEG = 14;           // build/bind pose: shoulders abducted so hands clear the thighs (driver resets to 0)
  var LAP_NEAR_PASSES = 16, LAP_NEAR_RADIUS = 0.085;  // round-4: extra weight-smoothing passes within 8.5 cm of the shoulder joints (step 8b')
  var DQS_LBS_RADIUS = 0.075;    // round-4: linear-blend skinning within this distance of a shoulder joint, dual quaternion beyond +4 cm (assembleRig / DQS_POS)
  var LAP_NEAR_GAMMA = 1.0;      // round-4: arm-vs-torso weight split steepening (w^γ / (w^γ + (1−w)^γ)) within LAP_NEAR_RADIUS (step 8b''); 1 = off — sharpening (γ 2-8) left the armpit-floor lip behind as a pale tongue, diffusion (16 passes) pulls it inside
  var ANKLE_REST = 1.15;         // rad, plantarflexed rest (never touched by the driver)
  var BONE_DEFS = [
    // name, parent, [x,y,z]
    ['hips', null, [0, 0, 0]],
    ['spine', 'hips', [0, 0.10, 0]],
    ['neck', 'spine', [0, 0.42, 0]],
    ['head', 'neck', [0, 0.10, 0.005]],
    ['shoulderL', 'spine', [0.20, 0.36, 0]], ['upperArmL', 'shoulderL', [0, 0, 0]], ['elbowL', 'upperArmL', [0, -0.30, 0]],
    ['forearmL', 'elbowL', [0, 0, 0]], ['wristL', 'forearmL', [0, -0.27, 0]], ['handL', 'wristL', [0, -0.07, 0]],
    ['shoulderR', 'spine', [-0.20, 0.36, 0]], ['upperArmR', 'shoulderR', [0, 0, 0]], ['elbowR', 'upperArmR', [0, -0.30, 0]],
    ['forearmR', 'elbowR', [0, 0, 0]], ['wristR', 'forearmR', [0, -0.27, 0]], ['handR', 'wristR', [0, -0.07, 0]],
    ['hipJL', 'hips', [0.115, -0.10, 0]], ['thighL', 'hipJL', [0, 0, 0]], ['kneeL', 'thighL', [0, -0.40, 0]],
    ['shinL', 'kneeL', [0, 0, 0]], ['ankleL', 'shinL', [0, -0.38, 0]], ['footL', 'ankleL', [0, -0.02, 0.07]],
    ['hipJR', 'hips', [-0.115, -0.10, 0]], ['thighR', 'hipJR', [0, 0, 0]], ['kneeR', 'thighR', [0, -0.40, 0]],
    ['shinR', 'kneeR', [0, 0, 0]], ['ankleR', 'shinR', [0, -0.38, 0]], ['footR', 'ankleR', [0, -0.02, 0.07]],
    // Round-2 (v1.3): forearm TWIST bones, appended after the 28 SPEC §1.2 bones (§9.1 allows helpers after index 27).
    // Zero-length, at the elbow, parented to the forearm; the wrist/hand hang under them (re-parented in makeBones, same
    // positions). Forearm skin weights ramp forearm → twist along the segment, so a pronation written to
    // forearmTwist.rotation.y distributes over the forearm's length like the radius rolling over the ulna — instead of the
    // whole forearm snapping at the elbow (the LBS "candy wrapper" that capped the motion module's twist at 75°).
    ['forearmTwistL', 'forearmL', [0, 0, 0]], ['forearmTwistR', 'forearmR', [0, 0, 0]],
    // Round-3 (v1.4): FINGER bones (SPEC §9.1: "fingers … may be appended after the base bones, identity by default, driven only by
    // TL_HumanMotion"). Children of the hand bone at the MCP joints (hand-local: fingers run −Y, palm normal −Z, thumb −X for the
    // left hand); rotation.z abducts in the palm plane. The rest hand is authored with the fingers TOGETHER and the thumb adducted;
    // the motion module spreads them ≤ 4° only while the palm solver reports pulling. Exposed as rig.armL/R.fingers = [thumb, index…little].
    // Round-4 (v1.5): MCP centres at 18.5 / 18 / 17 mm spacing (fingers pressed together), thumb MCP 3.5 mm closer to the index.
    ['thumbL', 'handL', [-0.0485, -0.028, -0.009]], ['finger0L', 'handL', [-0.0285, -0.055, 0.002]], ['finger1L', 'handL', [-0.0100, -0.055, 0.002]], ['finger2L', 'handL', [0.0080, -0.055, 0.002]], ['finger3L', 'handL', [0.0250, -0.055, 0.002]],
    ['thumbR', 'handR', [0.0485, -0.028, -0.009]], ['finger0R', 'handR', [0.0285, -0.055, 0.002]], ['finger1R', 'handR', [0.0100, -0.055, 0.002]], ['finger2R', 'handR', [-0.0080, -0.055, 0.002]], ['finger3R', 'handR', [-0.0250, -0.055, 0.002]]
  ];
  var BONE_INDEX = {}; BONE_DEFS.forEach(function (d, i) { BONE_INDEX[d[0]] = i; });
  var REPARENT = { wristL: 'forearmTwistL', wristR: 'forearmTwistR' };   // hierarchy overrides (positions unchanged: the twist bone sits at the forearm origin)

  function makeBones(THREE) {
    var bones = [], byName = {};
    BONE_DEFS.forEach(function (d) {
      var b = new THREE.Bone(); b.name = d[0]; b.position.set(d[2][0], d[2][1], d[2][2]);
      bones.push(b); byName[d[0]] = b;
    });
    BONE_DEFS.forEach(function (d) { var par = REPARENT[d[0]] || d[1]; if (par) byName[par].add(byName[d[0]]); });
    byName.ankleL.rotation.x = ANKLE_REST; byName.ankleR.rotation.x = ANKLE_REST;
    return { bones: bones, byName: byName };
  }
  function setBuildPose(byName, on) {
    var a = on ? A_POSE_DEG * DEG : 0;
    byName.shoulderL.rotation.set(0, 0, a); byName.shoulderR.rotation.set(0, 0, -a);
  }
  // plain frames {o, ex, ey, ez} from bone world matrices (build pose)
  function extractFrames(THREE, byName) {
    var root = new THREE.Group(); root.add(byName.hips); setBuildPose(byName, true); root.updateMatrixWorld(true);
    var frames = { body: { o: [0, 0, 0], ex: [1, 0, 0], ey: [0, 1, 0], ez: [0, 0, 1] } };
    Object.keys(byName).forEach(function (n) {
      var e = byName[n].matrixWorld.elements;
      frames[n] = { o: [e[12], e[13], e[14]], ex: [e[0], e[1], e[2]], ey: [e[4], e[5], e[6]], ez: [e[8], e[9], e[10]] };
    });
    root.remove(byName.hips);
    return frames;
  }
  function frameXform(f, p) { return [f.o[0] + p[0] * f.ex[0] + p[1] * f.ey[0] + p[2] * f.ez[0], f.o[1] + p[0] * f.ex[1] + p[1] * f.ey[1] + p[2] * f.ez[1], f.o[2] + p[0] * f.ex[2] + p[1] * f.ey[2] + p[2] * f.ez[2]]; }
  function frameRot(f, v) { return [v[0] * f.ex[0] + v[1] * f.ey[0] + v[2] * f.ez[0], v[0] * f.ex[1] + v[1] * f.ey[1] + v[2] * f.ez[1], v[0] * f.ex[2] + v[1] * f.ey[2] + v[2] * f.ez[2]]; }

  // ───────────────────────────── anatomy (primitive list, LEFT side authored; mirror:true duplicates to the right) ─────────────────────────────
  // prim: {t:'cone'|'ell'|'box'|'sph', frame, k (blend), R (skin falloff), own (ownership), part, sub (subtract), mirror}
  // Ownership: bone name | [[bone,w],…] | {y:[…]} piecewise-by-body-y blend. Frames: 'body' or bone name (rest-local coords).
  function anatomy(sex) {
    var F = sex === 'female';
    var P = [];
    function add(p) { if (p.R === undefined) p.R = clamp(p.k * 2.5, 0.012, 0.05); P.push(p); return p; }
    function cone(frame, a, b, r1, r2, k, own, part, o) { var p = { t: 'cone', frame: frame, a: a, b: b, r1: r1, r2: r2, sx: 1, sz: 1, k: k, own: own, part: part }; if (o) for (var q in o) p[q] = o[q]; return add(p); }
    function ell(frame, c, h, k, own, part, o) { var p = { t: 'ell', frame: frame, c: c, h: h, rot: [0, 0, 0], k: k, own: own, part: part }; if (o) for (var q in o) p[q] = o[q]; return add(p); }
    function box(frame, c, h, rr, k, own, part, o) { var p = { t: 'box', frame: frame, c: c, h: h, rr: rr, rot: [0, 0, 0], k: k, own: own, part: part }; if (o) for (var q in o) p[q] = o[q]; return add(p); }
    function sph(frame, c, r, k, own, part, o) { var p = { t: 'sph', frame: frame, c: c, r: r, k: k, own: own, part: part }; if (o) for (var q in o) p[q] = o[q]; return add(p); }
    // Round-4: `chain` = a polyline capsule (pts[i] with radius rs[i]), the EXACT min of its cone segments. Two overlapping prims
    // always bulge by ≈ k where their surfaces coincide (the smooth-min fillet is a bulge, not a crease, on a convex join), so a jaw
    // authored as body + ramus + chin capsules read as a row of lumps at every joint. One chain has no joints to bulge.
    function chain(frame, pts, rs, k, own, part, o) { var p = { t: 'chain', frame: frame, pts: pts, rs: rs, k: k, own: own, part: part }; if (o) for (var q in o) p[q] = o[q]; return add(p); }
    var M = { mirror: true }, MS = { mirror: true, sub: true }, S = { sub: true }, C = { core: true }, MC = { mirror: true, core: true };
    var TB = { y: [['hips', -9, 0.04], ['spine', 0.19, 9]] };                 // hips below 0.04, spine above 0.19 (SPEC §2.8 / §10.11)
    var NB = { y: [['spine', -9, 0.47], ['neck', 0.53, 0.58], ['head', 0.635, 9]] };
    var sc = F ? 0.9 : 1;   // female: softer muscle bellies
    // Numbers: RESEARCH §A4 (rig-scaled ANSUR athletic subset + elite corrections) and §B landmarks.
    // Rule of thumb used everywhere: a muscle belly protrudes 8-15 mm beyond the underlying core and blends with k ≈ 2-3x that,
    // so it reads as relief on one continuous skin, never as a ball stuck on.

    // ── torso core (4 stacked ellipsoids, wide blends) ──
    ell('body', [0, -0.03, 0.0], F ? [0.156, 0.100, 0.098] : [0.138, 0.100, 0.094], 0.03, TB, 'torso', C);            // pelvis (bicristal 0.253 + soft tissue)
    ell('body', [0, 0.13, 0.008], F ? [0.106, 0.170, 0.082] : [0.117, 0.170, 0.086], 0.022, TB, 'torso', C);           // waist (k 0.022: the k-0.03 fillet with the ribcage gave a 14 mm belly) / abdomen (elite waist/chest ≈ 0.78)
    ell('body', [0, 0.33, -0.002], F ? [0.129, 0.150, 0.094] : [0.137, 0.150, 0.098], 0.03, TB, 'torso', C);           // ribcage (chest breadth 0.271 / depth 0.224)
    ell('body', [0, F ? 0.44 : 0.445, -0.01], F ? [0.143, 0.045, 0.066] : [0.153, 0.05, 0.07], 0.03, TB, 'torso', C);   // shoulder girdle (clavicles/acromia)
    // ── torso surface muscles ──
    // Round-1 review: the torso read as armour (pec slab with a hard lower edge, tiled abs, four back loaves). In this field the
    // smooth-min FILLET is the bulge (a relief prim flush with the core bulges by ≈ k), so relief prims now sit at / 1-3 mm outside
    // the core with k 0.008-0.012 (≤ 10 mm total relief, 4-5 cm blend), subtractors are ≤ 3 mm / 1.5 mm, and the clavicles / ASIS
    // are real landmarks. The V-taper comes from lat WIDTH (bi-lat ≈ 0.36 m at T8), not from lumps.
    // Round-3 review ("torso still armour: pec plate edge, ab tiles, sack-of-potatoes back"): the pec is now TWO overlapping
    // ellipsoids (upper belly + a flatter lower belly) so the inferior border is a gradient, the rectus block / linea alba /
    // intersections are ≤ 2 mm, and every back prim (scapula, scapular spine, erectors, lats, folds) has its k cut to ≈ 0.006 so
    // the back is one continuous plate with ≤ 3 mm relief and the spinal furrow as the single feature.
    if (!F) ell('body', [0.066, 0.356, 0.087], [0.068, 0.046, 0.018], 0.007, 'spine', 'torso', { mirror: true, rot: [0, 0, 8] }); // pectoralis major: ≈ 8 mm proud of the core composite at the nipple line by GEOMETRY, k 0.007 so the lower border tapers over ≈ 3 cm
    if (!F) ell('body', [0.128, 0.365, 0.040], [0.028, 0.034, 0.024], 0.012, [['spine', 0.92], ['upperArmL', 0.08]], 'torso', { mirror: true, bridge: ['armL'], bridgeK: 0.012, R: 0.012 }); // lateral pec / anterior axillary fold (R 0.012: round-3, was 0.08 — see the shoulder note in step 8) — follows the arm 8 % (8 cm falloff) so the chest wall stretches at full flexion without LBS tearing
    else ell('body', [0.064, 0.335, 0.084], [0.056, 0.050, 0.034], 0.012, 'spine', 'torso', M);                                // breast, compressed under the kneeskin (k 0.012: a wider k merged the two into one underbust shelf)
    ell('body', [0.116, 0.30, -0.03], F ? [0.036, 0.11, 0.062] : [0.046, 0.115, 0.068], 0.011, 'spine', 'torso', { mirror: true, rot: [0, 0, 10] }); // latissimus (V-taper from width)
    ell('body', [0.136, 0.345, -0.038], [0.026, 0.038, 0.030], 0.009, [['spine', 0.92], ['upperArmL', 0.08]], 'torso', { mirror: true, bridge: ['armL'], bridgeK: 0.009, R: 0.012 }); // upper lat / posterior axillary fold (8 % arm)
    cone('body', [0.03, F ? 0.515 : 0.522, -0.022], [0.185, F ? 0.472 : 0.476, -0.022], F ? 0.013 : 0.016, F ? 0.010 : 0.012, 0.014, 'spine', 'torso', M); // upper trapezius slope (C7 → acromion)
    // Round-3 (shoulder at 180°) — what did NOT work: an "axillary web" capsule across the armpit floor owned 50/50 by the arm
    // and the spine (the critic's fascia-bridge idea). Any 50 % vertex 5-6 cm below the joint is by construction 5-8 cm away
    // from both rigid predictions at 180° (LBS collapses it onto the joint axis, DQS swings it out 90°), so the web only made
    // the fin bigger (r3-shoulder-lab: max deviation 44 → 91 mm). What works is the opposite: part-aware ownership (skin
    // weights, step 8), a deltoid reach of 5 cm so the trapezius/deltoid seam grades over the cap, and four Laplacian passes
    // on the weights (edges with a > 0.35 arm-weight jump: 120 → 24; those jumps were the stretched, sharp-edged triangles).

    ell('body', [0.068, 0.365, -0.099], [0.050, 0.064, 0.009], 0.006, 'spine', 'torso', { mirror: true, rot: [0, -12, 0] });      // scapula plate / infraspinatus: ON the ribcage surface (was 11 mm inside it → an 11 mm valley between the erectors and the lats)
    cone('body', [0.035, 0.405, -0.088], [0.115, 0.392, -0.084], 0.004, 0.0035, 0.006, 'spine', 'torso', M);                    // scapular spine (a faint ridge, not a crease)
    cone('body', [0.024, 0.0, -0.086], [0.024, 0.40, -0.094], 0.011 * sc, 0.010 * sc, 0.006, TB, 'torso', { mirror: true, sx: 1.7, sz: 0.75 }); // erector spinae: a wide FLAT plate either side of the furrow
    ell('body', [0, 0.16, F ? 0.092 : 0.094], [0.066, 0.115, F ? 0.005 : 0.009], 0.006, 'spine', 'torso');                     // rectus abdominis block: ≈ 3 mm proud of the composite (linea alba + intersections carve it faintly)
    // (round-2: the ASIS knobs are gone — a 14 × 11 × 7 mm ellipsoid with k 0.012 pushed through the +2 mm suit shell as a
    //  round 2 cm "coin" on each hip; under a jammer/kneeskin the landmark is invisible on a real athlete anyway)
    ell('body', [0.082, -0.07, -0.05], F ? [0.078, 0.076, 0.05] : [0.074, 0.072, 0.047], 0.025, [['hips', 0.65], ['hipJL', 0.35]], 'torso', { mirror: true, core: true, bridge: ['legL'] }); // gluteus maximus
    cone('body', [0.018, 0.488, 0.054], [0.175, 0.483, 0.030], 0.010, 0.0085, 0.006, 'spine', 'torso', M);                     // clavicle ridge (round-2: r 10 mm, k 0.006 — legible landmark)
    cone('body', [0, -0.02, -0.104], [0, 0.42, -0.113], 0.006, 0.006, 0.004, 'spine', 'torso', S);                            // spinal furrow (the single back feature, ≈ 5 mm)
    cone('body', [0, 0.05, 0.108], [0, 0.30, 0.114], F ? 0.0018 : 0.002, F ? 0.0018 : 0.002, 0.006, 'spine', 'torso', S);                                // linea alba (≤ 2 mm)
    if (!F) cone('body', [-0.035, 0.235, 0.113], [0.035, 0.235, 0.113], 0.0008, 0.0008, 0.004, 'spine', 'torso', S);                    // tendinous intersection (≈ 0.8 mm — a hint, not a tile edge)
    if (!F) cone('body', [-0.035, 0.165, 0.115], [0.035, 0.165, 0.115], 0.0008, 0.0008, 0.004, 'spine', 'torso', S);                    // tendinous intersection (navel level)
    cone('body', [0, -0.03, -0.13], [0, -0.14, -0.10], 0.008, 0.008, 0.01, 'hips', 'torso', S);                               // gluteal cleft
    ell('body', [0.082, 0.505, 0.034], [0.046, 0.016, 0.030], 0.01, 'spine', 'torso', MS);                                    // supraclavicular hollow (behind the clavicle)
    // ── neck (neck circ 0.361 → r ≈ 0.057; deeper than wide) ──
    // Round-3 review ("bull neck as thick as the skull, chin runs straight into the neck"): the neck cone is r 50 → 46 mm (F 44 → 40),
    // ends 2 cm lower (body 0.572, so its rounded top stays UNDER the jaw line instead of filling the gonial angle) and bridges the
    // head with a tighter k 0.014; the SCM cords are 1 mm thinner. Head breadth 0.15 / depth 0.196 vs neck 0.092 / 0.10.
    cone('body', [0, 0.488, -0.008], [0, 0.566, -0.010], F ? 0.043 : 0.047, F ? 0.039 : 0.043, 0.018, NB, 'neck', { core: true, sz: 1.06, bridge: ['torso', 'head'], bridgeK: 0.014 });
    ell('body', [0, 0.615, -0.054], F ? [0.042, 0.030, 0.040] : [0.044, 0.032, 0.040], 0.015, NB, 'neck', { core: true, bridge: ['torso', 'head'] });   // nuchal region: slopes the occiput into the nape (was a 6 cm shelf)
    cone('body', [0.050, 0.632, -0.034], [0.014, 0.497, 0.044], F ? 0.0045 : 0.0055, F ? 0.004 : 0.005, 0.010, NB, 'neck', { mirror: true, bridge: ['torso', 'head'], bridgeK: 0.008 }); // sternocleidomastoid: mastoid (behind the ear) → sternal notch
    if (!F) ell('body', [0, 0.548, 0.049], [0.010, 0.012, 0.004], 0.008, 'neck', 'neck', { bridge: ['head'] });                                     // thyroid cartilage: a flat 4 mm prominence blended over 3 cm (round-4: the 10 mm k-0.006 ball read as a second chin)
    // ── head (head-bone local: body = local + (0, 0.62, 0.005); crown ≈ local 0.172, chin ≈ -0.055) ──
    var hs = F ? 0.965 : 1;
    ell('head', [0, 0.085, -0.012], [0.072 * hs, 0.086 * hs, 0.088 * hs], 0.008, 'head', 'head', C);                            // cranium (length 0.196, breadth 0.152 — the temporal fullness + fillets add the rest)
    ell('head', [0, 0.094, 0.03], [0.062 * hs, 0.055, 0.052], 0.008, 'head', 'head', C);                                        // frontal bone / forehead
    ell('head', [0, 0.06, -0.070], [0.058, 0.055, 0.034], 0.008, 'head', 'head', C);                                             // occiput
    ell('head', [0.061, 0.07, -0.005], [0.007, 0.03, 0.045], 0.005, 'head', 'head', M);                                      // temporal / parietal fullness
    // Round-1 review (frontal close-up read as a troll): brow ridge −35 %, orbit hollow −40 % depth, cheek mass −50 %, narrower
    // mandible with the gonial angle 2 cm higher, narrower nasal root, mid-face deflated, + philtrum and nasolabial folds.
    // Round-3 review ("nose, lips and ears are floating islands; goggles 2-3 cm off the cheek; beak chin; no jaw in profile"):
    // the mid-face is INFLATED (front at local z ≈ 0.084, was 0.074) with an alveolar base under the lips, the nose is a cone
    // whose root sits inside the brow and whose tip's back edge is 7 mm off the mid-face (k 0.012 bridges it), lips / alae /
    // columella overlap the base with k 0.008-0.010, the ear overlaps the cranium (x 0.066, k 0.012), the mandible is re-authored
    // with a real gonial angle (7 cm below the Frankfort plane) + ramus so the profile has a jaw, chin boss +2 mm forward.
    // Acceptance: union-find components == 2 (skin + cap), asserted in body.test.js.
    cone('head', [0.010, 0.074, 0.085], [0.050, 0.066, 0.070], F ? 0.0045 : 0.0062, F ? 0.004 : 0.0052, 0.008, 'head', 'head', M); // brow ridge (glabella 8-10 mm above the nasion)
    ell('head', [0, 0.076, 0.088], [0.014, 0.010, 0.008], 0.006, 'head', 'head');                                            // glabella (the brow ridges meet on the midline)
    ell('head', [0, 0.059, 0.097], [0.013, 0.007, 0.010], 0.004, 'head', 'head', S);                                          // nasion: the dip between the glabella and the nose root
    ell('head', [0.031, 0.052, 0.086], [0.017, 0.011, 0.0095], 0.004, 'head', 'head', MS);                                   // orbit hollow (under the goggle lens; k 0.004 — a wider k smoothed 10 mm off the nasal bridge and the orbital rim)
    ell('head', [F ? 0.044 : 0.046, F ? 0.038 : 0.037, 0.058], [F ? 0.018 : 0.019, 0.014, 0.024], 0.010, 'head', 'head', M);                          // zygomatic arch / cheekbone (front 0.082)
    ell('head', [0, 0.024, 0.050], [0.040, 0.034, 0.034], 0.008, 'head', 'head', C);                                            // maxilla / mid-face (front 0.084)
    ell('head', [0, -0.012, 0.052], [0.036, 0.024, 0.026], 0.008, 'head', 'head', C);                                           // alveolar arch: the base the lips sit on (front 0.078)
    // Round-4 review ("profile a lumpy potato: nose a formless block, jaw / chin a cluster of lumps, ears bulges without a helix,
    // jowls flaring past the skull from the front"): every capsule PAIR sharing an endpoint bulged by ≈ k at the join (mandible body
    // + ramus + chin boss = three lumps; bridge cone + columella + alae = a block), so the nose and the whole mandible are now ONE
    // `chain` each (exact polyline capsules, no joints to bulge): a straight nasal dorsum from inside the nasion to a 17 mm tip sphere
    // (pronasale ≈ 21 mm proud), 13 mm alae spheres, a columella; one mandible chain condyle → gonion → body → chin → body → gonion →
    // condyle (24 mm chin capsule, pogonion 4 mm behind the lower lip; the labiomental sulcus is the gap between the lip and the chin
    // capsule over the alveolar base — no subtractor). Bigonial 0.115 stays inside the bizygomatic 0.13; the buccal block is 5 mm
    // narrower per side so the lower face never exceeds the cheekbones from the front. Ear: a thinner auricle plate (5 mm proud, the
    // old 7 × 26 × 15 plate flared as a shelf under the cap) + a 7 mm helix rim chain, a concha hollow and a 12 mm lobe.
    ell('head', [0, 0.012, 0.026], [F ? 0.047 : 0.049, 0.032, 0.042], 0.008, 'head', 'head', C);                                // buccal / masseter block: cheeks between the cheekbone and the jaw
    chain('head', [[0, 0.062, 0.0805], [0, 0.040, 0.0915], [0, 0.024, 0.0975]], F ? [0.0045, 0.0050, 0.0058] : [0.0050, 0.0055, 0.0065], 0.006, 'head', 'head'); // nasal dorsum: one straight capsule from inside the nasion to the supratip
    sph('head', [0, 0.019, 0.0965], F ? 0.0078 : 0.0085, 0.006, 'head', 'head');                                              // nose tip (pronasale z ≈ 0.105)
    sph('head', [0.0125, 0.014, 0.0855], F ? 0.0060 : 0.0065, 0.005, 'head', 'head', M);                                     // alae
    ell('head', [0, 0.011, 0.085], [0.005, 0.005, 0.008], 0.005, 'head', 'head');                                            // columella (subnasale y ≈ 0.006)
    cone('head', [0, 0.005, 0.0885], [0, -0.001, 0.0895], 0.002, 0.002, 0.002, 'head', 'head', S);                          // philtrum groove
    var lu = F ? 0.0050 : 0.0045, ll = F ? 0.0052 : 0.0048;
    chain('head', [[-0.021, -0.005, 0.076], [-0.009, -0.0045, 0.0835], [0.009, -0.0045, 0.0835], [0.021, -0.005, 0.076]], [0.003, lu, lu, 0.003], 0.006, 'head', 'head');   // upper lip: follows the dental arch (corners 8 mm back), seated on the alveolar base
    chain('head', [[-0.019, -0.019, 0.076], [-0.008, -0.019, 0.0825], [0.008, -0.019, 0.0825], [0.019, -0.019, 0.076]], [0.003, ll, ll, 0.003], 0.006, 'head', 'head');   // lower lip
    chain('head', [[-0.021, -0.0125, 0.0785], [-0.009, -0.0125, 0.0865], [0.009, -0.0125, 0.0865], [0.021, -0.0125, 0.0785]], [0.002, 0.0025, 0.0025, 0.002], 0.003, 'head', 'head', S);   // mouth line (curved with the lips)
    var jx = F ? 0.94 : 1, jr = F ? 0.92 : 1;
    chain('head', [[-0.050 * jx, 0.038, -0.018], [-0.047 * jx, -0.012, -0.006], [-0.034 * jx, -0.034, 0.036], [-0.013 * jx, -0.045, 0.071], [0.013 * jx, -0.045, 0.071], [0.034 * jx, -0.034, 0.036], [0.047 * jx, -0.012, -0.006], [0.050 * jx, 0.038, -0.018]],
          [0.007 * jr, 0.0105 * jr, 0.0105 * jr, 0.012 * jr, 0.012 * jr, 0.0105 * jr, 0.0105 * jr, 0.007 * jr], 0.007, 'head', 'head');   // mandible: condyle → gonial angle → body → chin → … one curve, both sides
    cone('head', [-0.015, -0.031, 0.0865], [0.015, -0.031, 0.0865], 0.0035, 0.0035, 0.003, 'head', 'head', S);                // labiomental sulcus ≈ 6 mm deep (the fillet would otherwise fill the 9 mm lip-to-chin gap)
    ell('head', [0, -0.028, 0.028], F ? [0.032, 0.010, 0.032] : [0.036, 0.011, 0.034], 0.008, 'head', 'head', C);              // floor of the mouth (between the mandible bodies, above the jaw line)
    ell('head', [F ? 0.059 : 0.061, 0.038, -0.016], [0.005, 0.024, 0.014], 0.005, 'head', 'head', { mirror: true, rot: [-12, 0, 0] });   // auricle plate (pressed under the cap, ≈ 5 mm proud)
    chain('head', [[0.062, 0.050, -0.004], [0.0655, 0.062, -0.013], [0.067, 0.055, -0.027], [0.066, 0.036, -0.031], [0.063, 0.020, -0.025], [0.061, 0.015, -0.015]].map(function (q) { return [q[0] * (F ? 0.97 : 1), q[1], q[2]]; }),
          [0.0035, 0.0035, 0.0035, 0.0035, 0.0035, 0.0035], 0.003, 'head', 'head', M);                                       // helix rim
    sph('head', [F ? 0.059 : 0.061, 0.017, -0.016], 0.006, 0.004, 'head', 'head', M);                                        // lobe
    ell('head', [F ? 0.064 : 0.066, 0.038, -0.017], [0.004, 0.009, 0.007], 0.003, 'head', 'head', MS);                       // concha hollow
    // ── arms (upperArm-local: origin = shoulder joint, -Y down the arm, +X lateral, +Z anterior) ──
    var ua1 = F ? 0.042 : 0.046, ua2 = F ? 0.034 : 0.038;
    // Round-1 review: the arm read as a ring of balls (deltoid / biceps / elbow / forearm with waists between). Within-arm relief
    // prims now sit ≤ 6 mm over the core cone and blend with k 0.028 (an 11 cm fillet range) so the bellies merge into one taper;
    // the deltoid is narrower and bridges into the torso with k 0.02 (a fold, not a ball in a socket).
    // The taper (belly at 35 %, 5 cm radius → 3.8 cm at the elbow) lives in the core's radius PROFILE (exact union of cone
    // segments); the bellies are thin asymmetries (≤ 3 mm over the core, k 0.006) — the smooth-min bulge is what made rings.
    // Round-3 review ("deltoid a ball as big as the head"): −20 % (h 38 × 70 × 50 → 36 × 62 × 41 mm) and k 0.024 → 0.014 (the fillet was
    // half the ball); bideltoid stays ≈ 0.47 because the lateral extent is kept, the DEPTH (profile) drops from ≈ 0.15 to ≈ 0.09.
    ell('upperArmL', [0.005, -0.038, 0.0], F ? [0.033, 0.058, 0.038] : [0.036, 0.062, 0.041], 0.007, 'shoulderL', 'armL', { mirror: true, bridge: ['torso'], bridgeK: 0.012, R: 0.05 });   // deltoid (bideltoid ≈ 0.49); R 0.05: grades the trapezius/deltoid seam over the cap (round-3 shoulder at 180°)
    cone('upperArmL', [0, 0, 0], [0, -0.30, 0], ua1, ua2, 0.012, 'upperArmL', 'armL', { mirror: true, core: true, R: 0.015, sz: 0.95, profile: F ? [[0, 0.036], [0.35, 0.045], [0.7, 0.042], [1, 0.036]] : [[0, 0.040], [0.35, 0.051], [0.7, 0.047], [1, 0.040]] }); // upper arm core (the humeral-head cap is r 0.040: the deltoid, not a 47 mm sphere, makes the shoulder)
    ell('upperArmL', [0.002, -0.150, 0.024], [0.020 * sc, 0.100, 0.024 * sc], 0.006, 'upperArmL', 'armL', M);                 // biceps (≤ 3 mm over the core)
    ell('upperArmL', [0.004, -0.13, -0.024], [0.021 * sc, 0.10, 0.024 * sc], 0.006, 'upperArmL', 'armL', M);                 // triceps
    // Round-3 review ("antecubital crater"): the crater was the k-0.004 olecranon knob, owned 100 % by the elbow bone, rotating out of the
    // upper-arm cap at 98-117° flexion and leaving a rimmed pit. Now a wider, softer knob owned 60/40 elbow/upperArm (its skin
    // stretches instead of swinging), plus a brachialis / distal-biceps filler across the front of the joint so the crease is a
    // fold line, not a valley between the biceps and brachioradialis bellies (anterior dip 5.3 → ≈ 2 mm, r1-body-profile).
    ell('upperArmL', [0, -0.300, -0.024], [0.016, 0.015, 0.010], 0.010, [['elbowL', 0.6], ['upperArmL', 0.4]], 'armL', M);    // olecranon (the epicondyle width comes from the forearm head, sx 1.1)
    ell('upperArmL', [0.002, -0.268, 0.021], [0.022, 0.062, 0.015], 0.006, [['upperArmL', 0.5], ['forearmL', 0.5]], 'armL', M); // brachialis / distal biceps tendon: fills the antecubital valley
    // Forearm ownership ramps forearmL (elbow end) → forearmTwistL (wrist end) by body y in the A-pose (elbow y 0.16, wrist −0.11):
    // full forearm above y 0.11, full twist below −0.05, linear between → a pronation on the twist bone rolls the skin
    // progressively along the segment (v1.3).
    var FT = { y: [['forearmTwistL', -9, -0.05], ['forearmL', 0.11, 9]] };
    cone('forearmL', [0, 0, 0], [0, -0.27, 0], F ? 0.035 : 0.038, F ? 0.025 : 0.027, 0.012, FT, 'armL', { mirror: true, core: true, sx: 1.1, sz: 0.9, profile: F ? [[0, 0.036], [0.25, 0.039], [0.6, 0.031], [1, 0.025]] : [[0, 0.040], [0.25, 0.043], [0.6, 0.034], [1, 0.027]] }); // forearm core
    ell('forearmL', [0.014, -0.075, 0.010], [0.016 * sc, 0.075, 0.017 * sc], 0.006, FT, 'armL', M);                          // brachioradialis / extensors
    ell('forearmL', [-0.010, -0.09, -0.006], [0.016 * sc, 0.08, 0.017 * sc], 0.006, FT, 'armL', M);                          // flexor mass
    ell('forearmL', [0, -0.27, 0], [0.03, 0.03, 0.02], 0.012, 'wristL', 'armL', { mirror: true, bridge: ['handL'] });                                         // wrist / carpus (oval 1.5:1)
    // ── hands (hand-local: origin = wrist - 0.07; palm normal -Z (posterior); thumb medial (-X for the left)) ──
    hand(1); hand(-1);
    function hand(side) {
      var s = F ? 0.95 : 1, t = -1; // thumb side (medial) in LEFT-hand local coords; the mirror handles the right
      var fr = side > 0 ? 'handL' : 'handR', own = fr, part = side > 0 ? 'handL' : 'handR', mx = side > 0 ? 1 : -1;
      function L(p) { return [p[0] * s * mx, p[1] * s, p[2] * s]; }
      var BR = { bridge: [side > 0 ? 'armL' : 'armR'] }, BRC = { bridge: [side > 0 ? 'armL' : 'armR'], core: true };
      // Round-2 review ("starfish, beaded phalanges, slab palm, stub thumb"): fingers are ONE profiled cone each (no bead
      // joins) with ≤ 1 mm PIP/DIP knuckle ridges, relaxed rest spread 3 / 1 / −1 / −3° and a 10° curl toward the palm; the
      // palm is a 15 mm box carrying a thenar eminence (14 × 20 × 9 mm) and a hypothenar ridge on the palm side (−Z) and
      // flat metacarpal heads on the dorsum; the thumb is 8 mm longer with one profiled cone for both phalanges.
      box(fr, L([0, -0.004, 0.001]), [0.040 * s, 0.052 * s, 0.0075 * s], 0.0075 * s, 0.012, own, part, BRC);                     // palm (breadth 0.082, palm length 0.114, 15 mm thick)
      ell(fr, L([0.024 * t, -0.012, -0.008]), [0.014 * s, 0.020 * s, 0.009 * s], 0.006, own, part, BR);                         // thenar eminence (ball of the thumb, palm side)
      ell(fr, L([-0.031 * t, -0.006, -0.006]), [0.010 * s, 0.032 * s, 0.0075 * s], 0.006, own, part, BR);                        // hypothenar ridge (ulnar border, palm side)
      // Round-4 review ("thin tapered sausages with bulbous tips, ~10 mm gaps at 0° spread, a fan in the pull"): the round-3 hand had
      // 1 mm base gaps PLUS full-height groove subtractors (r 2.2 mm) between the fingers — at 5.5 mm voxels every sub-voxel slot
      // becomes a one-voxel notch, Taubin + QEM then shave the digits, so the mesh fingers were 6-9 mm wide with 5-15 mm gaps
      // (r4-digits-probe). Now the fingers are PRESSED TOGETHER: MCP breadths 18 / 18 / 17 / 15 mm at 18.5 / 18 / 17 mm centre spacing
      // (0.5-1 mm base gaps), a monotone taper to 14.4 / 14.6 / 13.8 / 12.4 mm rounded pads (no PIP/DIP swell), and 3.2 / 1.0° convergence
      // so the pads touch (tip gaps ≤ 2 mm, closed by the k 2.5 mm fillet); NO slot subtractors — the valley between two touching
      // elliptic cylinders is the separation. MCP knuckle domes (r 8.5 mm, 4 mm proud of the dorsum). Thumb 20 → 15 mm breadth lying
      // against the index (base overlap 1 mm, tip overlap 1 mm), 9 mm palmar of the finger plane. Female: everything × 0.95
      // (the round-3 profile radii were not scaled for the female — fixed). The motion module spreads the finger bones ≤ 3° in the pull.
      // Separations: touching cylinders alone merge into a flat paddle after MC + Taubin + QEM at 5.5 mm (measured: one ridge per
      // cut), so a SHALLOW groove capsule (r 3.5 mm) lies ON the dorsal surface and another on the palmar surface between adjacent
      // fingers — a 3 mm crease on each face, 8 mm of solid finger between them, never a through-slot.
      var fx = [0.0280, 0.0110, -0.0055, -0.0210], fl = [0.072, 0.078, 0.073, 0.058], fs = [-2.8, -0.9, 0.9, 2.8], curlDeg = 6;
      var frr = [[0.0090, 0.0072], [0.0090, 0.0073], [0.0085, 0.0069], [0.0075, 0.0062]];   // r at the MCP → tip (index, middle, ring, little)
      var fbone = side > 0 ? ['finger0L', 'finger1L', 'finger2L', 'finger3L'] : ['finger0R', 'finger1R', 'finger2R', 'finger3R'];
      var tips = [], fz = 0.78;
      for (var i = 0; i < 4; i++) {
        var x0 = fx[i] * t, len = fl[i], sp = fs[i] * DEG, cu = curlDeg * DEG;
        var dir = [t * Math.sin(sp), -Math.cos(sp) * Math.cos(cu), -Math.sin(cu)];
        var base = [x0, -0.055, 0.002], tip = vadd(base, vscale(dir, len));
        var r0 = frr[i][0] * s, r1 = frr[i][1] * s;
        var fown = [[fbone[i], 0.85], [own, 0.15]];
        tips.push(tip);
        sph(fr, L([x0, -0.052, 0.0045]), 0.0085 * s, 0.004, fown, part);                                                       // MCP knuckle dome (≈ 4 mm proud of the dorsum)
        cone(fr, L(base), L(tip), r0, r1, 0.0012, fbone[i], part, { sz: fz, profile: [[0, r0], [0.42, r0 + (r1 - r0) * 0.36], [0.76, r0 + (r1 - r0) * 0.72], [1, r1]] }); // one monotone finger, rounded pad
        if (i > 0) {
          var rd0 = (frr[i - 1][0] + frr[i][0]) * 0.5 * s * fz, rd1 = (frr[i - 1][1] + frr[i][1]) * 0.5 * s * fz;               // mean half-thickness at the base / tip
          // The creases start 17 mm distal of the MCP line (inside the knuckle domes / palm their axis would sit INSIDE the solid
          // and carve a cavity that breaches as a hole) and stop 8 mm short of the tips, tapering to r 1.5 mm.
          var gx0 = (fx[i - 1] + fx[i]) * 0.5 * t, gx1 = (tips[i - 1][0] + tips[i][0]) * 0.5, gy1 = Math.max(tips[i - 1][1], tips[i][1]) + 0.010, gz1 = (tips[i - 1][2] + tips[i][2]) * 0.5;
          var gA = [gx0 + (gx1 - gx0) * 0.22, -0.072, 0.002 + rd0 - (rd0 - rd1) * 0.22 + 0.0005], gB = [gx1, gy1, gz1 + rd1 + 0.001];
          cone(fr, L(gA), L(gB), 0.0023 * s * s, 0.0014 * s * s, 0.0015, own, part, { sub: true });                           // dorsal crease between the fingers (× s² — the female's thinner fingers holed at 0.95)
          if (i < 3) cone(fr, L([gA[0], gA[1], 0.002 - rd0 + (rd0 - rd1) * 0.22 - 0.0005]), L([gx1, gy1 + 0.006, gz1 - rd1 - 0.001]), 0.0015 * s * s, 0.0010 * s * s, 0.0015, own, part, { sub: true });  // palmar crease (not beside the little finger)
        }
      }
      var tb = side > 0 ? 'thumbL' : 'thumbR';
      var th0 = [0.038 * t, 0.012, -0.006], th1 = [0.0475 * t, -0.028, -0.004], th2 = [0.0405 * t, -0.086, -0.006];            // thumb: CMC → MCP → tip, lying against the index finger IN its plane (9 mm palmar left a keyhole between them)
      cone(fr, L(th0), L(th1), 0.013 * s, 0.0105 * s, 0.009, own, part);                                                        // first metacarpal (inside the thenar)
      cone(fr, L(th1), L(th2), 0.0100 * s, 0.0075 * s, 0.004, tb, part, { sz: 0.85, profile: [[0, 0.0100 * s], [0.45, 0.0091 * s], [1, 0.0075 * s]] }); // proximal + distal phalanx
    }
    // ── legs (thigh-local: origin = hip joint, -Y down, +X lateral, +Z anterior) ──
    cone('thighL', [0, 0, 0], [0, -0.40, 0], F ? 0.084 : 0.084, F ? 0.058 : 0.058, 0.02, 'thighL', 'legL', { mirror: true, core: true, sz: 1.02, R: 0.045, bridge: ['torso'], profile: [[0, 0.085], [0.3, 0.084], [0.72, 0.070], [1, 0.058]] }); // thigh core (Ø 0.174 → 0.119)
    ell('thighL', [0.004, -0.19, 0.052], [0.046 * sc, 0.16, 0.034], 0.008, 'thighL', 'legL', M);                            // quadriceps (rectus femoris): a long low ridge
    ell('thighL', [-0.030, -0.32, 0.030], [0.027, 0.045, 0.025], 0.008, 'thighL', 'legL', M);                               // vastus medialis teardrop
    ell('thighL', [0.052, -0.2, 0.0], [0.030 * sc, 0.14, 0.038], 0.008, 'thighL', 'legL', M);                                // vastus lateralis sweep
    ell('thighL', [0.0, -0.17, -0.046], [0.046, 0.16, 0.040], 0.008, 'thighL', 'legL', { mirror: true, bridge: ['torso'], bridgeK: 0.02 });                  // hamstrings
    ell('thighL', [-0.045, -0.09, 0.0], [0.04, 0.08, 0.05], 0.02, 'hipJL', 'legL', { mirror: true, core: true, bridge: ['torso'] });                                     // adductors (owned by the driven hip joint bone)
    ell('thighL', [0, -0.40, 0.046], [0.023, 0.025, 0.014], 0.01, [['thighL', 0.7], ['kneeL', 0.3]], 'legL', M);          // patella
    ell('thighL', [0, -0.40, -0.004], [0.043, 0.038, 0.046], 0.012, 'kneeL', 'legL', M);                                  // femoral condyles (knee breadth ≈ 10 cm)
    cone('shinL', [0, 0, 0], [0, -0.38, 0], F ? 0.048 : 0.05, F ? 0.029 : 0.03, 0.012, 'shinL', 'legL', { mirror: true, core: true, sx: 1.05, bridge: ['footL'], profile: F ? [[0, 0.048], [0.28, 0.050], [0.6, 0.038], [1, 0.029]] : [[0, 0.050], [0.28, 0.053], [0.6, 0.040], [1, 0.030]] }); // shank core (calf belly at 28 %)
    ell('shinL', [-0.014, -0.12, -0.026], [0.026 * sc, 0.09, 0.028 * sc], 0.006, 'shinL', 'legL', M);                       // gastrocnemius medial head (lower, larger; thin relief)
    ell('shinL', [0.020, -0.10, -0.022], [0.022 * sc, 0.08, 0.025 * sc], 0.006, 'shinL', 'legL', M);                        // gastrocnemius lateral head
    ell('shinL', [0.012, -0.14, 0.032], [0.021, 0.12, 0.017], 0.008, 'shinL', 'legL', M);                                  // tibialis anterior
    cone('shinL', [-0.008, -0.03, 0.045], [-0.012, -0.34, 0.03], 0.007, 0.006, 0.01, 'shinL', 'legL', M);                 // tibial crest
    cone('shinL', [0, -0.24, -0.028], [0, -0.37, -0.032], 0.010, 0.008, 0.008, [['shinL', 0.6], ['ankleL', 0.4]], 'legL', { mirror: true, bridge: ['footL'] }); // Achilles (crisper)
    // Round-3 review ("bulbous ankle"): malleoli halved (6 × 8 × 9 mm), talus block −15 % with a tighter k so the ankle is a joint, not a ball
    // Round-4 review: malleoli 4 × 6 × 7 mm (were 6 × 8 × 9), the talus block a touch lower so the instep is the dorsum's high point
    ell('shinL', [-0.027, -0.375, 0], [0.004, 0.006, 0.007], 0.006, 'ankleL', 'legL', { mirror: true, bridge: ['footL'] });                                 // medial malleolus
    ell('shinL', [0.027, -0.385, 0], [0.004, 0.006, 0.007], 0.006, 'ankleL', 'legL', { mirror: true, bridge: ['footL'] });                                  // lateral malleolus (lower)
    ell('ankleL', [0, -0.018, 0.012], [0.024, 0.020, 0.028], 0.012, 'ankleL', 'legL', { mirror: true, core: true, bridge: ['footL'] });                                 // talus block
    // ── feet (ankle-local: toes +Z, dorsum +Y, medial = -X for the left foot; sole plane ≈ local y -0.06) ──
    // Round-2 review ("mitten with a fused notched toe block, no heel/arch"): a distinct calcaneus behind the ankle, a deeper
    // medial arch, five separate profiled toes (great 9.5 → 7.5 mm, others 6.5 → 4.5 mm) at 2 mm gaps with groove subtractors
    // between them (the voxel grid cannot resolve a 2 mm gap, the grooves draw the separations on the dorsum and at the tips),
    // extensor tendon ridges on the dorsum, and a rounded heel pad.
    foot(1); foot(-1);
    function foot(side) {
      var s = F ? 0.95 : 1, m = -1;
      var fr = side > 0 ? 'ankleL' : 'ankleR', own = side > 0 ? 'footL' : 'footR', part = side > 0 ? 'footL' : 'footR', mx = side > 0 ? 1 : -1;
      var ank = side > 0 ? 'ankleL' : 'ankleR';
      function L(p) { return [p[0] * s * mx, p[1] * s, p[2] * s]; }
      var BRF = { bridge: [side > 0 ? 'legL' : 'legR'] }, BRFC = { bridge: [side > 0 ? 'legL' : 'legR'], core: true };
      // Round-3 review ("tapered sock from a bulbous ankle to a point, fused toe wedge, knuckle blobs from the sole"): calcaneus
      // 26 × 29 × 32 → 21 × 23 × 27 mm at k 0.014 (blends into the heel instead of sitting on it), the foot is 15 mm longer
      // (forefoot centre z 0.095 → 0.108), a dorsal instep ridge from the ankle to the ball, and the toes are authored at REAL
      // breadths (great 22 mm, 16 / 15 / 14 / 13 mm) separated by 3 mm gaps + groove subtractors — at 5.5 mm voxels a 6 mm-wide
      // slot survives as a notch, a 2 mm one did not. Tip undersides all on the sole plane (y −0.058): a flat toe line, not a point.
      // Round-4 review ("five splayed separate digits = a paw; heel + malleoli a knob on top of the ankle; straight dorsum, convex
      // sole"): (1) the 3 mm gaps + tall groove subtractors are gone — at 5.5 mm voxels they made one-voxel slots — the toes are
      // BUTTED (centre spacing = the sum of the radii, tip gaps ≤ 3 mm closed by the k 2 mm fillet) so the forefoot is one closed
      // paddle with five tips and the natural valleys between touching cylinders as the separations; great toe 23 mm wide and 5 mm
      // longer than toe 2, toes 3-5 stepping down 4 mm and dipping 1-3 mm plantar at the tips. (2) With the foot pointed (ankle 1.15 rad)
      // the heel sits BEHIND the calf line: shin-up in ankle coords is (0, 0.41, −0.91), so the calcaneus' extreme along the shin's
      // posterior normal was 84 mm from the axis vs a calf line of ≈ 38 mm — a 4.5 cm knob. Calcaneus 20 × 20 × 25 mm at (−0.028, −0.027)
      // k 0.010 + a flatter heel pad → 57-62 mm (≈ 2 cm proud, blended), like a real pointed foot. (3) Dorsum: a navicular / instep
      // ellipsoid makes the high point 3.5 cm in front of the ankle (+4 mm above the old straight line) and the line to the toes is convex;
      // sole: the midfoot's underside is 4 mm above the heel-pad / ball plane (plantar arch) instead of 6 mm below it.
      ell(fr, L([0, -0.028, -0.026]), [0.020 * s, 0.020 * s, 0.024 * s], 0.010, [[own, 0.7], [ank, 0.3]], part, BRFC);                // calcaneus / heel (5.0 cm behind the ankle axis, 1.9 cm proud of the calf line along its normal)
      ell(fr, L([0, -0.049, -0.016]), [0.021 * s, 0.009 * s, 0.021 * s], 0.008, own, part, BRF);                                     // heel pad (underside on the sole plane −0.058)
      ell(fr, L([0, -0.036, 0.040]), [0.031 * s, 0.018 * s, 0.062 * s], 0.012, own, part, BRFC);                                      // midfoot (underside −0.054: the plantar arch)
      ell(fr, L([m * 0.005, -0.010, 0.040]), [0.024 * s, 0.016 * s, 0.030 * s], 0.010, own, part, BRF);                              // navicular / instep: width under the dorsal line 3-6 cm in front of the ankle (top +6 mm)
      cone(fr, L([m * 0.004, -0.010, 0.030]), L([0, -0.036, 0.112]), 0.016 * s, 0.010 * s, 0.010, own, part, BRF);                   // extensor ridge = the dorsal line: straight from +6 mm (instep) to −26 mm (ball), then the toes drop faster → convex dorsum
      ell(fr, L([0, -0.045, 0.110]), [0.045 * s, 0.013 * s, 0.042 * s], 0.008, own, part, C);                                  // forefoot / ball (breadth 0.090; k 0.008 — the k-0.012 fillet lifted the ball's dorsum 10 mm into a concave step)
      ell(fr, L([m * 0.026, -0.064, 0.036]), [0.028 * s, 0.014 * s, 0.048 * s], 0.008, own, part, { sub: true });           // medial longitudinal arch
      var tx = [0.035, 0.0155, -0.0005, -0.0150, -0.0285], tz0 = 0.134, tl = [0.050, 0.045, 0.041, 0.037, 0.033], drop = [0, 0.001, 0.002, 0.003, 0.003];   // centre spacing = radii sum − 0.5…1.5 mm (butted)
      var trr = [[0.0115, 0.0090], [0.0085, 0.0068], [0.0080, 0.0063], [0.0075, 0.0058], [0.0070, 0.0053]];
      var tsz = 0.82;
      for (var i = 0; i < 5; i++) {
        var r0 = trr[i][0] * s, r1 = trr[i][1] * s;
        var conv = i === 0 ? -0.0015 : (i === 1 ? 0 : 0.001 * (i - 1));                                                            // tips converge toward the 2nd toe
        var a = [m * tx[i], -0.058 + r0 * tsz, tz0], b = [m * (tx[i] + conv), -0.058 + r1 * tsz - drop[i], tz0 + tl[i]];         // undersides on / just under the sole plane
        cone(fr, L(a), L(b), r0, r1, 0.0012, own, part, { sz: tsz, profile: [[0, r0], [0.5, r0 + (r1 - r0) * 0.45], [1, r1]] });
        if (i < 4) {   // shallow dorsal + plantar creases between this toe and the next (on the surfaces, never through the digits)
          // the creases start 8 mm distal of the toe bases (inside the ball's fillet their axis would sit inside the solid and carve a
          // cavity that breaches as a hole) and stop 6 mm short of the shorter tip, tapering to r 1.5 mm
          var gx = m * (tx[i] + tx[i + 1]) * 0.5, gz1 = tz0 + Math.min(tl[i], tl[i + 1]) - 0.006, gyd = -0.058 + (trr[i][0] + trr[i + 1][0]) * s * tsz + 0.0005;
          cone(fr, L([gx, gyd, tz0 + 0.008]), L([gx, gyd - 0.004, gz1]), (i < 3 ? 0.0025 : 0.0018) * s, 0.0015 * s, 0.0015, own, part, { sub: true });   // dorsal crease (shallower beside the little toe)
          if (i < 2) cone(fr, L([gx, -0.0585, tz0 + 0.008]), L([gx, -0.0595, gz1]), 0.0018 * s, 0.0012 * s, 0.0015, own, part, { sub: true });   // plantar crease only beside the two thick toes
        }
        if (i === 0 || i === 1 || i === 3) cone(fr, L([m * tx[i] * 0.35, -0.022, 0.040]), L([m * tx[i], -0.040, tz0 - 0.004]), 0.0025, 0.002, 0.003, own, part); // extensor tendons (EHL, EDL) on the dorsum
      }
    }
    // mirror expansion
    var out = [];
    P.forEach(function (p) {
      out.push(p);
      if (p.mirror) out.push(mirrorPrim(p));
    });
    return out;
  }
  function mirrorName(n) { return n.replace(/([LR])$/, function (m) { return m === 'L' ? 'R' : 'L'; }); }
  function mirrorOwn(o) {
    if (typeof o === 'string') return mirrorName(o);
    if (Array.isArray(o)) return o.map(function (e) { return [mirrorName(e[0]), e[1]]; });
    if (o && o.y) return { y: o.y.map(function (e) { return [mirrorName(e[0]), e[1], e[2]]; }) };
    return o;
  }
  function mirrorPrim(p) {
    var q = {}; for (var k in p) q[k] = p[k];
    q.mirror = false;
    if (p.frame !== 'body') q.frame = mirrorName(p.frame);
    var mp = function (v) { return [-v[0], v[1], v[2]]; };
    if (p.a) { q.a = mp(p.a); q.b = mp(p.b); }
    if (p.pts) q.pts = p.pts.map(mp);
    if (p.c) q.c = mp(p.c);
    if (p.rot) q.rot = [p.rot[0], -p.rot[1], -p.rot[2]];
    q.own = mirrorOwn(p.own);
    q.part = mirrorName(p.part);
    if (p.bridge) q.bridge = p.bridge.map(mirrorName);
    return q;
  }

  // ───────────────────────────── primitive compilation (world space, build pose) ─────────────────────────────
  function compilePrims(defs, frames) {
    var out = [];
    defs.forEach(function (d, idx) {
      var f = frames[d.frame]; if (!f) throw new Error('TL_Human: unknown frame ' + d.frame);
      var p = { id: idx, k: d.k, R: d.R, own: d.own, part: d.part, sub: !!d.sub, core: !!d.core, t: d.t, frameName: d.frame, bridge: null, bk: d.bridgeK !== undefined ? d.bridgeK : d.k };
      if (d.bridge) { p.bridge = {}; d.bridge.forEach(function (n) { p.bridge[n] = 1; }); }
      var aabb;
      if (d.t === 'cone') {
        var A = frameXform(f, d.a), B = frameXform(f, d.b);
        var ba = vsub(B, A), L = vlen(ba); if (L < 1e-6) { L = 1e-6; }
        var ey = vscale(ba, 1 / L);
        var ref = frameRot(f, [1, 0, 0]);
        if (Math.abs(vdot(ref, ey)) > 0.9) ref = frameRot(f, [0, 0, 1]);
        var ex = vnorm(vsub(ref, vscale(ey, vdot(ref, ey))));
        var ez = vcross(ex, ey);
        var rmax = Math.max(d.r1, d.r2);
        if (d.profile) {
          // piecewise-linear radius profile [[t, r], …] along A→B: the limb core is the EXACT union of round-cone segments
          // (min), so a belly + taper reads as one continuous surface — no smooth-min bulge and no valley at the joins.
          var segs = [];
          for (var si = 0; si + 1 < d.profile.length; si++) {
            var t0 = d.profile[si][0], t1 = d.profile[si + 1][0], A0 = vadd(A, vscale(ba, t0)), Lseg = (t1 - t0) * L;
            segs.push(makeConeFn(A0, ex, ey, ez, Lseg, d.profile[si][1], d.profile[si + 1][1], d.sx || 1, d.sz || 1));
            rmax = Math.max(rmax, d.profile[si][1], d.profile[si + 1][1]);
          }
          p.f = (function (fs) { return function (x, y, z) { var m = fs[0](x, y, z); for (var q = 1; q < fs.length; q++) { var v = fs[q](x, y, z); if (v < m) m = v; } return m; }; })(segs);
        } else p.f = makeConeFn(A, ex, ey, ez, L, d.r1, d.r2, d.sx || 1, d.sz || 1);
        var rm = rmax * Math.max(d.sx || 1, d.sz || 1);
        aabb = [Math.min(A[0], B[0]) - rm, Math.min(A[1], B[1]) - rm, Math.min(A[2], B[2]) - rm, Math.max(A[0], B[0]) + rm, Math.max(A[1], B[1]) + rm, Math.max(A[2], B[2]) + rm];
        p.axisA = A; p.axisB = B;
      } else if (d.t === 'chain') {
        // polyline capsule: exact union (min) of round-cone segments pts[i] → pts[i+1] with radii rs[i] → rs[i+1]
        var cs = [], cmin = [1e9, 1e9, 1e9], cmax = [-1e9, -1e9, -1e9], ci, cA, cB, cba, cL, cey, cref, cex, cez, cr, cq;
        for (ci = 0; ci + 1 < d.pts.length; ci++) {
          cA = frameXform(f, d.pts[ci]); cB = frameXform(f, d.pts[ci + 1]);
          cba = vsub(cB, cA); cL = vlen(cba); if (cL < 1e-6) cL = 1e-6;
          cey = vscale(cba, 1 / cL); cref = frameRot(f, [1, 0, 0]); if (Math.abs(vdot(cref, cey)) > 0.9) cref = frameRot(f, [0, 0, 1]);
          cex = vnorm(vsub(cref, vscale(cey, vdot(cref, cey)))); cez = vcross(cex, cey);
          cs.push(makeConeFn(cA, cex, cey, cez, cL, d.rs[ci], d.rs[ci + 1], 1, 1));
          cr = Math.max(d.rs[ci], d.rs[ci + 1]);
          for (cq = 0; cq < 3; cq++) { cmin[cq] = Math.min(cmin[cq], cA[cq] - cr, cB[cq] - cr); cmax[cq] = Math.max(cmax[cq], cA[cq] + cr, cB[cq] + cr); }
        }
        p.f = (function (fs) { return function (x, y, z) { var m = fs[0](x, y, z); for (var q = 1; q < fs.length; q++) { var v = fs[q](x, y, z); if (v < m) m = v; } return m; }; })(cs);
        aabb = [cmin[0], cmin[1], cmin[2], cmax[0], cmax[1], cmax[2]];
        p.centre = frameXform(f, d.pts[Math.floor(d.pts.length / 2)]);
      } else if (d.t === 'ell' || d.t === 'box') {
        var C = frameXform(f, d.c);
        var cols = eulerToAxes(d.rot[0], d.rot[1], d.rot[2]);
        var wx = frameRot(f, cols[0]), wy = frameRot(f, cols[1]), wz = frameRot(f, cols[2]);
        if (d.t === 'ell') p.f = makeEllFn(C, wx, wy, wz, d.h);
        else p.f = makeBoxFn(C, wx, wy, wz, d.h, d.rr);
        var hm = Math.max(d.h[0], d.h[1], d.h[2]) + (d.rr || 0);
        aabb = [C[0] - hm, C[1] - hm, C[2] - hm, C[0] + hm, C[1] + hm, C[2] + hm];
        p.centre = C;
      } else if (d.t === 'sph') {
        var Cs = frameXform(f, d.c);
        p.f = makeSphFn(Cs, d.r);
        aabb = [Cs[0] - d.r, Cs[1] - d.r, Cs[2] - d.r, Cs[0] + d.r, Cs[1] + d.r, Cs[2] + d.r];
        p.centre = Cs;
      }
      p.aabb = aabb;
      out.push(p);
    });
    return out;
  }
  function makeConeFn(A, ex, ey, ez, L, r1, r2, sx, sz) {
    var ax = A[0], ay = A[1], az = A[2];
    var exx = ex[0] / sx, exy = ex[1] / sx, exz = ex[2] / sx;
    var eyx = ey[0], eyy = ey[1], eyz = ey[2];
    var ezx = ez[0] / sz, ezy = ez[1] / sz, ezz = ez[2] / sz;
    var bb = (r1 - r2) / L; if (bb > 0.999) bb = 0.999; if (bb < -0.999) bb = -0.999;
    var aa = Math.sqrt(1 - bb * bb), aL = aa * L, sc = Math.min(sx, sz, 1);
    return function (x, y, z) {
      var px = x - ax, py = y - ay, pz = z - az;
      var qx = px * exx + py * exy + pz * exz, qy = px * eyx + py * eyy + pz * eyz, qz = px * ezx + py * ezy + pz * ezz;
      var rad = Math.sqrt(qx * qx + qz * qz);
      var k = -bb * rad + aa * qy, d;
      if (k < 0) d = Math.sqrt(rad * rad + qy * qy) - r1;
      else if (k > aL) { var yy = qy - L; d = Math.sqrt(rad * rad + yy * yy) - r2; }
      else d = aa * rad + bb * qy - r1;
      return d * sc;
    };
  }
  function makeEllFn(C, wx, wy, wz, h) {
    var cx = C[0], cy = C[1], cz = C[2], hx = h[0], hy = h[1], hz = h[2];
    var ihx = 1 / hx, ihy = 1 / hy, ihz = 1 / hz, ihx2 = ihx * ihx, ihy2 = ihy * ihy, ihz2 = ihz * ihz;
    return function (x, y, z) {
      var px = x - cx, py = y - cy, pz = z - cz;
      var qx = px * wx[0] + py * wx[1] + pz * wx[2], qy = px * wy[0] + py * wy[1] + pz * wy[2], qz = px * wz[0] + py * wz[1] + pz * wz[2];
      var k0 = Math.sqrt(qx * qx * ihx2 + qy * qy * ihy2 + qz * qz * ihz2);
      var k1 = Math.sqrt(qx * qx * ihx2 * ihx2 + qy * qy * ihy2 * ihy2 + qz * qz * ihz2 * ihz2);
      if (k1 < 1e-9) return -Math.min(hx, hy, hz);
      return k0 * (k0 - 1) / k1;
    };
  }
  function makeBoxFn(C, wx, wy, wz, h, rr) {
    var cx = C[0], cy = C[1], cz = C[2], bx = h[0] - rr, by = h[1] - rr, bz = h[2] - rr;
    return function (x, y, z) {
      var px = x - cx, py = y - cy, pz = z - cz;
      var qx = Math.abs(px * wx[0] + py * wx[1] + pz * wx[2]) - bx, qy = Math.abs(px * wy[0] + py * wy[1] + pz * wy[2]) - by, qz = Math.abs(px * wz[0] + py * wz[1] + pz * wz[2]) - bz;
      var mx = qx > 0 ? qx : 0, my = qy > 0 ? qy : 0, mz = qz > 0 ? qz : 0;
      var inner = Math.min(Math.max(qx, qy, qz), 0);
      return Math.sqrt(mx * mx + my * my + mz * mz) + inner - rr;
    };
  }
  function makeSphFn(C, r) {
    var cx = C[0], cy = C[1], cz = C[2];
    return function (x, y, z) { var px = x - cx, py = y - cy, pz = z - cz; return Math.sqrt(px * px + py * py + pz * pz) - r; };
  }

  // Field: max-blend smooth union (never accumulates fillets across many overlapping shapes), then smooth subtractions.
  // list: array of compiled prims (in global order). scratch: Float64Array(len) for distances.
  // Round-3: TWO-LAYER union. Prims flagged `core` (the volumetric base: torso ellipsoids, limb cores, skull, palm, foot bones) are
  // max-blended among themselves first into one continuous composite; relief prims (muscle bellies, nose, lips, toes…) are then
  // max-blended against that composite and each other. Before, the fillet was evaluated only against the single closest prim, so
  // wherever a small-k relief prim became the closest it silently dropped the wide core–core fillet (k 0.03, up to 30 mm): the
  // field jumped by 10-15 mm along the rectus block's outline, the pec's lower border and the scapula edges — the "plate edge",
  // "ab tiles" and "creased back" the reviews kept seeing were discontinuities of the union, not the anatomy.
  function filletK(p, q) {   // fillet radius between two prims, honouring the part/bridge rules (0 = no fillet)
    if (p.part !== q.part) {
      if (!(p.bridge && p.bridge[q.part]) && !(q.bridge && q.bridge[p.part])) return 0;
      return p.bk < q.bk ? p.bk : q.bk;                   // cross-part fillet radius (bridgeK; small on the deltoid → no armpit web)
    }
    return p.k < q.k ? p.k : q.k;
  }
  function evalField(x, y, z, list, dist) {
    var n = list.length, i, p, d, k, h, v;
    var mc = 1e9, ic = -1, mr = 1e9, ir = -1;
    for (i = 0; i < n; i++) {
      p = list[i];
      if (p.sub) { dist[i] = 0; continue; }
      d = p.f(x, y, z); dist[i] = d;
      if (p.core) { if (d < mc) { mc = d; ic = i; } } else if (d < mr) { mr = d; ir = i; }
    }
    if (ic < 0 && ir < 0) return 1e9;
    // 1. core composite: closest-core max-blend over the core prims
    var cp = null, dCore = 1e9;
    if (ic >= 0) {
      cp = list[ic]; var dipC = 0;
      for (i = 0; i < n; i++) {
        if (i === ic) continue; p = list[i]; if (p.sub || !p.core) continue;
        k = filletK(p, cp); if (k <= 0) continue;
        h = 1 - Math.abs(dist[i] - mc) / (4 * k);
        if (h > 0) { v = h * h * k; if (v > dipC) dipC = v; }
      }
      dCore = mc - dipC;
    }
    // 2. relief: the base is the closer of the composite and the closest relief prim; fillets against everything else
    var base, m, dip = 0, coreBase;
    if (ir < 0 || dCore <= mr) { base = cp; m = dCore; coreBase = true; } else { base = list[ir]; m = mr; coreBase = false; }
    for (i = 0; i < n; i++) {
      p = list[i]; if (p.sub || p.core) continue; if (!coreBase && i === ir) continue;
      k = filletK(p, base); if (k <= 0) continue;
      h = 1 - Math.abs(dist[i] - m) / (4 * k);
      if (h > 0) { v = h * h * k; if (v > dip) dip = v; }
    }
    if (!coreBase && cp) {   // the relief base fillets with the core composite (as one virtual prim carrying the closest core's part/k)
      k = filletK(cp, base);
      if (k > 0) { h = 1 - Math.abs(dCore - m) / (4 * k); if (h > 0) { v = h * h * k; if (v > dip) dip = v; } }
    }
    d = m - dip;
    for (i = 0; i < n; i++) {
      p = list[i]; if (!p.sub) continue;
      var s = p.f(x, y, z), kk = p.k;
      // smooth subtraction of s from d: -smin(-d, s, k) = smoothed max(d, -s)  (b = +s; b = -s would be an intersection)
      var a = -d, b = s, hh = 1 - Math.abs(a - b) / (4 * kk);
      var r = (a < b ? a : b) - (hh > 0 ? hh * hh * kk : 0);
      d = -r;
    }
    return d;
  }

  // ───────────────────────────── grid / blocks / marching cubes ─────────────────────────────
  // Round-2: high samples at 5.5 mm (was 7) — fingers/toes/face are the limit of the field resolution; QEM brings it back to the
  // same shipped budget (≈ 2× the field cost: ~1.1 s in node).
  var QUALITY = { high: { voxel: 0.0055, taubin: 3, target: 52000 }, medium: { voxel: 0.0105, taubin: 3, target: 19500 }, low: { voxel: 0.0145, taubin: 2, target: 7000 } };

  function makeGrid(prims, voxel) {
    var mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9], kmax = 0;
    prims.forEach(function (p) { if (p.sub) return; for (var i = 0; i < 3; i++) { if (p.aabb[i] < mn[i]) mn[i] = p.aabb[i]; if (p.aabb[i + 3] > mx[i]) mx[i] = p.aabb[i + 3]; } if (p.k > kmax) kmax = p.k; });
    var pad = kmax + 3 * voxel;
    var halfX = Math.ceil((Math.max(-mn[0], mx[0]) + pad) / voxel);           // x = 0 is a sample plane → mirror-symmetric sampling
    var o = [-halfX * voxel, mn[1] - pad, mn[2] - pad];
    var n = [2 * halfX + 1, Math.ceil((mx[1] + pad - o[1]) / voxel) + 1, Math.ceil((mx[2] + pad - o[2]) / voxel) + 1];
    return { o: o, h: voxel, n: n, kmax: kmax };
  }

  var B = 4; // block size in voxels
  function buildBlocks(grid, prims) {
    var n = grid.n, h = grid.h, o = grid.o;
    var nb = [Math.ceil((n[0] - 1) / B), Math.ceil((n[1] - 1) / B), Math.ceil((n[2] - 1) / B)];
    var blocks = new Array(nb[0] * nb[1] * nb[2]);
    var margin0 = B * h * 0.87 + 1.5 * h;
    // Round-3 (build time): two prim lists per block. The FIELD list only needs prims that can be the closest surface or a fillet
    // partner inside the block (reach 4k + the activation margin); the WEIGHT list needs the skin-falloff reach R. One list with
    // max(R, 0.05) for both made every field sample visit ~35 % more primitives than it had to.
    var expF = prims.map(function (p) { return 4 * p.k + margin0 + grid.kmax + h; });
    var expW = prims.map(function (p) { return (p.R || 0) + margin0 + h; });
    var bh = B * h, bx, by, bz, i;
    for (bz = 0; bz < nb[2]; bz++) for (by = 0; by < nb[1]; by++) for (bx = 0; bx < nb[0]; bx++) {
      var x0 = o[0] + bx * bh, y0 = o[1] + by * bh, z0 = o[2] + bz * bh;
      blocks[(bz * nb[1] + by) * nb[0] + bx] = { i0: bx * B, j0: by * B, k0: bz * B, list: [], wlist: [], active: false, margin: margin0, cx: x0 + bh / 2, cy: y0 + bh / 2, cz: z0 + bh / 2 };
    }
    // Round-3 (build time): scatter each prim into the blocks its expanded AABB covers (O(prims × covered blocks)) instead of testing
    // every prim against every block (60 k blocks × 200 prims = 12 M AABB tests ≈ 100 ms of the 'setup' stage).
    function scatter(i, e, field) {
      var a = prims[i].aabb;
      var ix0 = Math.max(0, Math.floor((a[0] - e - o[0]) / bh)), ix1 = Math.min(nb[0] - 1, Math.floor((a[3] + e - o[0]) / bh));
      var iy0 = Math.max(0, Math.floor((a[1] - e - o[1]) / bh)), iy1 = Math.min(nb[1] - 1, Math.floor((a[4] + e - o[1]) / bh));
      var iz0 = Math.max(0, Math.floor((a[2] - e - o[2]) / bh)), iz1 = Math.min(nb[2] - 1, Math.floor((a[5] + e - o[2]) / bh));
      for (var z = iz0; z <= iz1; z++) for (var y = iy0; y <= iy1; y++) for (var x = ix0; x <= ix1; x++) {
        var bl = blocks[(z * nb[1] + y) * nb[0] + x];
        if (field) { bl.list.push(prims[i]); if (!prims[i].sub && prims[i].k > bl.km) bl.km = prims[i].k; } else bl.wlist.push(prims[i]);
      }
    }
    for (i = 0; i < blocks.length; i++) blocks[i].km = 0;
    for (i = 0; i < prims.length; i++) { scatter(i, expF[i], true); if (!prims[i].sub) scatter(i, expW[i], false); }
    for (i = 0; i < blocks.length; i++) { blocks[i].margin = margin0 + blocks[i].km; delete blocks[i].km; }
    return { nb: nb, blocks: blocks };
  }

  // ───────────────────────────── the pipeline (generator: yields {p, stage} for async chunking) ─────────────────────────────
  function* pipeline(THREE, opts, out) {
    var t0 = nowMs(), tl = t0;
    var sex = opts.sex === 'female' ? 'female' : 'male';
    var q = Object.prototype.hasOwnProperty.call(QUALITY, opts.quality) ? QUALITY[opts.quality] : QUALITY.medium;
    var voxel = (typeof opts.voxel === 'number' && isFinite(opts.voxel)) ? clamp(opts.voxel, 0.005, 0.03) : q.voxel;
    var timings = out.timings = {};
    function lap(name) { var t = nowMs(); timings[name] = Math.round(t - tl); tl = t; }

    // 1. skeleton + frames + primitives
    var sk = makeBones(THREE);
    var frames = extractFrames(THREE, sk.byName);
    var defs = anatomy(sex);
    var prims = compilePrims(defs, frames);
    var grid = makeGrid(prims, voxel);
    var blk = buildBlocks(grid, prims);
    var nx = grid.n[0], ny = grid.n[1], nz = grid.n[2], h = grid.h, ox = grid.o[0], oy = grid.o[1], oz = grid.o[2];
    lap('setup');
    yield { p: 0.05, stage: 'anatomy' };

    // 2. coarse activation
    var scratch = new Float64Array(prims.length), scratchP = new Float64Array(prims.length);
    var blocks = blk.blocks, nActive = 0;
    for (var b = 0; b < blocks.length; b++) {
      var bl = blocks[b]; if (bl.list.length === 0) continue;
      var dc = evalField(bl.cx, bl.cy, bl.cz, bl.list, scratch);
      // outside: the field is a lower bound of the true distance → exact test; inside: ellipsoid/smin fields overestimate |d| → 2x margin
      if (dc < bl.margin && -dc < 2 * bl.margin) { bl.active = true; nActive++; }
    }
    lap('coarse');
    yield { p: 0.10, stage: 'coarse field' };

    // 3. fine field on active blocks (+1 halo)
    var field = new Float32Array(nx * ny * nz); field.fill(1);
    var seen = new Uint8Array(nx * ny * nz);
    var done = 0, tChunk = nowMs();
    for (b = 0; b < blocks.length; b++) {
      bl = blocks[b]; if (!bl.active) continue;
      var list = bl.list;
      var i1 = Math.min(bl.i0 + B, nx - 1), j1 = Math.min(bl.j0 + B, ny - 1), k1 = Math.min(bl.k0 + B, nz - 1);
      for (var k = bl.k0; k <= k1; k++) for (var j = bl.j0; j <= j1; j++) for (var i = bl.i0; i <= i1; i++) {
        var idx = (i * ny + j) * nz + k;
        if (seen[idx]) continue; seen[idx] = 1;
        var fv0 = evalField(ox + i * h, oy + j * h, oz + k * h, list, scratch);
        if (fv0 > -1e-7 && fv0 < 1e-7) fv0 = 1e-7;   // a sample exactly on the surface would put two MC vertices on one corner → zero-area triangles
        field[idx] = fv0;
      }
      done++;
      if (nowMs() - tChunk > 40) { tChunk = nowMs(); yield { p: 0.10 + 0.35 * done / nActive, stage: 'sampling field' }; }
    }
    lap('field');
    yield { p: 0.45, stage: 'field sampled' };

    // 4. marching cubes over active blocks with global edge welding
    var edgeVert = new Int32Array(nx * ny * nz * 3); edgeVert.fill(-1);
    var pos = [], tris = [];
    var cornerOff = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
    var edgeC = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    // edge -> (corner index of its min corner, axis)
    var edgeAxis = [0, 1, 0, 1, 0, 1, 0, 1, 2, 2, 2, 2], edgeBase = [0, 1, 3, 0, 4, 5, 7, 4, 0, 1, 2, 3];
    var cidx = new Int32Array(8), cd = new Float64Array(8), ev = new Int32Array(12);
    done = 0; tChunk = nowMs();
    for (b = 0; b < blocks.length; b++) {
      bl = blocks[b]; if (!bl.active) continue;
      i1 = Math.min(bl.i0 + B, nx - 1); j1 = Math.min(bl.j0 + B, ny - 1); k1 = Math.min(bl.k0 + B, nz - 1);
      for (k = bl.k0; k < k1; k++) for (j = bl.j0; j < j1; j++) for (i = bl.i0; i < i1; i++) {
        var cube = 0, ok = true;
        for (var c = 0; c < 8; c++) {
          var ii = i + cornerOff[c][0], jj = j + cornerOff[c][1], kk = k + cornerOff[c][2];
          var id = (ii * ny + jj) * nz + kk;
          if (!seen[id]) { ok = false; break; }
          cidx[c] = id; cd[c] = field[id];
          if (cd[c] < 0) cube |= (1 << c);
        }
        if (!ok || cube === 0 || cube === 255) continue;
        var bits = EDGE_TABLE[cube]; if (bits === 0) continue;
        for (var e = 0; e < 12; e++) {
          if (!(bits & (1 << e))) continue;
          var cb = edgeBase[e], ax = edgeAxis[e];
          var key = cidx[cb] * 3 + ax;
          var vi = edgeVert[key];
          if (vi < 0) {
            var ca = edgeC[e][0], cb2 = edgeC[e][1];
            var d1 = cd[ca], d2 = cd[cb2];
            var t = d1 / (d1 - d2); if (!(t >= 0)) t = 0; if (t > 1) t = 1;
            var pa = cornerOff[ca], pb = cornerOff[cb2];
            vi = pos.length / 3;
            pos.push(ox + (i + pa[0] + (pb[0] - pa[0]) * t) * h, oy + (j + pa[1] + (pb[1] - pa[1]) * t) * h, oz + (k + pa[2] + (pb[2] - pa[2]) * t) * h);
            edgeVert[key] = vi;
          }
          ev[e] = vi;
        }
        var tb = cube * 16;
        for (var ti = 0; ti < 16; ti += 3) {
          var e0 = TRI_TABLE[tb + ti]; if (e0 < 0) break;
          var a0 = ev[e0], a1 = ev[TRI_TABLE[tb + ti + 1]], a2 = ev[TRI_TABLE[tb + ti + 2]];
          if (a0 === a1 || a1 === a2 || a0 === a2) continue;
          tris.push(a0, a1, a2);
        }
      }
      done++;
      if (nowMs() - tChunk > 40) { tChunk = nowMs(); yield { p: 0.45 + 0.2 * done / nActive, stage: 'polygonising' }; }
    }
    edgeVert = null; field = null; seen = null;
    var nv = pos.length / 3, nt = tris.length / 3;
    var P = new Float32Array(pos), I = new Uint32Array(tris); pos = null; tris = null;
    lap('mc');
    yield { p: 0.66, stage: 'polygonised' };

    // 5. orientation check (face normal vs field gradient) → flip if needed
    {
      var agree = 0, tested = 0, all = prims;
      var full = all, sc2 = new Float64Array(all.length);
      for (var s = 0; s < nt && tested < 60; s += Math.max(1, (nt / 60) | 0)) {
        var A0 = I[s * 3] * 3, A1 = I[s * 3 + 1] * 3, A2 = I[s * 3 + 2] * 3;
        var cx = (P[A0] + P[A1] + P[A2]) / 3, cy = (P[A0 + 1] + P[A1 + 1] + P[A2 + 1]) / 3, cz = (P[A0 + 2] + P[A1 + 2] + P[A2 + 2]) / 3;
        var ux = P[A1] - P[A0], uy = P[A1 + 1] - P[A0 + 1], uz = P[A1 + 2] - P[A0 + 2], vx = P[A2] - P[A0], vy = P[A2 + 1] - P[A0 + 1], vz = P[A2 + 2] - P[A0 + 2];
        var nxx = uy * vz - uz * vy, nyy = uz * vx - ux * vz, nzz = ux * vy - uy * vx;
        var eps = h * 0.5;
        var gx = evalField(cx + eps, cy, cz, full, sc2) - evalField(cx - eps, cy, cz, full, sc2);
        var gy = evalField(cx, cy + eps, cz, full, sc2) - evalField(cx, cy - eps, cz, full, sc2);
        var gz = evalField(cx, cy, cz + eps, full, sc2) - evalField(cx, cy, cz - eps, full, sc2);
        var dp = nxx * gx + nyy * gy + nzz * gz;
        if (Math.abs(dp) > 1e-12) { tested++; if (dp > 0) agree++; }
      }
      if (agree < tested / 2) { for (s = 0; s < nt; s++) { var tmp = I[s * 3 + 1]; I[s * 3 + 1] = I[s * 3 + 2]; I[s * 3 + 2] = tmp; } }
      out.flipped = agree < tested / 2;
    }

    // 6. adjacency + Taubin smoothing
    var deg = new Int32Array(nv), t3;
    for (t3 = 0; t3 < nt * 3; t3 += 3) { deg[I[t3]] += 2; deg[I[t3 + 1]] += 2; deg[I[t3 + 2]] += 2; }
    var off = new Int32Array(nv + 1); for (var vv = 0; vv < nv; vv++) off[vv + 1] = off[vv] + deg[vv];
    var adj = new Int32Array(off[nv]), fill = new Int32Array(nv);
    for (t3 = 0; t3 < nt * 3; t3 += 3) {
      var x0 = I[t3], x1 = I[t3 + 1], x2 = I[t3 + 2];
      adj[off[x0] + fill[x0]++] = x1; adj[off[x0] + fill[x0]++] = x2;
      adj[off[x1] + fill[x1]++] = x0; adj[off[x1] + fill[x1]++] = x2;
      adj[off[x2] + fill[x2]++] = x0; adj[off[x2] + fill[x2]++] = x1;
    }
    var P2 = new Float32Array(nv * 3);
    function laplacePass(lambda) {
      for (var v = 0; v < nv; v++) {
        var a = off[v], bnd = off[v + 1], cnt = bnd - a;
        if (cnt === 0) { P2[v * 3] = P[v * 3]; P2[v * 3 + 1] = P[v * 3 + 1]; P2[v * 3 + 2] = P[v * 3 + 2]; continue; }
        var sx = 0, sy = 0, sz = 0;
        for (var e = a; e < bnd; e++) { var w = adj[e] * 3; sx += P[w]; sy += P[w + 1]; sz += P[w + 2]; }
        var v3i = v * 3;
        P2[v3i] = P[v3i] + lambda * (sx / cnt - P[v3i]);
        P2[v3i + 1] = P[v3i + 1] + lambda * (sy / cnt - P[v3i + 1]);
        P2[v3i + 2] = P[v3i + 2] + lambda * (sz / cnt - P[v3i + 2]);
      }
      var tmpP = P; P = P2; P2 = tmpP;
    }
    var nTaubin = (typeof opts.taubin === 'number' && isFinite(opts.taubin)) ? clamp(Math.round(opts.taubin), 0, 10) : q.taubin;
    for (var it = 0; it < nTaubin; it++) { laplacePass(0.5); laplacePass(-0.53); }
    P2 = null;
    lap('smooth');
    yield { p: 0.68, stage: 'smoothed' };

    // 6b. QEM decimation to the quality's triangle budget (positions only; everything below is recomputed from positions)
    var target = (typeof opts.targetTris === 'number' && isFinite(opts.targetTris) && opts.targetTris >= 1000) ? Math.floor(opts.targetTris) : q.target;
    if (target && nt > target) {
      var dec = yield* decimateGen(P, I, nv, nt, target, function (f) { return { p: 0.68 + 0.06 * f, stage: 'decimating' }; });
      P = dec.P; I = dec.I; nv = dec.nv; nt = dec.nt; out.collapses = dec.collapses;
      lap('decimate');
      yield { p: 0.74, stage: 'decimated' };
    }
    // 6c. drop degenerate triangles (repeated index or ~zero area: MC emits them when a corner sample sits exactly on the
    //     iso-surface, and decimation keeps what it inherits). Everything below is recomputed from P/I.
    {
      var keep = new Uint32Array(nt * 3), kn = 0, dropped = 0, aMin = 1e-6 * h * h;
      for (t3 = 0; t3 < nt * 3; t3 += 3) {
        var ka = I[t3], kb = I[t3 + 1], kc = I[t3 + 2];
        if (ka === kb || kb === kc || ka === kc) { dropped++; continue; }
        var kax = P[ka * 3], kay = P[ka * 3 + 1], kaz = P[ka * 3 + 2];
        var k1x = P[kb * 3] - kax, k1y = P[kb * 3 + 1] - kay, k1z = P[kb * 3 + 2] - kaz, k2x = P[kc * 3] - kax, k2y = P[kc * 3 + 1] - kay, k2z = P[kc * 3 + 2] - kaz;
        var knx = k1y * k2z - k1z * k2y, kny = k1z * k2x - k1x * k2z, knz = k1x * k2y - k1y * k2x;
        if (0.5 * Math.sqrt(knx * knx + kny * kny + knz * knz) < aMin) { dropped++; continue; }
        keep[kn++] = ka; keep[kn++] = kb; keep[kn++] = kc;
      }
      if (dropped) { I = keep.subarray(0, kn); nt = kn / 3; }
      out.droppedDegenerate = dropped;
    }
    // 6d. drop ISLANDS: connected components of fewer than 40 vertices are marching-cubes crumbs (a toe or finger tip narrower
    //     than a coarse voxel, a 5.5 mm slot that closed) — the round-3 review counted them as "floating debris". One surface
    //     (+ the cap shell, which is split from it later) is guaranteed at every quality; the goggles are separate meshes.
    {
      var par = new Int32Array(nv), cmp, root2, sizes;
      for (t3 = 0; t3 < nv; t3++) par[t3] = t3;
      function uf(a) { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; }
      for (t3 = 0; t3 < nt * 3; t3 += 3) { var ra = uf(I[t3]), rb = uf(I[t3 + 1]), rc = uf(I[t3 + 2]); if (ra !== rb) par[ra] = rb; rb = uf(rb); if (rb !== rc) par[rb] = rc; }
      sizes = new Int32Array(nv);
      for (t3 = 0; t3 < nv; t3++) sizes[uf(t3)]++;
      var keep2 = new Uint32Array(nt * 3), kn3 = 0, droppedIsl = 0, mainSize = 0;
      for (t3 = 0; t3 < nv; t3++) if (sizes[t3] > mainSize) mainSize = sizes[t3];
      var minSize = Math.max(40, Math.round(mainSize * 0.002));
      for (t3 = 0; t3 < nt * 3; t3 += 3) { if (sizes[uf(I[t3])] < minSize) { droppedIsl++; continue; } keep2[kn3++] = I[t3]; keep2[kn3++] = I[t3 + 1]; keep2[kn3++] = I[t3 + 2]; }
      if (droppedIsl) { I = keep2.subarray(0, kn3); nt = kn3 / 3; }
      out.droppedIslands = droppedIsl;
    }

    // 7. normals
    var N = new Float32Array(nv * 3);
    for (t3 = 0; t3 < nt * 3; t3 += 3) {
      var ia = I[t3] * 3, ib = I[t3 + 1] * 3, ic = I[t3 + 2] * 3;
      var e1x = P[ib] - P[ia], e1y = P[ib + 1] - P[ia + 1], e1z = P[ib + 2] - P[ia + 2];
      var e2x = P[ic] - P[ia], e2y = P[ic + 1] - P[ia + 1], e2z = P[ic + 2] - P[ia + 2];
      var fx = e1y * e2z - e1z * e2y, fy = e1z * e2x - e1x * e2z, fz = e1x * e2y - e1y * e2x;
      N[ia] += fx; N[ia + 1] += fy; N[ia + 2] += fz; N[ib] += fx; N[ib + 1] += fy; N[ib + 2] += fz; N[ic] += fx; N[ic + 1] += fy; N[ic + 2] += fz;
    }
    for (vv = 0; vv < nv * 3; vv += 3) { var l = Math.sqrt(N[vv] * N[vv] + N[vv + 1] * N[vv + 1] + N[vv + 2] * N[vv + 2]) || 1; N[vv] /= l; N[vv + 1] /= l; N[vv + 2] /= l; }

    // 8. skin weights from primitive proximity (SDF ownership): raw weight per prim = (1 - smoothstep(0, R, d))², mapped to the
    //    owning bones; then two Laplacian passes over the mesh (removes one-voxel weight jumps at creases such as the armpit),
    //    then top-4 + normalise. Per-vertex part id (closest prim) drives the UV parametrisation and the suit region.
    var nb = BONE_DEFS.length;
    var SI = new Uint16Array(nv * 4), SW = new Float32Array(nv * 4), DOM = new Uint8Array(nv);
    var wacc = new Float64Array(nb), WD = new Float32Array(nv * nb);
    var nbx = blk.nb[0], nby = blk.nb[1], nbz = blk.nb[2];
    var partIds = {}, partList = [];
    prims.forEach(function (p) { if (!(p.part in partIds)) { partIds[p.part] = partList.length; partList.push(p.part); } });
    var VPART = new Uint8Array(nv);
    tChunk = nowMs();
    for (vv = 0; vv < nv; vv++) {
      var x = P[vv * 3], y = P[vv * 3 + 1], z = P[vv * 3 + 2];
      var bi = clamp(((x - ox) / h / B) | 0, 0, nbx - 1), bj = clamp(((y - oy) / h / B) | 0, 0, nby - 1), bk = clamp(((z - oz) / h / B) | 0, 0, nbz - 1);
      var blkW = blocks[(bk * nby + bj) * nbx + bi], lst = blkW.wlist;
      var best = 1e9, bestP = null, n2 = lst.length, pi, pr, dd;
      for (pi = 0; pi < n2; pi++) { pr = lst[pi]; dd = pr.f(x, y, z); scratch[pi] = dd; if (dd < best) { best = dd; bestP = pr; } }
      if (!bestP) { bestP = prims[0]; best = 0; }
      // Round-3 (shoulder at 180°): a vertex belongs to ONE part — the part whose own prims (restricted field) put a surface here —
      // and prims of another part weight it only through a bridge (the same connectivity rule as the field's fillets). Before,
      // the lats / axillary folds (R 0.08) reached the medial upper arm and gave its skin 40 % spine weight, and torso fillet
      // vertices next to the arm took the arm as their closest prim: at 180° flexion both collapsed to the joint axis (LBS flap)
      // or swung out 90° (DQS fin). The closest prim decides unless prims of several parts are within reach; then the part
      // whose restricted field is nearest zero owns the vertex (the fillet surface of the torso core is 2 cm from every torso
      // prim but 1.5 cm from the arm core).
      var vpart = bestP.part, nparts = 0, pk;
      for (pi = 0; pi < n2; pi++) { pr = lst[pi]; if (pr.sub) continue; dd = scratch[pi]; if (dd >= pr.R) continue; if (pr.part !== vpart) { nparts = 2; break; } }
      if (nparts) {
        if (!blkW.plists) { blkW.plists = {}; for (pi = 0; pi < blkW.list.length; pi++) { pk = blkW.list[pi].part; (blkW.plists[pk] || (blkW.plists[pk] = [])).push(blkW.list[pi]); } }
        var bestF = 1e9, bestPart = vpart, seen = {};
        for (pi = 0; pi < n2; pi++) {
          pr = lst[pi]; if (pr.sub) continue; if (scratch[pi] >= pr.R) continue; pk = pr.part; if (seen[pk]) continue; seen[pk] = 1;
          var pl = blkW.plists[pk]; if (!pl) continue;
          var fv = Math.abs(evalField(x, y, z, pl, scratchP));
          if (fv < bestF) { bestF = fv; bestPart = pk; }
        }
        if (bestPart !== vpart) { vpart = bestPart; best = 1e9; for (pi = 0; pi < n2; pi++) { pr = lst[pi]; if (pr.part === vpart && scratch[pi] < best) { best = scratch[pi]; bestP = pr; } } }
      }
      for (var bb = 0; bb < nb; bb++) wacc[bb] = 0;
      for (pi = 0; pi < n2; pi++) {
        pr = lst[pi]; if (pr.sub) continue;
        var dd2 = scratch[pi]; if (dd2 < 0) dd2 = 0;
        if (dd2 >= pr.R) continue;
        if (pr.part !== vpart && !(pr.bridge && pr.bridge[vpart]) && !(bestP.bridge && bestP.bridge[pr.part])) continue;
        var f = 1 - smoothstep(0, pr.R, dd2); f = f * f;
        addOwn(wacc, pr.own, f, y);
      }
      var sumw = 0;
      for (bb = 0; bb < nb; bb++) sumw += wacc[bb];
      if (sumw <= 0) { addOwn(wacc, bestP.own, 1, y); sumw = 0; for (bb = 0; bb < nb; bb++) sumw += wacc[bb]; }
      for (bb = 0; bb < nb; bb++) WD[vv * nb + bb] = wacc[bb] / sumw;
      VPART[vv] = partIds[bestP.part];
      if ((vv & 2047) === 0 && nowMs() - tChunk > 40) { tChunk = nowMs(); yield { p: 0.74 + 0.10 * vv / nv, stage: 'skinning' }; }
    }
    // 8b. adjacency on the (decimated) mesh + 4 smoothing passes on the weight vectors
    deg = new Int32Array(nv);
    for (t3 = 0; t3 < nt * 3; t3 += 3) { deg[I[t3]] += 2; deg[I[t3 + 1]] += 2; deg[I[t3 + 2]] += 2; }
    off = new Int32Array(nv + 1); for (vv = 0; vv < nv; vv++) off[vv + 1] = off[vv] + deg[vv];
    adj = new Int32Array(off[nv]); fill = new Int32Array(nv);
    for (t3 = 0; t3 < nt * 3; t3 += 3) {
      var y0 = I[t3], y1 = I[t3 + 1], y2 = I[t3 + 2];
      adj[off[y0] + fill[y0]++] = y1; adj[off[y0] + fill[y0]++] = y2; adj[off[y1] + fill[y1]++] = y0; adj[off[y1] + fill[y1]++] = y2; adj[off[y2] + fill[y2]++] = y0; adj[off[y2] + fill[y2]++] = y1;
    }
    var WD2 = new Float32Array(nv * nb), wIt;
    for (wIt = 0; wIt < 4; wIt++) {   // round-3: 2 → 4 passes (the shoulder-at-180° tears were one-edge weight jumps)
      for (vv = 0; vv < nv; vv++) {
        var a0 = off[vv], a1 = off[vv + 1], cnt = a1 - a0, base = vv * nb;
        if (cnt === 0) { for (bb = 0; bb < nb; bb++) WD2[base + bb] = WD[base + bb]; continue; }
        for (bb = 0; bb < nb; bb++) WD2[base + bb] = 0.5 * WD[base + bb];
        var inv = 0.5 / cnt;
        for (var e2 = a0; e2 < a1; e2++) { var nbase = adj[e2] * nb; for (bb = 0; bb < nb; bb++) WD2[base + bb] += inv * WD[nbase + bb]; }
      }
      var tw = WD; WD = WD2; WD2 = tw;
    }
    // 8b'. Round-4 review ("a 2-4 cm pale stretched wedge still protrudes from the armpit floor at 170-180°"): the wedge is the few
    //      vertices left with a one-edge weight jump at the armpit floor (24 edges > 0.35 after the 4 global passes — each one a
    //      triangle stretched between the torso-rigid and arm-rigid predictions). More GLOBAL passes would blur every other joint,
    //      so `lapNear` extra passes run only on vertices within `lapRadius` of a shoulder joint (build pose): the transition
    //      becomes a smooth cone across the axilla instead of a sliver (r3-shoulder-lab: max deviation / edge jumps).
    var lapNear = opts.lapNear, lapR2 = opts.lapRadius * opts.lapRadius;
    if (lapNear > 0 && lapR2 > 0) {
      var shLo = frames.shoulderL.o, shRo = frames.shoulderR.o, nearSh = new Uint8Array(nv), nNear = 0;
      for (vv = 0; vv < nv; vv++) {
        var qx = P[vv * 3], qy = P[vv * 3 + 1], qz = P[vv * 3 + 2];
        var dl = (qx - shLo[0]) * (qx - shLo[0]) + (qy - shLo[1]) * (qy - shLo[1]) + (qz - shLo[2]) * (qz - shLo[2]);
        var dr = (qx - shRo[0]) * (qx - shRo[0]) + (qy - shRo[1]) * (qy - shRo[1]) + (qz - shRo[2]) * (qz - shRo[2]);
        if (dl < lapR2 || dr < lapR2) { nearSh[vv] = 1; nNear++; }
      }
      for (wIt = 0; wIt < lapNear && nNear; wIt++) {
        for (vv = 0; vv < nv; vv++) {
          var b0 = vv * nb, c0 = off[vv], c1 = off[vv + 1], cnt2 = c1 - c0;
          if (!nearSh[vv] || cnt2 === 0) { for (bb = 0; bb < nb; bb++) WD2[b0 + bb] = WD[b0 + bb]; continue; }
          for (bb = 0; bb < nb; bb++) WD2[b0 + bb] = 0.5 * WD[b0 + bb];
          var inv2 = 0.5 / cnt2;
          for (var e3 = c0; e3 < c1; e3++) { var nb2 = adj[e3] * nb; for (bb = 0; bb < nb; bb++) WD2[b0 + bb] += inv2 * WD[nb2 + bb]; }
        }
        tw = WD; WD = WD2; WD2 = tw;
      }
      // 8b''. Sharpen the ARM-vs-TORSO split of each near-shoulder vertex (γ on the arm-family fraction, families = every bone of that
      //       arm). The skinning there is linear blend (assembleRig's tlDqs): a mid-weight vertex collapses INTO the shoulder, so the
      //       fewer vertices sit at 20-80 % the shorter the stretched band between the armpit floor and the collapsed ring — the pale
      //       flap at the apex. The passes above keep the field smooth; γ only steepens it.
      var lapGamma = opts.lapGamma;
      if (lapGamma !== 1) {
        var famL = [], famR = [];
        BONE_DEFS.forEach(function (d, bi) { if (/^(shoulder|upperArm|elbow|forearm|forearmTwist|wrist|hand|thumb|finger\d)L$/.test(d[0])) famL.push(bi); else if (/^(shoulder|upperArm|elbow|forearm|forearmTwist|wrist|hand|thumb|finger\d)R$/.test(d[0])) famR.push(bi); });
        for (vv = 0; vv < nv; vv++) {
          if (!nearSh[vv]) continue;
          var px2 = P[vv * 3], py2 = P[vv * 3 + 1], pz2 = P[vv * 3 + 2];
          var fam = ((px2 - shLo[0]) * (px2 - shLo[0]) + (py2 - shLo[1]) * (py2 - shLo[1]) + (pz2 - shLo[2]) * (pz2 - shLo[2])) < ((px2 - shRo[0]) * (px2 - shRo[0]) + (py2 - shRo[1]) * (py2 - shRo[1]) + (pz2 - shRo[2]) * (pz2 - shRo[2])) ? famL : famR;
          var bv = vv * nb, wa = 0, fi;
          for (fi = 0; fi < fam.length; fi++) wa += WD[bv + fam[fi]];
          if (wa <= 0.02 || wa >= 0.98) continue;
          var ga = Math.pow(wa, lapGamma), gb = Math.pow(1 - wa, lapGamma), ws = ga / (ga + gb), sa = ws / wa, sb = (1 - ws) / (1 - wa);
          for (bb = 0; bb < nb; bb++) WD[bv + bb] *= sb;
          for (fi = 0; fi < fam.length; fi++) WD[bv + fam[fi]] *= sa / sb;
        }
      }
    }
    WD2 = null;
    // 8c. top-4 + normalise
    for (vv = 0; vv < nv; vv++) {
      var w0 = 0, w1 = 0, w2 = 0, w3 = 0, i0 = 0, i1b = 0, i2 = 0, i3 = 0, vb = vv * nb;
      for (bb = 0; bb < nb; bb++) {
        var w = WD[vb + bb]; if (w <= 0) continue;
        if (w > w0) { w3 = w2; i3 = i2; w2 = w1; i2 = i1b; w1 = w0; i1b = i0; w0 = w; i0 = bb; }
        else if (w > w1) { w3 = w2; i3 = i2; w2 = w1; i2 = i1b; w1 = w; i1b = bb; }
        else if (w > w2) { w3 = w2; i3 = i2; w2 = w; i2 = bb; }
        else if (w > w3) { w3 = w; i3 = bb; }
      }
      var sum = w0 + w1 + w2 + w3; if (sum <= 0) { sum = 1; w0 = 1; }
      SI[vv * 4] = i0; SI[vv * 4 + 1] = i1b; SI[vv * 4 + 2] = i2; SI[vv * 4 + 3] = i3;
      SW[vv * 4] = w0 / sum; SW[vv * 4 + 1] = w1 / sum; SW[vv * 4 + 2] = w2 / sum; SW[vv * 4 + 3] = w3 / sum;
      DOM[vv] = i0;
    }
    WD = null;
    lap('weights');
    yield { p: 0.88, stage: 'skinned' };

    // 9. UVs (per part cylindrical / spherical; seam medial/back). u = azimuth in [0,1]; v = METRES along the part axis from
    //    its start (round-2: v used to be normalised to [0,1] per part, so the skin map's 10 tiles were 9 cm on the torso but
    //    2 cm on a hand — pores vanished and the cm-scale undulation became ribbing across the metacarpals). getVert scales u
    //    by the part's circumference C (rounded to 0.1 m so a full-period seam shift is an integer number of tiles for the
    //    skin ×10 and suit ×40 maps) and leaves v in metres → one texture tile is the same physical size on every part.
    //    The head keeps u, v ∈ [0,1] (the cap's normal map is authored for that spherical layout, uvRepeat 2).
    var UV = new Float32Array(nv * 2);
    var uvParts = {
      torso: { o: [0, -0.15, 0], axis: [0, 1, 0], ref: [0, 0, 1], C: 0.9 },
      neck: { o: [0, 0.48, 0], axis: [0, 1, 0], ref: [0, 0, 1], C: 0.4 },
      head: { o: [0, 0.68, 0.0], axis: [0, 1, 0], ref: [0, 0, 1], C: 1.0, sph: true }
    };
    function limbUV(name, a, b, C, sideSign) { uvParts[name] = { o: frames[a].o, axis: vnorm(vsub(frames[b].o, frames[a].o)), ref: [sideSign, 0, 0], C: C }; }
    limbUV('armL', 'shoulderL', 'elbowL', 0.30, 1); limbUV('armR', 'shoulderR', 'elbowR', 0.30, -1);
    limbUV('handL', 'wristL', 'handL', 0.20, 1); limbUV('handR', 'wristR', 'handR', 0.20, -1);
    limbUV('legL', 'hipJL', 'kneeL', 0.5, 1); limbUV('legR', 'hipJR', 'kneeR', 0.5, -1);
    uvParts.footL = { o: frames.ankleL.o, axis: frameRot(frames.ankleL, [0, 0, 1]), ref: frameRot(frames.ankleL, [0, 1, 0]), C: 0.3 };
    uvParts.footR = { o: frames.ankleR.o, axis: frameRot(frames.ankleR, [0, 0, 1]), ref: frameRot(frames.ankleR, [0, 1, 0]), C: 0.3 };
    // forearm shares the arm cylinder (axis from shoulder to elbow is fine in the build pose: forearm is collinear)
    Object.keys(uvParts).forEach(function (k) { var up = uvParts[k]; up.e2 = vnorm(vsub(up.ref, vscale(up.axis, vdot(up.ref, up.axis)))); up.e1 = vcross(up.axis, up.e2); up.vmin = 1e9; up.vmax = -1e9; });
    for (vv = 0; vv < nv; vv++) {
      var pn = partList[VPART[vv]], up = uvParts[pn] || uvParts.torso;
      x = P[vv * 3] - up.o[0]; y = P[vv * 3 + 1] - up.o[1]; z = P[vv * 3 + 2] - up.o[2];
      var ax2 = up.axis, along = x * ax2[0] + y * ax2[1] + z * ax2[2];
      var rx = x - ax2[0] * along, ry = y - ax2[1] * along, rz = z - ax2[2] * along;
      var e1 = up.e1, e2 = up.e2;
      var u = 0.5 + Math.atan2(rx * e1[0] + ry * e1[1] + rz * e1[2], rx * e2[0] + ry * e2[1] + rz * e2[2]) / (2 * Math.PI);
      var vcoord = up.sph ? (0.5 + Math.atan2(along, Math.sqrt(rx * rx + ry * ry + rz * rz)) / Math.PI) : along;
      if (vcoord < up.vmin) up.vmin = vcoord; if (vcoord > up.vmax) up.vmax = vcoord;
      UV[vv * 2] = clamp(u, 0, 1); UV[vv * 2 + 1] = vcoord;
    }
    for (vv = 0; vv < nv; vv++) { var upn = uvParts[partList[VPART[vv]]] || uvParts.torso; UV[vv * 2 + 1] = upn.sph ? clamp((UV[vv * 2 + 1] - upn.vmin) / Math.max(1e-6, upn.vmax - upn.vmin), 0, 1) : Math.max(0, UV[vv * 2 + 1] - upn.vmin); }
    var uScaleOfPart = partList.map(function (pn) { return (uvParts[pn] || uvParts.torso).C; });

    // 10. material regions as SIGNED functions (positive = inside), evaluated per vertex; triangles crossing an iso-line are split
    //     (marching triangles) so the cap edge, the jammer/kneeskin hem, waistband and straps are crisp curves, not triangle staircases.
    var hf = frames.head;
    var female = sex === 'female';
    var SUIT_HEM = -0.44;
    var armPartIds = {}; ['armL', 'armR', 'handL', 'handR'].forEach(function (n) { if (n in partIds) armPartIds[partIds[n]] = 1; });
    function capFn(x, y, z) { // silicone dome cap: ~2 cm above the brow in front, over the ears, down to the nape
      var lx = x - hf.o[0], ly = y - hf.o[1], lz = z - hf.o[2];
      var edge = 0.004 + 0.082 * smoothstep(-0.035, 0.075, lz) + 0.0 * lx;
      return ly - edge;
    }
    function waistFn(z) { return 0.085 - 0.15 * z; }                     // jammer waistband: 1-3 cm below the navel (0.12), ~2.5 cm higher at the back
    var handPartIds = {}; ['handL', 'handR'].forEach(function (n) { if (n in partIds) handPartIds[partIds[n]] = 1; });
    function suitFn(x, y, z, partId) {
      var ax = Math.abs(x);
      if (handPartIds[partId]) return -0.05;
      // round-1: the old `armPartIds` cut-out removed torso vertices whose CLOSEST prim was the deltoid / lateral pec → jagged
      // skin holes between the female strap and the suit body at the armpit. The x-limit below + the y band keep the arms out.
      if (armPartIds[partId] && (ax > 0.155 || y > 0.47)) return -0.05;
      var f;
      if (!female) {
        f = Math.min(y - SUIT_HEM, waistFn(z) - y);
      } else {
        var th = Math.atan2(ax, z);                                       // 0 = front, π = back
        var top = 0.405 - 0.105 * smoothstep(1.75, 2.35, th);             // front + sides to y 0.405; open back down to y 0.30 (T7)
        top -= 0.035 * (1 - smoothstep(0, 0.075, ax)) * clamp(z / 0.04, 0, 1);   // scoop neckline
        var cover = top - y;
        var strap = Math.min(ax - 0.070, 0.108 - ax, 0.54 - y, y - 0.25); // two straps over the shoulders (inside the acromion)
        var back = Math.min(0.30 - y, y - 0.20, 0.06 - Math.abs(ax - 0.06 - 0.5 * (y - 0.2)));   // back-strap crossing (X) under the open back
        f = Math.min(Math.max(cover, strap, back), y - SUIT_HEM);
      }
      var xlim = 0.17 + 0.055 * smoothstep(0.25, 0.10, y);                // keeps the hanging (A-pose) arms out of the region
      return Math.min(f, xlim - ax);
    }
    var TG = new Uint8Array(nt);
    var mesh0 = { P: P, N: N, UV: UV, SI: SI, SW: SW, I: I, TG: TG, VPART: VPART, nv: nv, nt: nt };
    var fcap = new Float32Array(nv), fsuit;
    for (vv = 0; vv < nv; vv++) fcap[vv] = capFn(P[vv * 3], P[vv * 3 + 1], P[vv * 3 + 2]);
    var mesh1 = splitMesh(mesh0, fcap, 2);
    fsuit = new Float32Array(mesh1.nv);
    for (vv = 0; vv < mesh1.nv; vv++) fsuit[vv] = suitFn(mesh1.P[vv * 3], mesh1.P[vv * 3 + 1], mesh1.P[vv * 3 + 2], mesh1.VPART[vv]);
    var mesh2 = splitMesh(mesh1, fsuit, 1);
    // Round-2 review ("serrated suit edges"): the +2 mm shell feathers to 0 over the last 6 mm, and the waistband / hem
    // bands ramp over 4 + 10 mm — but a ramp bounded by "the next vertex ring" of a decimated mesh ends 0–20 mm from the
    // edge at random, so the visible ridge zig-zagged along mesh vertices. Every ramp is now bounded by EXACT iso-lines:
    // extra marching-triangle splits inside the suit (group 1 → group 1) at the feather width and at both ends of each band.
    var FEATHER = 0.006;
    function isoInside(mesh, fn) {
      var f = new Float32Array(mesh.nv);
      for (var v = 0; v < mesh.nv; v++) f[v] = fn(mesh.P[v * 3], mesh.P[v * 3 + 1], mesh.P[v * 3 + 2], mesh.VPART[v]);
      return splitMesh(mesh, f, 1, 1, 1);
    }
    var mesh3 = isoInside(mesh2, function (x, y, z, pid) { return suitFn(x, y, z, pid) - FEATHER; });
    if (!female) {
      mesh3 = isoInside(mesh3, function (x, y, z) { return (waistFn(z) - y) - 0.024; });
      mesh3 = isoInside(mesh3, function (x, y, z) { return (waistFn(z) - y) - 0.034; });
      mesh3 = isoInside(mesh3, function (x, y, z) { return (y - SUIT_HEM) - 0.016; });
      mesh3 = isoInside(mesh3, function (x, y, z) { return (y - SUIT_HEM) - 0.024; });
    } else {
      mesh3 = isoInside(mesh3, function (x, y, z) { return y - 0.34; });
      mesh3 = isoInside(mesh3, function (x, y, z) { return y - 0.38; });
    }
    mesh2 = mesh3;
    P = mesh2.P; N = mesh2.N; UV = mesh2.UV; SI = mesh2.SI; SW = mesh2.SW; I = mesh2.I; TG = mesh2.TG; VPART = mesh2.VPART; nv = mesh2.nv; nt = mesh2.nt;
    {   // the split can leave a sliver where an iso-line corner (strap crossing, waistband) grazes a vertex: drop zero-area pieces
      var keepI = new Uint32Array(nt * 3), keepG = new Uint8Array(nt), kn2 = 0, aMin2 = 1e-6 * h * h;
      for (t3 = 0; t3 < nt; t3++) {
        var qa = I[t3 * 3], qb = I[t3 * 3 + 1], qc = I[t3 * 3 + 2];
        if (qa === qb || qb === qc || qa === qc) { out.droppedDegenerate++; continue; }
        var qax = P[qa * 3], qay = P[qa * 3 + 1], qaz = P[qa * 3 + 2];
        var q1x = P[qb * 3] - qax, q1y = P[qb * 3 + 1] - qay, q1z = P[qb * 3 + 2] - qaz, q2x = P[qc * 3] - qax, q2y = P[qc * 3 + 1] - qay, q2z = P[qc * 3 + 2] - qaz;
        var qnx = q1y * q2z - q1z * q2y, qny = q1z * q2x - q1x * q2z, qnz = q1x * q2y - q1y * q2x;
        if (0.5 * Math.sqrt(qnx * qnx + qny * qny + qnz * qnz) < aMin2) { out.droppedDegenerate++; continue; }
        keepG[kn2] = TG[t3]; keepI[kn2 * 3] = qa; keepI[kn2 * 3 + 1] = qb; keepI[kn2 * 3 + 2] = qc; kn2++;
      }
      if (kn2 !== nt) { I = keepI.subarray(0, kn2 * 3); TG = keepG.subarray(0, kn2); nt = kn2; }
    }
    var counts = [0, 0, 0];
    for (t3 = 0; t3 < nt; t3++) counts[TG[t3]]++;
    out.groupCounts = counts;
    lap('uv+groups');
    yield { p: 0.92, stage: 'materials' };

    // 11. split vertices at UV seams and group borders; offset suit/cap outward; build final buffers (sorted by group)
    var remap = new Map();
    var fp = [], fn = [], fuv = [], fsi = [], fsw = [], fidx = [[], [], []], fog = [];
    function getVert(orig, shift, grp) {
      var key = (orig * 3 + grp) * 3 + (shift > 0 ? 1 : (shift < 0 ? 2 : 0));
      var r = remap.get(key); if (r !== undefined) return r;
      r = fp.length / 3;
      var o3 = orig * 3, o2 = orig * 2, o4 = orig * 4;
      var offs = 0;
      if (grp === 1) {
        // 2 mm shell feathered to 0 over the last 6 mm before every suit edge (round-1: the step read as a ring at the waist),
        // plus a 3 cm waistband (+2 mm, drawcord) and a 2 cm leg-hem band (+1 mm) on the jammer, a 1 mm binding on the kneeskin.
        // Every ramp start/end is an iso-line the mesh was split along (see isoInside above), so the ramps are exact.
        var fsv = suitFn(P[o3], P[o3 + 1], P[o3 + 2], VPART[orig]), edge = smoothstep(0, FEATHER, fsv);
        offs = 0.002 * edge;
        if (!female) {
          var toWaist = waistFn(P[o3 + 2]) - P[o3 + 1], toHem = P[o3 + 1] - SUIT_HEM;
          offs += 0.002 * (1 - smoothstep(0.024, 0.034, toWaist)) * smoothstep(0, 0.004, toWaist);
          offs += 0.001 * (1 - smoothstep(0.016, 0.024, toHem)) * smoothstep(0, 0.004, toHem);
        } else offs += 0.001 * edge * smoothstep(0.34, 0.38, P[o3 + 1]);                             // neckline binding (smooth, no step at y 0.36)
      } else if (grp === 2) offs = 0.0015;
      fp.push(P[o3] + N[o3] * offs, P[o3 + 1] + N[o3 + 1] * offs, P[o3 + 2] + N[o3 + 2] * offs);
      fn.push(N[o3], N[o3 + 1], N[o3 + 2]);
      // u: azimuth + a FULL period for the low side of a seam triangle, scaled by the part's circumference (metres); v: metres
      fuv.push((UV[o2] + shift) * uScaleOfPart[VPART[orig]], UV[o2 + 1]);
      fsi.push(SI[o4], SI[o4 + 1], SI[o4 + 2], SI[o4 + 3]);
      fsw.push(SW[o4], SW[o4 + 1], SW[o4 + 2], SW[o4 + 3]);
      fog.push(orig * 3 + grp);
      remap.set(key, r);
      return r;
    }
    for (t3 = 0; t3 < nt; t3++) {
      var g2 = TG[t3], va = I[t3 * 3], vb = I[t3 * 3 + 1], vc = I[t3 * 3 + 2];
      var ua = UV[va * 2], ub = UV[vb * 2], uc = UV[vc * 2];
      var umax = Math.max(ua, ub, uc), umin = Math.min(ua, ub, uc), seam = (umax - umin) > 0.5;
      var sa = seam ? (ua < 0.5 ? 1 : 0) : 0, sb = seam ? (ub < 0.5 ? 1 : 0) : 0, scc = seam ? (uc < 0.5 ? 1 : 0) : 0;
      fidx[g2].push(getVert(va, sa, g2), getVert(vb, sb, g2), getVert(vc, scc, g2));
    }
    // Round-2: SHELL normals. Suit and cap vertices are their own copies (getVert keys by group), so their normals are
    // recomputed from the OFFSET geometry — the feather / waistband / hem ramps then shade as the small ridges they are,
    // a smooth line along the iso-curve, instead of borrowing the flat skin normal. Copies of one source vertex (UV seam)
    // share one accumulated normal so the seam stays invisible.
    {
      var nvF = fp.length / 3, accN = new Map(), gi2, arr2, q2, ia2, ib2, ic2, kx, ky, kz, e1x2, e1y2, e1z2, e2x2, e2y2, e2z2;
      function accum(k, x, y, z) { var a = accN.get(k); if (!a) { a = [0, 0, 0]; accN.set(k, a); } a[0] += x; a[1] += y; a[2] += z; }
      for (gi2 = 1; gi2 < 3; gi2++) {
        arr2 = fidx[gi2];
        for (q2 = 0; q2 < arr2.length; q2 += 3) {
          ia2 = arr2[q2] * 3; ib2 = arr2[q2 + 1] * 3; ic2 = arr2[q2 + 2] * 3;
          e1x2 = fp[ib2] - fp[ia2]; e1y2 = fp[ib2 + 1] - fp[ia2 + 1]; e1z2 = fp[ib2 + 2] - fp[ia2 + 2];
          e2x2 = fp[ic2] - fp[ia2]; e2y2 = fp[ic2 + 1] - fp[ia2 + 1]; e2z2 = fp[ic2 + 2] - fp[ia2 + 2];
          kx = e1y2 * e2z2 - e1z2 * e2y2; ky = e1z2 * e2x2 - e1x2 * e2z2; kz = e1x2 * e2y2 - e1y2 * e2x2;
          accum(fog[arr2[q2]], kx, ky, kz); accum(fog[arr2[q2 + 1]], kx, ky, kz); accum(fog[arr2[q2 + 2]], kx, ky, kz);
        }
      }
      for (var vq = 0; vq < nvF; vq++) {
        var an = accN.get(fog[vq]); if (!an) continue;
        var al = Math.sqrt(an[0] * an[0] + an[1] * an[1] + an[2] * an[2]);
        if (al < 1e-12) continue;
        fn[vq * 3] = an[0] / al; fn[vq * 3 + 1] = an[1] / al; fn[vq * 3 + 2] = an[2] / al;
      }
    }
    // Round-4: the suit / cap shell offsets can collapse a hairline triangle at a group border to zero area (one survived in the
    // male/high build) — filter once more on the FINAL float32 positions, exactly as the consumer sees them.
    var fp32 = new Float32Array(fp), aMin3 = 1e-6 * h * h, kept3, q3, i3a, i3b, i3c, ax3, ay3, az3, bx3, by3, bz3, cx3, cy3, cz3, nx3, ny3, nz3;
    for (var gi0 = 0; gi0 < 3; gi0++) {
      var arr0 = fidx[gi0]; kept3 = [];
      for (q3 = 0; q3 < arr0.length; q3 += 3) {
        i3a = arr0[q3] * 3; i3b = arr0[q3 + 1] * 3; i3c = arr0[q3 + 2] * 3;
        ax3 = fp32[i3b] - fp32[i3a]; ay3 = fp32[i3b + 1] - fp32[i3a + 1]; az3 = fp32[i3b + 2] - fp32[i3a + 2];
        bx3 = fp32[i3c] - fp32[i3a]; by3 = fp32[i3c + 1] - fp32[i3a + 1]; bz3 = fp32[i3c + 2] - fp32[i3a + 2];
        nx3 = ay3 * bz3 - az3 * by3; ny3 = az3 * bx3 - ax3 * bz3; nz3 = ax3 * by3 - ay3 * bx3;
        if (arr0[q3] === arr0[q3 + 1] || arr0[q3 + 1] === arr0[q3 + 2] || arr0[q3] === arr0[q3 + 2] || 0.5 * Math.sqrt(nx3 * nx3 + ny3 * ny3 + nz3 * nz3) < aMin3) { out.droppedDegenerate++; nt--; continue; }
        kept3.push(arr0[q3], arr0[q3 + 1], arr0[q3 + 2]);
      }
      fidx[gi0] = kept3;
    }
    var index = new Uint32Array(nt * 3), groups = [], cursor = 0;
    for (var gi = 0; gi < 3; gi++) { var arr = fidx[gi]; index.set(arr, cursor); groups.push({ start: cursor, count: arr.length, materialIndex: gi }); cursor += arr.length; }
    out.mesh = { position: new Float32Array(fp), normal: new Float32Array(fn), uv: new Float32Array(fuv), skinIndex: new Uint16Array(fsi), skinWeight: new Float32Array(fsw), index: index, groups: groups, triangles: nt, vertices: fp.length / 3, rawVertices: nv };
    out.frames = frames; out.prims = prims; out.grid = grid; out.activeBlocks = nActive; out.skeletonBones = sk; out.blk = opts.debug ? blk : null; blocks = null;
    lap('assemble');
    timings.total = Math.round(nowMs() - t0);
    yield { p: 0.97, stage: 'assembling' };
  }
  // Marching-triangles split of a mesh along the iso-line f = 0 of a per-vertex signed function. Only triangles in group
  // `onlyGroup` (default 0) are candidates; positive-side pieces get group grpPos, negative-side pieces grpNeg (default 0).
  // grpPos === grpNeg === onlyGroup inserts the iso-line without changing groups (round-2: exact ramp boundaries).
  // New vertices interpolate position/normal/uv/skin.
  function splitMesh(m, fv, grpPos, grpNeg, onlyGroup) {
    grpNeg = grpNeg || 0; onlyGroup = onlyGroup || 0;
    var P = m.P, N = m.N, UV = m.UV, SI = m.SI, SW = m.SW, I = m.I, TG = m.TG, VPART = m.VPART, nv = m.nv, nt = m.nt;
    var aP = [], aN = [], aUV = [], aSI = [], aSW = [], aVP = [], nI = [], nTG = [];
    var cache = new Map();
    function mid(a, b) {
      var key = (a < b ? a : b) * 1048576 + (a < b ? b : a);
      var r = cache.get(key); if (r !== undefined) return r;
      var fa = fv[a], fb = fv[b], t = fa / (fa - fb); if (!(t >= 0)) t = 0; if (t > 1) t = 1;
      // iso-line within 0.1 % of an endpoint (≈ 5 µm): reuse the endpoint instead of a coincident vertex (→ zero-area slivers)
      if (t <= 1e-3) { cache.set(key, a); return a; }
      if (t >= 1 - 1e-3) { cache.set(key, b); return b; }
      r = nv + aP.length / 3;
      var a3 = a * 3, b3 = b * 3, c;
      for (c = 0; c < 3; c++) aP.push(P[a3 + c] + (P[b3 + c] - P[a3 + c]) * t);
      var nx = N[a3] + (N[b3] - N[a3]) * t, ny = N[a3 + 1] + (N[b3 + 1] - N[a3 + 1]) * t, nz = N[a3 + 2] + (N[b3 + 2] - N[a3 + 2]) * t;
      var nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1; aN.push(nx / nl, ny / nl, nz / nl);
      var ua = UV[a * 2], ub = UV[b * 2];
      if (Math.abs(ua - ub) > 0.5) { if (ua < ub) ua += 1; else ub += 1; }
      var u = ua + (ub - ua) * t; if (u >= 1) u -= 1;
      aUV.push(u, UV[a * 2 + 1] + (UV[b * 2 + 1] - UV[a * 2 + 1]) * t);
      var acc = {}, k, bi;
      for (k = 0; k < 4; k++) { bi = SI[a * 4 + k]; acc[bi] = (acc[bi] || 0) + SW[a * 4 + k] * (1 - t); bi = SI[b * 4 + k]; acc[bi] = (acc[bi] || 0) + SW[b * 4 + k] * t; }
      var keys = Object.keys(acc).sort(function (p, q) { return acc[q] - acc[p]; }).slice(0, 4), sum = 0;
      for (k = 0; k < keys.length; k++) sum += acc[keys[k]];
      for (k = 0; k < 4; k++) { if (k < keys.length) { aSI.push(+keys[k]); aSW.push(acc[keys[k]] / sum); } else { aSI.push(0); aSW.push(0); } }
      aVP.push(VPART[a]);
      cache.set(key, r);
      return r;
    }
    for (var t = 0; t < nt; t++) {
      var a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2], g = TG[t];
      if (g !== onlyGroup) { nI.push(a, b, c); nTG.push(g); continue; }
      var pa = fv[a] > 0, pb = fv[b] > 0, pc = fv[c] > 0, np = (pa ? 1 : 0) + (pb ? 1 : 0) + (pc ? 1 : 0);
      if (np === 0) { nI.push(a, b, c); nTG.push(grpNeg); continue; }
      if (np === 3) { nI.push(a, b, c); nTG.push(grpPos); continue; }
      // rotate so the odd vertex comes first (keeps winding)
      var oddPos = np === 1, o, p1, p2;
      if ((pa ? 1 : 0) === (oddPos ? 1 : 0)) { o = a; p1 = b; p2 = c; } else if ((pb ? 1 : 0) === (oddPos ? 1 : 0)) { o = b; p1 = c; p2 = a; } else { o = c; p1 = a; p2 = b; }
      var m1 = mid(o, p1), m2 = mid(o, p2);
      tri(o, m1, m2, oddPos ? grpPos : grpNeg);
      tri(m1, p1, p2, oddPos ? grpNeg : grpPos);
      tri(m1, p2, m2, oddPos ? grpNeg : grpPos);
    }
    function tri(x, y, z, grp) { if (x === y || y === z || x === z) return; nI.push(x, y, z); nTG.push(grp); }   // snapped mids → skip collapsed pieces
    var nv2 = nv + aP.length / 3, nt2 = nI.length / 3;
    function cat(T, base, add, w) { var o = new T(nv2 * w); o.set(base.subarray ? base.subarray(0, nv * w) : base); o.set(add, nv * w); return o; }
    return { P: cat(Float32Array, P, aP, 3), N: cat(Float32Array, N, aN, 3), UV: cat(Float32Array, UV, aUV, 2), SI: cat(Uint16Array, SI, aSI, 4), SW: cat(Float32Array, SW, aSW, 4), VPART: cat(Uint8Array, VPART, aVP, 1), I: new Uint32Array(nI), TG: new Uint8Array(nTG), nv: nv2, nt: nt2 };
  }
  // ───────────────────────────── QEM edge-collapse decimation (Garland & Heckbert 1997) ─────────────────────────────
  // Runs on the welded MC mesh after Taubin, before normals/weights/UVs (all of which are recomputed from positions), so
  // 'high' can sample the field finely (crisp fingers/face) and still ship ≤ 60k triangles. Generator: yields every ~40 ms.
  function* decimateGen(P, I, nv, nt, target, onYield) {
    var faces = new Int32Array(I), fAlive = new Uint8Array(nt), alive = new Uint8Array(nv), Q = new Float64Array(nv * 10), ver = new Uint32Array(nv);
    var vf = new Array(nv), t, v, i;
    for (v = 0; v < nv; v++) { vf[v] = []; alive[v] = 1; }
    var liveFaces = 0;
    for (t = 0; t < nt; t++) {
      var a = faces[t * 3], b = faces[t * 3 + 1], c = faces[t * 3 + 2];
      if (a === b || b === c || a === c) continue;
      fAlive[t] = 1; liveFaces++;
      vf[a].push(t); vf[b].push(t); vf[c].push(t);
      var ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
      var e1x = P[b * 3] - ax, e1y = P[b * 3 + 1] - ay, e1z = P[b * 3 + 2] - az, e2x = P[c * 3] - ax, e2y = P[c * 3 + 1] - ay, e2z = P[c * 3 + 2] - az;
      var nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x, nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (nl < 1e-14) continue;
      nx /= nl; ny /= nl; nz /= nl; var d = -(nx * ax + ny * ay + nz * az), w = nl * 0.5; // area-weighted plane quadric
      for (i = 0; i < 3; i++) {
        var q = faces[t * 3 + i] * 10;
        Q[q] += w * nx * nx; Q[q + 1] += w * nx * ny; Q[q + 2] += w * nx * nz; Q[q + 3] += w * nx * d; Q[q + 4] += w * ny * ny; Q[q + 5] += w * ny * nz; Q[q + 6] += w * ny * d; Q[q + 7] += w * nz * nz; Q[q + 8] += w * nz * d; Q[q + 9] += w * d * d;
      }
    }
    // heap of edge candidates (lazy invalidation through vertex versions)
    var cap = nt * 4, hCost = new Float64Array(cap), hU = new Int32Array(cap), hV = new Int32Array(cap), hVu = new Uint32Array(cap), hVv = new Uint32Array(cap), hn = 0;
    var qs = new Float64Array(10), opt = new Float64Array(4);
    function grow() { cap *= 2; var c2 = new Float64Array(cap); c2.set(hCost); hCost = c2; var u2 = new Int32Array(cap); u2.set(hU); hU = u2; var v2 = new Int32Array(cap); v2.set(hV); hV = v2; var a2 = new Uint32Array(cap); a2.set(hVu); hVu = a2; var b2 = new Uint32Array(cap); b2.set(hVv); hVv = b2; }
    function hswap(x, y) { var tc = hCost[x]; hCost[x] = hCost[y]; hCost[y] = tc; var ti = hU[x]; hU[x] = hU[y]; hU[y] = ti; ti = hV[x]; hV[x] = hV[y]; hV[y] = ti; var tu = hVu[x]; hVu[x] = hVu[y]; hVu[y] = tu; tu = hVv[x]; hVv[x] = hVv[y]; hVv[y] = tu; }
    function hpush(cost, u, vv) {
      if (hn >= cap) grow();
      var k = hn++; hCost[k] = cost; hU[k] = u; hV[k] = vv; hVu[k] = ver[u]; hVv[k] = ver[vv];
      while (k > 0) { var p = (k - 1) >> 1; if (hCost[p] <= hCost[k]) break; hswap(p, k); k = p; }
    }
    function hpop() { // moves the min to slot hn-1 (caller reads it) and shrinks
      hswap(0, --hn); var k = 0;
      for (;;) { var l = 2 * k + 1, r = l + 1, m = k; if (l < hn && hCost[l] < hCost[m]) m = l; if (r < hn && hCost[r] < hCost[m]) m = r; if (m === k) break; hswap(m, k); k = m; }
    }
    function evalQ(q, x, y, z) { return q[0] * x * x + 2 * q[1] * x * y + 2 * q[2] * x * z + 2 * q[3] * x + q[4] * y * y + 2 * q[5] * y * z + 2 * q[6] * y + q[7] * z * z + 2 * q[8] * z + q[9]; }
    // optimal placement for the edge (u,v): solves the 3x3 normal equations, falls back to the best of u / v / midpoint
    function edgeCost(u, vv) {
      var qu = u * 10, qv = vv * 10, k;
      for (k = 0; k < 10; k++) qs[k] = Q[qu + k] + Q[qv + k];
      var a = qs[0], b = qs[1], c = qs[2], d = qs[3], e = qs[4], f = qs[5], g = qs[6], h = qs[7], i2 = qs[8];
      var ux = P[u * 3], uy = P[u * 3 + 1], uz = P[u * 3 + 2], vx = P[vv * 3], vy = P[vv * 3 + 1], vz = P[vv * 3 + 2];
      var mx = (ux + vx) * 0.5, my = (uy + vy) * 0.5, mz = (uz + vz) * 0.5;
      var el2 = (ux - vx) * (ux - vx) + (uy - vy) * (uy - vy) + (uz - vz) * (uz - vz);
      var det = a * (e * h - f * f) - b * (b * h - f * c) + c * (b * f - e * c), best = 1e30, bx = mx, by = my, bz = mz;
      if (Math.abs(det) > 1e-18) {
        var r0 = -d, r1 = -g, r2 = -i2;
        var x = (r0 * (e * h - f * f) - b * (r1 * h - f * r2) + c * (r1 * f - e * r2)) / det;
        var y = (a * (r1 * h - f * r2) - r0 * (b * h - f * c) + c * (b * r2 - r1 * c)) / det;
        var z = (a * (e * r2 - f * r1) - b * (b * r2 - r1 * c) + r0 * (b * f - e * c)) / det;
        var dd = (x - mx) * (x - mx) + (y - my) * (y - my) + (z - mz) * (z - mz);
        if (dd <= el2) { best = evalQ(qs, x, y, z); bx = x; by = y; bz = z; }
      }
      var cu = evalQ(qs, ux, uy, uz), cv = evalQ(qs, vx, vy, vz), cm = evalQ(qs, mx, my, mz);
      if (cm < best) { best = cm; bx = mx; by = my; bz = mz; }
      if (cu < best) { best = cu; bx = ux; by = uy; bz = uz; }
      if (cv < best) { best = cv; bx = vx; by = vy; bz = vz; }
      opt[0] = bx; opt[1] = by; opt[2] = bz; opt[3] = best;
      return best;
    }
    // initial edges
    var seenEdge = new Set();
    for (t = 0; t < nt; t++) {
      if (!fAlive[t]) continue;
      for (i = 0; i < 3; i++) {
        var u = faces[t * 3 + i], w = faces[t * 3 + ((i + 1) % 3)], lo = u < w ? u : w, hi = u < w ? w : u, key = lo * 1048576 + hi;
        if (seenEdge.has(key)) continue; seenEdge.add(key);
        hpush(edgeCost(lo, hi), lo, hi);
      }
    }
    seenEdge = null;
    var tChunk = nowMs(), collapses = 0, nbr = [];
    while (liveFaces > target && hn > 0) {
      hpop(); var k0 = hn, cost = hCost[k0], u = hU[k0], vv = hV[k0];
      if (!alive[u] || !alive[vv] || hVu[k0] !== ver[u] || hVv[k0] !== ver[vv]) continue;
      edgeCost(u, vv); var px = opt[0], py = opt[1], pz = opt[2];
      // validity: the edge must be shared by ≤ 2 faces; no surviving face may flip or degenerate
      var fu = vf[u], fvv = vf[vv], shared = 0, ok = true, j, f3;
      for (j = 0; j < fu.length && ok; j++) {
        t = fu[j]; if (!fAlive[t]) continue; f3 = t * 3;
        var a0 = faces[f3], a1 = faces[f3 + 1], a2 = faces[f3 + 2];
        if (a0 === vv || a1 === vv || a2 === vv) { if (++shared > 2) ok = false; continue; }
        if (!flipOk(a0, a1, a2, u, px, py, pz)) ok = false;
      }
      for (j = 0; j < fvv.length && ok; j++) {
        t = fvv[j]; if (!fAlive[t]) continue; f3 = t * 3;
        a0 = faces[f3]; a1 = faces[f3 + 1]; a2 = faces[f3 + 2];
        if (a0 === u || a1 === u || a2 === u) continue;
        if (!flipOk(a0, a1, a2, vv, px, py, pz)) ok = false;
      }
      if (!ok) continue;
      // collapse u → vv at p
      P[vv * 3] = px; P[vv * 3 + 1] = py; P[vv * 3 + 2] = pz;
      for (j = 0; j < 10; j++) Q[vv * 10 + j] += Q[u * 10 + j];
      for (j = 0; j < fu.length; j++) {
        t = fu[j]; if (!fAlive[t]) continue; f3 = t * 3;
        if (faces[f3] === vv || faces[f3 + 1] === vv || faces[f3 + 2] === vv) { fAlive[t] = 0; liveFaces--; continue; }
        if (faces[f3] === u) faces[f3] = vv; if (faces[f3 + 1] === u) faces[f3 + 1] = vv; if (faces[f3 + 2] === u) faces[f3 + 2] = vv;
        fvv.push(t);
      }
      vf[u] = null; alive[u] = 0; ver[u]++; ver[vv]++;
      // compact vf[vv] and re-queue its edges
      nbr.length = 0; var live = [];
      for (j = 0; j < fvv.length; j++) {
        t = fvv[j]; if (!fAlive[t]) continue; live.push(t); f3 = t * 3;
        for (i = 0; i < 3; i++) { var w2 = faces[f3 + i]; if (w2 !== vv && nbr.indexOf(w2) < 0) nbr.push(w2); }
      }
      vf[vv] = live;
      for (j = 0; j < nbr.length; j++) { var w3 = nbr[j]; hpush(edgeCost(w3 < vv ? w3 : vv, w3 < vv ? vv : w3), w3 < vv ? w3 : vv, w3 < vv ? vv : w3); }
      collapses++;
      if ((collapses & 1023) === 0 && nowMs() - tChunk > 40) { tChunk = nowMs(); if (onYield) yield onYield(1 - (liveFaces - target) / Math.max(1, nt - target)); }
    }
    function flipOk(a0, a1, a2, moved, px, py, pz) {
      var x0 = P[a0 * 3], y0 = P[a0 * 3 + 1], z0 = P[a0 * 3 + 2], x1 = P[a1 * 3], y1 = P[a1 * 3 + 1], z1 = P[a1 * 3 + 2], x2 = P[a2 * 3], y2 = P[a2 * 3 + 1], z2 = P[a2 * 3 + 2];
      var n0x = (y1 - y0) * (z2 - z0) - (z1 - z0) * (y2 - y0), n0y = (z1 - z0) * (x2 - x0) - (x1 - x0) * (z2 - z0), n0z = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
      if (a0 === moved) { x0 = px; y0 = py; z0 = pz; } else if (a1 === moved) { x1 = px; y1 = py; z1 = pz; } else { x2 = px; y2 = py; z2 = pz; }
      var n1x = (y1 - y0) * (z2 - z0) - (z1 - z0) * (y2 - y0), n1y = (z1 - z0) * (x2 - x0) - (x1 - x0) * (z2 - z0), n1z = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
      var l0 = Math.sqrt(n0x * n0x + n0y * n0y + n0z * n0z), l1 = Math.sqrt(n1x * n1x + n1y * n1y + n1z * n1z);
      if (l1 < 1e-12) return false;
      return (n0x * n1x + n0y * n1y + n0z * n1z) / (l0 * l1 + 1e-30) > 0.2;
    }
    // compaction
    var remap = new Int32Array(nv).fill(-1), nv2 = 0;
    for (v = 0; v < nv; v++) if (alive[v]) remap[v] = nv2++;
    var P2 = new Float32Array(nv2 * 3);
    for (v = 0; v < nv; v++) if (alive[v]) { var r3 = remap[v] * 3; P2[r3] = P[v * 3]; P2[r3 + 1] = P[v * 3 + 1]; P2[r3 + 2] = P[v * 3 + 2]; }
    var I2 = new Uint32Array(liveFaces * 3), o = 0;
    for (t = 0; t < nt; t++) { if (!fAlive[t]) continue; I2[o++] = remap[faces[t * 3]]; I2[o++] = remap[faces[t * 3 + 1]]; I2[o++] = remap[faces[t * 3 + 2]]; }
    return { P: P2, I: I2, nv: nv2, nt: liveFaces, collapses: collapses };
  }
  function addOwn(wacc, own, f, y) {
    if (typeof own === 'string') { wacc[BONE_INDEX[own]] += f; return; }
    if (Array.isArray(own)) { for (var i = 0; i < own.length; i++) wacc[BONE_INDEX[own[i][0]]] += f * own[i][1]; return; }
    if (own && own.y) {
      // piecewise: entries [bone, yStart(full below?), ...]: [['hips',-9,0.04],['spine',0.19,9]] → hips full below 0.04, spine full above 0.19, linear blend between
      var seg = own.y, n = seg.length;
      // weights via smoothsteps between consecutive segments
      var ws = new Array(n), total = 0;
      for (var i = 0; i < n; i++) {
        var lo = seg[i][1], hi = seg[i][2];
        var w = 1;
        if (i > 0) w *= smoothstep(seg[i - 1][2], lo, y);         // fade in after previous full range ends
        if (i < n - 1) w *= 1 - smoothstep(hi, seg[i + 1][1], y); // fade out before next
        ws[i] = w; total += w;
      }
      if (total <= 0) { wacc[BONE_INDEX[seg[0][0]]] += f; return; }
      for (i = 0; i < n; i++) if (ws[i] > 0) wacc[BONE_INDEX[seg[i][0]]] += f * ws[i] / total;
    }
  }

  // ───────────────────────────── materials ─────────────────────────────
  var SKIN_TONES = { light: 0xe8b99a, medium: 0xc9915f, deep: 0x6b3f22 };
  var MAT_KEYS = ['skin', 'suit', 'cap', 'lens', 'frame', 'strap'];
  function isMat(m) { return !!(m && typeof m === 'object' && m.isMaterial); }
  function makeMaterials(THREE, opts) {
    var mats = opts.materials || null;                       // normOpts: the injected module, the global one, or null
    var tone = (typeof opts.skinTone === 'number') ? opts.skinTone : (SKIN_TONES[opts.skinTone] || SKIN_TONES.medium);
    var suitColor = opts.suitColor, caustics = opts.causticsTex || null;
    var res = { own: [] };
    if (mats) {
      try {
        // every material takes the shared caustics texture: today toWetMaterial puts the nets on the suit/cap (kit) too
        res.skin = mats.makeSkin({ tone: opts.skinTone, wet: true, causticsTex: caustics, envMap: opts.envMap });
        res.suit = mats.makeSuit({ color: suitColor, causticsTex: caustics, envMap: opts.envMap, sex: opts.sex });   // v1.4: sex → seams / logo / kneeskin panels (materials ≥ 1.3)
        res.cap = mats.makeCap({ color: opts.capColor, causticsTex: caustics, envMap: opts.envMap });
        var gg = mats.makeGoggles() || {}; res.lens = gg.lens; res.frame = gg.frame; res.strap = gg.strap;
        res.source = 'TL_HumanMaterials';
        if (!MAT_KEYS.every(function (k) { return isMat(res[k]); })) throw new Error('TL_HumanMaterials returned a non-material');
      } catch (e) {
        MAT_KEYS.forEach(function (k) { if (isMat(res[k]) && res[k].dispose) res[k].dispose(); });   // no half-built leak
        res = { own: [] };
        if (G.console) console.warn('TL_Human: TL_HumanMaterials failed, using fallback: ' + (e && e.message ? e.message : e));
      }
    }
    if (!res.skin) {
      // Fallback = toWetMaterial (index.html) verbatim: skin 0.28 / clearcoat 0.6 / cc-rough 0.12 / emissive 0x7fc4e8·0.28 with the
      // caustics as emissiveMap (no albedo map here, so the shared uvTransform is the caustics' — the nets crawl, SPEC §10.5);
      // kit (suit + cap) 0.55 / 0.08 / 0.12 / 0.12.
      function wet(color, isKit) {
        var m = new THREE.MeshPhysicalMaterial({ color: color, roughness: isKit ? 0.55 : 0.28, metalness: 0, clearcoat: isKit ? 0.08 : 0.6, clearcoatRoughness: 0.12,
          emissive: 0x7fc4e8, emissiveIntensity: isKit ? 0.12 : 0.28, emissiveMap: caustics, skinning: true });
        if ('thickness' in m) m.thickness = 0.5;
        if (opts.envMap) m.envMap = opts.envMap;
        return m;
      }
      res.skin = wet(tone, false);
      res.suit = wet(suitColor, true);
      res.cap = wet(opts.capColor, true);
      res.lens = new THREE.MeshPhysicalMaterial({ color: 0x14202c, roughness: 0.06, metalness: 0.35, clearcoat: 1, clearcoatRoughness: 0.04, transparent: true, opacity: 0.9 });
      res.frame = new THREE.MeshStandardMaterial({ color: 0x0b1116, roughness: 0.55, metalness: 0.05 });
      res.strap = new THREE.MeshStandardMaterial({ color: 0x0b1116, roughness: 0.5, metalness: 0.0, side: THREE.DoubleSide });
      res.source = 'fallback';
      if (opts.envMap) res.lens.envMap = opts.envMap;
    }
    [res.skin, res.suit, res.cap].forEach(function (m) { m.skinning = true; m.needsUpdate = true; });
    res.suit.userData.colorHex = suitColor; res.cap.userData.colorHex = opts.capColor;
    res.own = [res.skin, res.suit, res.cap, res.lens, res.frame, res.strap];
    return res;
  }

  // ───────────────────────────── dual-quaternion skinning (vertex-shader patch, r128 chunks) ─────────────────────────────
  // Replaces <skinnormal_vertex> / <skinning_vertex>. The bone matrices three uploads are rigid (bone.matrixWorld · boneInverse, no
  // scale anywhere in the rig), so each is converted to a unit dual quaternion in the shader, the four are blended with the weights
  // (sign-corrected against the dominant bone: body.js stores the largest weight first), normalised, and applied as a screw motion.
  var DQS_PARS = [
    '// TL dual-quaternion skinning (hybrid: attribute tlDqs = 1 dual quaternion … 0 linear blend, see DQS_POS)',
    'attribute float tlDqs;',
    'vec4 tlQuatFromMat( mat4 m ) {',
    '\tfloat t = m[0][0] + m[1][1] + m[2][2]; vec4 q;',
    '\tif ( t > 0.0 ) { float s = sqrt( t + 1.0 ) * 2.0; q = vec4( ( m[1][2] - m[2][1] ) / s, ( m[2][0] - m[0][2] ) / s, ( m[0][1] - m[1][0] ) / s, 0.25 * s ); }',
    '\telse if ( m[0][0] > m[1][1] && m[0][0] > m[2][2] ) { float s = sqrt( 1.0 + m[0][0] - m[1][1] - m[2][2] ) * 2.0; q = vec4( 0.25 * s, ( m[1][0] + m[0][1] ) / s, ( m[2][0] + m[0][2] ) / s, ( m[1][2] - m[2][1] ) / s ); }',
    '\telse if ( m[1][1] > m[2][2] ) { float s = sqrt( 1.0 + m[1][1] - m[0][0] - m[2][2] ) * 2.0; q = vec4( ( m[1][0] + m[0][1] ) / s, 0.25 * s, ( m[2][1] + m[1][2] ) / s, ( m[2][0] - m[0][2] ) / s ); }',
    '\telse { float s = sqrt( 1.0 + m[2][2] - m[0][0] - m[1][1] ) * 2.0; q = vec4( ( m[2][0] + m[0][2] ) / s, ( m[2][1] + m[1][2] ) / s, 0.25 * s, ( m[0][1] - m[1][0] ) / s ); }',
    '\treturn normalize( q );',
    '}',
    'vec4 tlDualFromMat( mat4 m, vec4 q ) { vec3 t = m[3].xyz; return 0.5 * vec4( q.w * t + cross( t, q.xyz ), -dot( t, q.xyz ) ); }',
    'void tlDQBlend( mat4 mX, mat4 mY, mat4 mZ, mat4 mW, vec4 w, out vec4 b0, out vec4 bd ) {',
    '\tvec4 qX = tlQuatFromMat( mX ), qY = tlQuatFromMat( mY ), qZ = tlQuatFromMat( mZ ), qW = tlQuatFromMat( mW );',
    '\tfloat sY = dot( qX, qY ) < 0.0 ? -1.0 : 1.0, sZ = dot( qX, qZ ) < 0.0 ? -1.0 : 1.0, sW = dot( qX, qW ) < 0.0 ? -1.0 : 1.0;',
    '\tb0 = w.x * qX + w.y * sY * qY + w.z * sZ * qZ + w.w * sW * qW;',
    '\tbd = w.x * tlDualFromMat( mX, qX ) + w.y * sY * tlDualFromMat( mY, qY ) + w.z * sZ * tlDualFromMat( mZ, qZ ) + w.w * sW * tlDualFromMat( mW, qW );',
    '\tfloat len = max( length( b0 ), 1e-6 ); b0 /= len; bd /= len;',
    '}',
    'vec3 tlDQRotate( vec4 b0, vec3 v ) { return v + 2.0 * cross( b0.xyz, cross( b0.xyz, v ) + b0.w * v ); }',
    'vec3 tlDQTransform( vec4 b0, vec4 bd, vec3 v ) { return tlDQRotate( b0, v ) + 2.0 * ( b0.w * bd.xyz - bd.w * b0.xyz + cross( b0.xyz, bd.xyz ) ); }',
    ''
  ].join('\n');
  // Round-4 review ("a 2-4 cm pale stretched wedge still protrudes from the armpit floor at 170-180°"): under DQS every mixed-weight
  // vertex of the axilla (≈ 5 cm from the joint centre by anatomy) swings out on a screw motion — a vertex at 50 % rotates 85° and
  // lands 1-2 cm OUTSIDE the shoulder: the fin. Under LBS the same vertex collapses toward the joint, INSIDE the shoulder, so the
  // crease reads as a fold. Per-vertex `tlDqs` (geometry attribute, 0 within 7.5 cm of a shoulder joint → 1 beyond 11.5 cm) mixes
  // linear-blend positions / normals into the dual-quaternion result: LBS at the axilla, DQS everywhere else (elbows, knees, the
  // forearm twist that motivated DQS). Compared in body-lab (`?skin=lbs|dqs`, shots r4c_armpit_*).
  var DQS_NORMAL = [
    '#ifdef USE_SKINNING',
    '\t{ vec4 tlB0, tlBd; tlDQBlend( boneMatX, boneMatY, boneMatZ, boneMatW, skinWeight, tlB0, tlBd );',
    '\tmat4 tlSkinM = skinWeight.x * boneMatX + skinWeight.y * boneMatY + skinWeight.z * boneMatZ + skinWeight.w * boneMatW; tlSkinM = bindMatrixInverse * tlSkinM * bindMatrix;',
    '\tvec3 tlN = ( bindMatrix * vec4( objectNormal, 0.0 ) ).xyz; vec3 tlNd = ( bindMatrixInverse * vec4( tlDQRotate( tlB0, tlN ), 0.0 ) ).xyz; vec3 tlNl = vec4( tlSkinM * vec4( objectNormal, 0.0 ) ).xyz;',
    '\tobjectNormal = normalize( mix( tlNl, tlNd, tlDqs ) );',
    '\t#ifdef USE_TANGENT',
    '\t\tvec3 tlT = ( bindMatrix * vec4( objectTangent, 0.0 ) ).xyz; vec3 tlTd = ( bindMatrixInverse * vec4( tlDQRotate( tlB0, tlT ), 0.0 ) ).xyz; vec3 tlTl = vec4( tlSkinM * vec4( objectTangent, 0.0 ) ).xyz;',
    '\t\tobjectTangent = normalize( mix( tlTl, tlTd, tlDqs ) );',
    '\t#endif',
    '\t}',
    '#endif',
    ''
  ].join('\n');
  var DQS_POS = [
    '#ifdef USE_SKINNING',
    '\t{ vec4 tlB0, tlBd; tlDQBlend( boneMatX, boneMatY, boneMatZ, boneMatW, skinWeight, tlB0, tlBd );',
    '\tvec4 skinVertex = bindMatrix * vec4( transformed, 1.0 );',
    '\tvec3 tlPd = ( bindMatrixInverse * vec4( tlDQTransform( tlB0, tlBd, skinVertex.xyz ), 1.0 ) ).xyz;',
    '\tvec4 tlSk = boneMatX * skinVertex * skinWeight.x; tlSk += boneMatY * skinVertex * skinWeight.y; tlSk += boneMatZ * skinVertex * skinWeight.z; tlSk += boneMatW * skinVertex * skinWeight.w;',
    '\tvec3 tlPl = ( bindMatrixInverse * tlSk ).xyz;',
    '\ttransformed = mix( tlPl, tlPd, tlDqs ); }',
    '#endif',
    ''
  ].join('\n');
  function enableDualQuaternionSkinning(THREE, m) {
    if (!m || !m.isMaterial || m.userData.tlDQS) return m;
    var proto = THREE.Material.prototype;
    var prev = (typeof m.onBeforeCompile === 'function' && m.onBeforeCompile !== proto.onBeforeCompile) ? m.onBeforeCompile : null;
    var prevKey = (typeof m.customProgramCacheKey === 'function' && m.customProgramCacheKey !== proto.customProgramCacheKey) ? m.customProgramCacheKey : null;
    m.onBeforeCompile = function (shader, renderer) {
      if (prev) prev.call(m, shader, renderer);
      var vs = shader.vertexShader;
      if (vs.indexOf('#include <skinning_vertex>') < 0) return;
      vs = vs.replace('#include <common>', '#include <common>\n' + DQS_PARS).replace('#include <skinnormal_vertex>', DQS_NORMAL).replace('#include <skinning_vertex>', DQS_POS);
      shader.vertexShader = vs;
    };
    m.customProgramCacheKey = function () { return (prevKey ? prevKey.call(m) : m.type) + '|tl-dqs-v2'; };   // v2: hybrid LBS/DQS by the tlDqs attribute
    m.userData.tlDQS = true;
    m.needsUpdate = true;
    return m;
  }

  // ───────────────────────────── goggles (rigid, parented to the head bone; head-local coords) ─────────────────────────────
  // Round-3 review ("goggle gasket hangs 2-3 cm off the cheek in profile"): the gasket used to sit at a FIXED head-local depth. Now
  // the skin depth is sampled from the body field along the lens normal at 12 points around each gasket ring (the orbit rim: brow
  // above, cheekbone below) and the gasket's back face is placed on the median of those depths (a soft TPE gasket compresses a
  // little into the skin), the lens 7 mm in front of it. Returns the seated depth along the normal, or null without a field.
  function seatGasket(build, cx, cy, cz, rotX, rotY, a, b) {
    if (!build || !build.prims || !build.frames || !build.frames.head) return null;
    var hf = build.frames.head, prims = build.prims, sc = new Float64Array(prims.length);
    var cols = eulerToAxes(rotX / DEG, rotY / DEG, 0), ex = cols[0], ey = cols[1], n = cols[2];
    var ts = [];
    for (var i = 0; i < 12; i++) {
      var ph = i / 12 * Math.PI * 2, px = cx + ex[0] * a * Math.cos(ph) + ey[0] * b * Math.sin(ph), py = cy + ex[1] * a * Math.cos(ph) + ey[1] * b * Math.sin(ph), pz = cz + ex[2] * a * Math.cos(ph) + ey[2] * b * Math.sin(ph);
      var prevF = 1, prevT = 0.03, hit = null;
      for (var t = 0.03; t >= -0.06; t -= 0.002) {
        var w = frameXform(hf, [px + n[0] * t, py + n[1] * t, pz + n[2] * t]);
        var f = evalField(w[0], w[1], w[2], prims, sc);
        if (f < 0) { hit = prevF > 0 && prevF < 1e8 ? prevT + (t - prevT) * prevF / (prevF - f) : t; break; }
        prevF = f; prevT = t;
      }
      if (hit !== null) ts.push(hit);
    }
    if (ts.length < 6) return null;
    ts.sort(function (p, q) { return p - q; });
    return ts[Math.floor(ts.length * 0.5)];
  }
  function makeGoggles(THREE, mats, sex, build) {
    var g = new THREE.Group(); g.name = 'goggles';
    var s = sex === 'female' ? 0.96 : 1;
    // Round-1 review: the lenses were two small strips sunk in the orbit. Racing goggles (RESEARCH §B: lens 50 × 32 mm) sit ON the
    // brow and cheekbone, so the lens is 40 mm wide, seated 9 mm further forward, with a visible TPE gasket and a dual strap that
    // clears the cap at the back of the head (the old single strap ran inside the occiput).
    var lensGeo = new THREE.SphereGeometry(1, 28, 18); lensGeo.scale(0.0215 * s, 0.0155 * s, 0.012);
    var gasketGeo = new THREE.TorusGeometry(1, 0.20, 10, 36); gasketGeo.scale(0.0225 * s, 0.0165 * s, 0.024);
    var ys = 0.052, zs = 0.094, seat = {};
    [-1, 1].forEach(function (side) {
      var rx = -0.04, ry = side * 0.30, cx = side * 0.034 * s;
      var skinT = seatGasket(build, cx, ys, zs, rx, ry, 0.0225 * s, 0.0165 * s);   // depth of the orbit rim along the lens normal, relative to zs
      var gz = skinT === null ? zs - 0.007 : zs + skinT + 0.0035;                    // gasket centre: tube half-depth (≈ 4.8 mm) minus ≈ 1 mm of compression
      seat[side < 0 ? 'right' : 'left'] = skinT;
      var cols = eulerToAxes(rx / DEG, ry / DEG, 0), n = cols[2];
      var gasket = new THREE.Mesh(gasketGeo, mats.frame); gasket.position.set(cx + n[0] * (gz - zs), ys + n[1] * (gz - zs), gz); gasket.rotation.y = ry; gasket.rotation.x = rx;
      var lens = new THREE.Mesh(lensGeo, mats.lens); lens.position.set(cx + n[0] * (gz + 0.007 - zs), ys + n[1] * (gz + 0.007 - zs), gz + 0.007); lens.rotation.y = ry; lens.rotation.x = rx;
      g.add(lens); g.add(gasket);
    });
    g.userData.seat = seat;
    var bridgeGeo = new THREE.CylinderGeometry(0.003, 0.003, 0.024 * s, 8); bridgeGeo.rotateZ(Math.PI / 2);
    var bridgeZ = (seat.left !== null && seat.left !== undefined) ? zs + seat.left + 0.0075 : zs - 0.006;
    var bridge = new THREE.Mesh(bridgeGeo, mats.frame); bridge.position.set(0, ys + 0.001, bridgeZ); g.add(bridge);
    var strapGeo = new THREE.CylinderGeometry(1, 1, 0.007, 64, 1, true); strapGeo.scale(0.0845 * s, 1, 0.115 * s);
    [-0.006, 0.006].forEach(function (dy) { var strap = new THREE.Mesh(strapGeo, mats.strap); strap.position.set(0, ys + 0.008 + dy, -0.018); strap.rotation.x = 0.10; g.add(strap); });
    var clipGeo = new THREE.BoxGeometry(0.012, 0.020, 0.007);
    [-1, 1].forEach(function (side) {
      var clip = new THREE.Mesh(clipGeo, mats.frame); clip.position.set(side * 0.076 * s, ys + 0.006, 0.030); clip.rotation.y = side * 0.9; g.add(clip);
    });
    g.traverse(function (o) { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });   // the head bone's bounding sphere is not the goggles'
    g.userData.geometries = [lensGeo, gasketGeo, bridgeGeo, strapGeo, clipGeo];
    return g;
  }

  // ───────────────────────────── rig assembly ─────────────────────────────
  function assembleRig(THREE, opts, build) {
    var sk = build.skeletonBones, byName = sk.byName, bones = sk.bones;
    var m = build.mesh;
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(m.position, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(m.normal, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(m.uv, 2));
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(m.skinIndex, 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(m.skinWeight, 4));
    // Round-4: hybrid skinning weight per vertex — linear blend within 7.5 cm of a shoulder joint (the axilla collapses into a
    // fold instead of swinging out as a DQS fin), dual quaternion beyond 11.5 cm; positions are the bind (A-pose) body frame.
    var nvv = m.position.length / 3, tlDqs = new Float32Array(nvv), shL = build.frames.shoulderL.o, shR = build.frames.shoulderR.o;
    for (var vi = 0; vi < nvv; vi++) {
      var vx = m.position[vi * 3], vy = m.position[vi * 3 + 1], vz = m.position[vi * 3 + 2];
      var dL = Math.sqrt((vx - shL[0]) * (vx - shL[0]) + (vy - shL[1]) * (vy - shL[1]) + (vz - shL[2]) * (vz - shL[2]));
      var dR = Math.sqrt((vx - shR[0]) * (vx - shR[0]) + (vy - shR[1]) * (vy - shR[1]) + (vz - shR[2]) * (vz - shR[2]));
      tlDqs[vi] = smoothstep(opts.dqsRadius, opts.dqsRadius + 0.04, Math.min(dL, dR));
    }
    geo.setAttribute('tlDqs', new THREE.Float32BufferAttribute(tlDqs, 1));
    geo.setIndex(new THREE.BufferAttribute(m.index, 1));
    m.groups.forEach(function (g) { geo.addGroup(g.start, g.count, g.materialIndex); });
    geo.computeBoundingSphere();
    var mats = makeMaterials(THREE, opts);
    var skin = new THREE.SkinnedMesh(geo, [mats.skin, mats.suit, mats.cap]);
    skin.name = 'humanSkin'; skin.frustumCulled = false; skin.castShadow = true; skin.receiveShadow = true;
    var root = new THREE.Group(); root.name = 'humanRoot';
    root.add(skin); skin.add(byName.hips);
    // bind in the BUILD pose (A-pose), then return to the driver's rest pose
    setBuildPose(byName, true);
    root.updateMatrixWorld(true);
    var skeleton = new THREE.Skeleton(bones);
    skin.bind(skeleton);
    setBuildPose(byName, false);
    root.updateMatrixWorld(true);
    // goggles
    var goggles = makeGoggles(THREE, mats, build.sex, build);
    byName.head.add(goggles);
    // Round-3 review ("shoulder at 180° tears from below into a sharp-edged axillary flap; the female strap lifts as a fin"): linear
    // blend skinning collapses every mixed-weight vertex toward the joint when the two transforms are 180° apart — the armpit web
    // became a sheet through the shoulder. The three skinned materials (and the shadow depth material) now skin with DUAL
    // QUATERNIONS (Kavan 2007): the blend is a screw motion, so the web rotates around the joint as a smooth hollow instead of
    // collapsing, and the forearm twist bone rolls the skin without a candy wrapper. Bones and weights are untouched.
    // opts.skinning: 'dqs' (default) | 'lbs' (three's linear blend — for A/B comparison in the labs and tests).
    if (opts.skinning === 'dqs') {
      [mats.skin, mats.suit, mats.cap].forEach(function (mm) { enableDualQuaternionSkinning(THREE, mm); });
      var depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, skinning: true });
      enableDualQuaternionSkinning(THREE, depthMat);
      skin.customDepthMaterial = depthMat;
      mats.own.push(depthMat);
    }
    var xray = null, xrayOn = false, disposed = false;
    var rig = {
      root: root, hips: byName.hips, spine: byName.spine, neck: byName.neck, head: byName.head,
      armL: { shoulder: byName.shoulderL, upperArm: byName.upperArmL, elbow: byName.elbowL, forearm: byName.forearmL, forearmTwist: byName.forearmTwistL, wrist: byName.wristL, hand: byName.handL,
              fingers: [byName.thumbL, byName.finger0L, byName.finger1L, byName.finger2L, byName.finger3L] },
      armR: { shoulder: byName.shoulderR, upperArm: byName.upperArmR, elbow: byName.elbowR, forearm: byName.forearmR, forearmTwist: byName.forearmTwistR, wrist: byName.wristR, hand: byName.handR,
              fingers: [byName.thumbR, byName.finger0R, byName.finger1R, byName.finger2R, byName.finger3R] },
      legL: { hipJ: byName.hipJL, thigh: byName.thighL, knee: byName.kneeL, shin: byName.shinL, ankle: byName.ankleL, foot: byName.footL },
      legR: { hipJ: byName.hipJR, thigh: byName.thighR, knee: byName.kneeR, shin: byName.shinR, ankle: byName.ankleR, foot: byName.footR },
      mat: mats.skin, matDim: mats.suit,
      skin: skin, skeleton: skeleton, bones: bones, boneNames: BONE_DEFS.map(function (d) { return d[0]; }),
      extras: { goggles: goggles }, materials: mats,
      sex: build.sex, quality: build.quality, stats: { triangles: m.triangles, vertices: m.vertices, timings: build.timings, groups: build.groupCounts, materialSource: mats.source, activeBlocks: build.activeBlocks, voxel: build.grid.h, droppedDegenerate: build.droppedDegenerate, droppedIslands: build.droppedIslands || 0 || 0 },
      // Round-1 review: a cap dyed the suit colour read as a mint/yellow balloon; real caps are plain (white/black) so the suit
      // colour no longer drives the cap unless opts.capFollowsSuit. setCapColor recolours the cap on its own.
      setSuitColor: function (hex) {
        hex = toHex(THREE, hex, NaN); if (hex !== hex) return;          // NaN / undefined / garbage: keep the current colour
        var TM = opts.materials;
        if (mats.source === 'TL_HumanMaterials' && TM && typeof TM.setSuitColor === 'function') TM.setSuitColor(mats.suit, hex);
        else if (mats.suit.color) mats.suit.color.setHex(hex);
        mats.suit.userData.colorHex = hex;
        if (opts.capFollowsSuit) rig.setCapColor(hex);
      },
      setCapColor: function (hex) {
        hex = toHex(THREE, hex, NaN); if (hex !== hex) return;
        var TM = opts.materials;
        if (mats.source === 'TL_HumanMaterials' && TM && typeof TM.setCapColor === 'function') TM.setCapColor(mats.cap, hex);
        else if (mats.cap.color) mats.cap.color.setHex(hex);
        mats.cap.userData.colorHex = hex;
      },
      setXray: function (on) {
        on = !!on; if (on === xrayOn) return; xrayOn = on;
        [mats.skin, mats.suit, mats.cap].forEach(function (mm) {
          if (on) { mm.userData._tl = { t: mm.transparent, o: mm.opacity, dw: mm.depthWrite }; mm.transparent = true; mm.opacity = 0.22; mm.depthWrite = false; }
          else if (mm.userData._tl) { mm.transparent = mm.userData._tl.t; mm.opacity = mm.userData._tl.o; mm.depthWrite = mm.userData._tl.dw; }
          mm.needsUpdate = true;
        });
        goggles.visible = !on;
        if (on && !xray) {
          xray = new THREE.Group(); xray.name = 'xray';
          // r128 SkeletonHelper(obj) builds its lines in obj.matrixWorld-local space and sets its own matrix = obj.matrixWorld,
          // which is only right when the helper is parented to an identity node (the scene). Ours is parented to `root`, which
          // carries the driver's roll, so: helper root = `root` itself and helper.matrix = identity → world = root.mw · root.mw⁻¹ · bone.mw.
          var helper = new THREE.SkeletonHelper(root); helper.matrix = new THREE.Matrix4(); helper.matrixAutoUpdate = false;
          helper.material.linewidth = 2; helper.frustumCulled = false; xray.add(helper);
          var sg = new THREE.SphereGeometry(0.016, 12, 8), sm = new THREE.MeshBasicMaterial({ color: 0x00e5ff });
          var driven = { shoulderL: 1, shoulderR: 1, elbowL: 1, elbowR: 1, hipJL: 1, hipJR: 1, kneeL: 1, kneeR: 1, spine: 1, neck: 1, hips: 1, wristL: 1, wristR: 1, ankleL: 1, ankleR: 1, head: 1 };
          Object.keys(driven).forEach(function (n) { var sp = new THREE.Mesh(sg, sm); sp.name = 'joint_' + n; byName[n].add(sp); xray.userData = xray.userData || {}; (xray.userData.spheres = xray.userData.spheres || []).push(sp); });
          xray.userData.geo = sg; xray.userData.mat = sm; xray.userData.helper = helper;
          root.add(xray);
          rig.extras.xray = xray;
        }
        if (xray) { xray.visible = on; (xray.userData.spheres || []).forEach(function (sp) { sp.visible = on; }); }
      },
      dispose: function () {
        if (disposed) return; disposed = true;
        geo.dispose();
        // own materials only — the shared causticsTex / envMap belong to the site (SPEC §9.1); TL_HumanMaterials' textures are
        // its own cache (TL_HumanMaterials.disposeShared) and its materials unregister themselves on 'dispose'
        mats.own.forEach(function (mm) { if (mm && mm.dispose) mm.dispose(); });
        (goggles.userData.geometries || []).forEach(function (gg) { gg.dispose(); });
        if (byName.head.children.indexOf(goggles) >= 0) byName.head.remove(goggles);
        if (xray) {
          xray.userData.geo.dispose(); xray.userData.mat.dispose();
          if (xray.userData.helper.geometry) xray.userData.helper.geometry.dispose(); if (xray.userData.helper.material) xray.userData.helper.material.dispose();
          (xray.userData.spheres || []).forEach(function (sp) { if (sp.parent) sp.parent.remove(sp); });
          root.remove(xray);
        }
        if (skeleton.dispose) skeleton.dispose();
        if (root.parent) root.parent.remove(root);
      },
      // debug / test access
      _build: build
    };
    return rig;
  }

  // ───────────────────────────── public API ─────────────────────────────
  function getTHREE() { var T = G.THREE; if (!T) throw new Error('TL_Human: THREE not loaded'); return T; }
  var DEFAULT_SUIT = 0x00d4ff, DEFAULT_CAP = 0xf2f2ee;   // white silicone cap (round-1: no more suit-coloured balloon)
  function isTex(t) { return !!(t && typeof t === 'object' && t.isTexture); }
  function finiteOr(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  // Colour → hex number. Accepts a finite number, a CSS string ('#ff0000', 'red') or a THREE.Color; anything else → the default.
  function toHex(THREE, c, d) {
    if (typeof c === 'number') return isFinite(c) ? (c >>> 0) & 0xffffff : d;
    if (c && typeof c === 'object' && c.isColor) return c.getHex();
    if (typeof c === 'string' && c.length) { try { var col = new THREE.Color(c); return col.getHex(); } catch (e) { return d; } }
    return d;
  }
  // Every option is validated here (SPEC §9.1). Garbage never reaches the pipeline: unknown sex/quality/tone → defaults, NaN →
  // default, voxel/taubin/targetTris clamped to ranges that cannot hang or blow the memory budget, textures must be THREE textures.
  function normOpts(THREE, opts) {
    opts = (opts && typeof opts === 'object') ? opts : {};
    var TUNE = (G.TL_HUMAN_TUNE && typeof G.TL_HUMAN_TUNE === 'object') ? G.TL_HUMAN_TUNE : {};   // round-4 lab overrides (see below)
    var sex = (typeof opts.sex === 'string' && opts.sex.toLowerCase() === 'female') ? 'female' : 'male';
    var quality = (typeof opts.quality === 'string' && Object.prototype.hasOwnProperty.call(QUALITY, opts.quality)) ? opts.quality : 'medium';
    var tone = opts.skinTone;
    if (typeof tone === 'number') tone = isFinite(tone) ? ((tone >>> 0) & 0xffffff) : 'medium';
    else if (!(typeof tone === 'string' && Object.prototype.hasOwnProperty.call(SKIN_TONES, tone))) tone = 'medium';
    var voxel = finiteOr(opts.voxel, undefined); if (voxel !== undefined) voxel = clamp(voxel, 0.005, 0.03);
    var taubin = finiteOr(opts.taubin, undefined); if (taubin !== undefined) taubin = clamp(Math.round(taubin), 0, 10);
    var target = finiteOr(opts.targetTris, undefined); if (target !== undefined) target = (target >= 1000) ? Math.floor(target) : undefined;
    var mats = opts.materials;
    if (mats === undefined) mats = G.TL_HumanMaterials || null;                       // default: the global module when loaded
    if (!(mats && typeof mats === 'object' && typeof mats.makeSkin === 'function')) mats = null;   // null / {} / garbage → fallback
    return { sex: sex, quality: quality, suitColor: toHex(THREE, opts.suitColor, DEFAULT_SUIT), capColor: toHex(THREE, opts.capColor, DEFAULT_CAP), capFollowsSuit: !!opts.capFollowsSuit, skinTone: tone, materials: mats,
      causticsTex: isTex(opts.causticsTex) ? opts.causticsTex : null, envMap: isTex(opts.envMap) ? opts.envMap : null,
      voxel: voxel, taubin: taubin, targetTris: target, debug: !!opts.debug, skinning: opts.skinning === 'lbs' ? 'lbs' : 'dqs',
      // round-4 (labs / tests): shoulder-neighbourhood weight smoothing / sharpening and the LBS radius of the hybrid skinning
      // (steps 8b', 8b'', assembleRig); a global TL_HUMAN_TUNE {lapNear, lapRadius, lapGamma, dqsRadius} overrides the defaults
      // so the preview can rebuild with different numbers without reloading the module.
      lapNear: clamp(Math.round(finiteOr(opts.lapNear, finiteOr(TUNE.lapNear, LAP_NEAR_PASSES))), 0, 30), lapRadius: clamp(finiteOr(opts.lapRadius, finiteOr(TUNE.lapRadius, LAP_NEAR_RADIUS)), 0, 0.3),
      lapGamma: clamp(finiteOr(opts.lapGamma, finiteOr(TUNE.lapGamma, LAP_NEAR_GAMMA)), 0.25, 12), dqsRadius: clamp(finiteOr(opts.dqsRadius, finiteOr(TUNE.dqsRadius, DQS_LBS_RADIUS)), 0, 0.3) };
  }
  function buildHumanSwimmer(opts) {
    var THREE = getTHREE(); opts = normOpts(THREE, opts);
    var build = { sex: opts.sex, quality: opts.quality };
    var it = pipeline(THREE, opts, build);
    while (!it.next().done) { /* run to completion */ }
    return assembleRig(THREE, opts, build);
  }
  // yield to the event loop: setImmediate where it exists (node: a MessageChannel port with a listener would keep the process
  // alive for ever), else MessageChannel (browsers: no 4 ms clamp, not throttled to 1 Hz in background tabs), else setTimeout.
  var _mc = null;
  function defer(fn) {
    if (typeof setImmediate === 'function') { setImmediate(fn); return; }
    if (typeof MessageChannel !== 'undefined') {
      if (!_mc) { _mc = new MessageChannel(); _mc.queue = []; _mc.port1.onmessage = function () { var f = _mc.queue.shift(); if (f) f(); }; }
      _mc.queue.push(fn); _mc.port2.postMessage(0);
    } else setTimeout(fn, 0);
  }
  function buildHumanSwimmerAsync(opts, onProgress) {
    return new Promise(function (resolve, reject) {
      var THREE;
      try { THREE = getTHREE(); opts = normOpts(THREE, opts); } catch (e) { reject(e); return; }
      var build = { sex: opts.sex, quality: opts.quality };
      var it = pipeline(THREE, opts, build);
      function step() {
        try {
          var r = it.next();
          if (r.done) { if (onProgress) onProgress(1, 'done'); resolve(assembleRig(THREE, opts, build)); return; }
          if (onProgress) onProgress(r.value.p, r.value.stage);
          defer(step);
        } catch (e) { reject(e); }
      }
      defer(step);
    });
  }

  G.TL_Human = {
    VERSION: VERSION,
    buildHumanSwimmer: buildHumanSwimmer,
    buildHumanSwimmerAsync: buildHumanSwimmerAsync,
    QUALITY: QUALITY,
    BONE_DEFS: BONE_DEFS,
    A_POSE_DEG: A_POSE_DEG,
    // internals exposed for tests / tuning
    _internals: { anatomy: anatomy, evalField: evalField, compilePrims: compilePrims, makeBones: makeBones, extractFrames: extractFrames, decimateGen: decimateGen, splitMesh: splitMesh, EDGE_TABLE: EDGE_TABLE, TRI_TABLE: TRI_TABLE }
  };
})();
