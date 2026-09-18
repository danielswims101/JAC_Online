#!/usr/bin/env python3
"""
Tidelyne — wire the real logo into index.html
=============================================
Run AFTER copying the logo files into the repo:

    logo-mark.svg  favicon-32.png
    favicon-192.png  apple-touch-180.png  og.png

Then:

    python3 apply_logo.py

Replaces the swimming-emoji favicon, adds the share image, puts the mark in
the nav and the footer, and adds a PWA manifest so "Add to Home Screen"
shows the icon instead of a screenshot. Backs up to index.html.logo.
Safe to run twice.
"""
import os, sys, shutil, json

SRC = "index.html"
if not os.path.exists(SRC):
    sys.exit("ERROR: run this in the folder that contains index.html")

missing = [f for f in ("logo-mark.svg", "favicon-32.png", "favicon-192.png",
                       "apple-touch-180.png", "og.png") if not os.path.exists(f)]
if missing:
    print("⚠️  Missing logo files — copy these in first:")
    for m in missing: print("     ", m)
    print("   (patching index.html anyway; the tags will 404 until you add them)\n")

html = open(SRC, encoding="utf-8").read()
original = html
applied, skipped, already = [], [], []

# Set this once you have the custom domain. Absolute URLs are REQUIRED for
# og:image — Slack and iMessage will not resolve a relative path.
SITE = "https://danielswims101.github.io/JAC_Online"


def patch(name, old, new, marker=None):
    global html
    seen = marker if marker is not None else new
    if seen in html:
        already.append(name); return
    if old not in html:
        skipped.append(name); return
    html = html.replace(old, new, 1)
    applied.append(name)


# ── 1. Replace the emoji favicon with the real icon set ──────────────────
OLD_ICON = '<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 100 100\'%3E%3Ctext y=\'0.9em\' font-size=\'90\'%3E%F0%9F%8F%8A%3C/text%3E%3C/svg%3E">'
NEW_ICONS = f'''<link rel="icon" type="image/svg+xml" href="logo-mark.svg">
<link rel="icon" type="image/png" sizes="32x32" href="favicon-32.png">
<link rel="icon" type="image/png" sizes="192x192" href="favicon-192.png">
<link rel="apple-touch-icon" href="apple-touch-180.png">
<link rel="manifest" href="site.webmanifest">
<meta property="og:image" content="{SITE}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Tidelyne — 3D stroke lab for competitive swimmers">
<meta property="og:site_name" content="Tidelyne">
<meta name="twitter:image" content="{SITE}/og.png">'''

patch("1. Real favicon set + og:image", OLD_ICON, NEW_ICONS,
      marker='href="logo-mark.svg"')

# Upgrade the Twitter card so the image actually shows large
patch("1b. twitter:card large image",
      '<meta name="twitter:card" content="summary">',
      '<meta name="twitter:card" content="summary_large_image">')

# ── 2. Put the mark in the nav, left of the wordmark ────────────────────
patch("2. Logo mark in nav",
  '''<div class="nav-brand" onclick="showPage('home')">TIDE<span>LYNE</span></div>''',
  '''<div class="nav-brand" onclick="showPage('home')" role="link" tabindex="0"
       onkeydown="if(event.key==='Enter')showPage('home')" aria-label="Tidelyne — home">'''
  '''<img src="logo-mark.svg" alt="" width="26" height="26" class="nav-mark">TIDE<span>LYNE</span></div>''',
  marker='class="nav-mark"')

patch("2b. Nav mark styling",
  ".nav-brand span{color:var(--white)}",
  ".nav-brand span{color:var(--white)}\n"
  ".nav-brand{display:flex;align-items:center;gap:9px}\n"
  ".nav-mark{border-radius:6px;flex-shrink:0;display:block}",
  marker=".nav-mark{border-radius")

# ── 3. Footer lockup ───────────────────────────────────────────────────
patch("3. Logo mark in footer",
  '<div class="footer-brand"><h3>TIDE<span>LYNE</span></h3>',
  '<div class="footer-brand">'
  '<img src="logo-mark.svg" alt="" width="40" height="40" '
  'style="border-radius:9px;display:block;margin-bottom:10px">'
  '<h3>TIDE<span>LYNE</span></h3>',
  marker='style="border-radius:9px;display:block;margin-bottom:10px"')

# ── Save ───────────────────────────────────────────────────────────────
if html != original:
    shutil.copy(SRC, SRC + ".logo")
    open(SRC, "w", encoding="utf-8").write(html)

# ── PWA manifest so Add to Home Screen looks like an app ───────────────
manifest = {
    "name": "Tidelyne",
    "short_name": "Tidelyne",
    "description": "3D stroke lab, technique library and pace tools for competitive swimmers.",
    "start_url": "./",
    "display": "standalone",
    "background_color": "#040d18",
    "theme_color": "#040d18",
    "icons": [
        {"src": "favicon-192.png", "sizes": "192x192", "type": "image/png"},
        {"src": "apple-touch-180.png", "sizes": "180x180", "type": "image/png"},
        {"src": "logo-mark.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any"}
    ]
}
if not os.path.exists("site.webmanifest"):
    json.dump(manifest, open("site.webmanifest", "w"), indent=2)
    applied.append("4. site.webmanifest created")
else:
    already.append("4. site.webmanifest")

print("\n" + "=" * 62)
print("  Tidelyne — logo wiring")
print("=" * 62)
for a in applied: print("  ✅ APPLIED   ", a)
for a in already: print("  ⏭  ALREADY   ", a)
for s in skipped: print("  ⚠️  SKIPPED   ", s)
print("-" * 62)
print(f"  {len(applied)} applied · {len(already)} already · {len(skipped)} skipped")
if html != original: print(f"  💾 backup: {SRC}.logo")
print("=" * 62)
print(f"""
AFTER PUSHING
  • Hard-refresh. Favicons cache harder than anything — if the tab still
    shows the swimmer emoji, close the tab entirely and reopen.
  • Test the share image: paste your URL into Slack, iMessage, or
    https://www.opengraph.xyz — you should see the TIDELYNE card.
  • og:image needs an ABSOLUTE url. Currently set to:
        {SITE}/og.png
    When you move to a custom domain, re-run this after editing SITE at the
    top of this file, or find-replace that URL in index.html.
""")
