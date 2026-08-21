#!/usr/bin/env python3
"""
SwimIQ Pro  ->  Tidelyne  (a Scarpline project)
===============================================
Run this in the folder that contains index.html, AFTER apply_fixes.py:

    python3 rename.py

Backs up to index.html.prename, renames every visible instance of the old
brand, and reports anything it couldn't reach.

IMPORTANT — what this deliberately does NOT rename:
  localStorage keys (swimiq_log, swimiq_meet, swimiq_seen_version).
  Those are invisible to users, and renaming them would make every existing
  swimmer's PRs, goals, training log and meet countdown disappear on the next
  visit. They stay as-is on purpose. The lowercase spelling means the
  case-sensitive replacements below can never touch them by accident.
"""
import os, re, shutil, sys

OLD_LONG, OLD_SHORT = "SwimIQ Pro", "SwimIQ"
NEW = "Tidelyne"
COMPANY = "Scarpline"

SRC = "index.html"
if not os.path.exists(SRC):
    sys.exit("ERROR: run this in the folder that contains index.html")

html = open(SRC, encoding="utf-8").read()
original = html
notes = []


def swap(label, old, new):
    global html
    if old not in html:
        notes.append(f"skipped: {label} (already renamed?)"); return
    n = html.count(old)
    html = html.replace(old, new)
    notes.append(f"{label}: {n}x")


# ── 1. Structural bits that carry markup, done before the blanket swap ─────
# Nav wordmark: SWIM|IQ| PRO  ->  TIDE|LYNE|
swap("nav wordmark",
  '''<div class="nav-brand" onclick="showPage('home')">SWIM<span>IQ</span> <span style="font-size:0.65rem;color:var(--gold);font-family:var(--fm);letter-spacing:2px">PRO</span></div>''',
  '''<div class="nav-brand" onclick="showPage('home')">TIDE<span>LYNE</span></div>''')

# Footer wordmark + blurb
swap("footer wordmark",
  '<div class="footer-brand"><h3>SWIM<span>IQ</span></h3>',
  '<div class="footer-brand"><h3>TIDE<span>LYNE</span></h3>')

# Home footer gets the company line
swap("home footer company line",
  '<div class="footer-bottom"><p>SwimIQ Pro</p><p><a href="privacy.html">Privacy</a>',
  '<div class="footer-bottom"><p>Tidelyne — a Scarpline project</p><p><a href="privacy.html">Privacy</a>')

# Export filename + payload tag (lowercase, so handled explicitly)
swap("backup filename", "'swimiq-backup-'", "'tidelyne-backup-'")

# Command palette label
swap("palette aria-label", 'aria-label="Search SwimIQ"', 'aria-label="Search Tidelyne"')

# ── 2. Blanket swap for all remaining visible text ─────────────────────────
# Long form first so "SwimIQ Pro" never becomes "Tidelyne Pro".
swap("'SwimIQ Pro' text", OLD_LONG, NEW)
swap("'SwimIQ' text", OLD_SHORT, NEW)

# ── 3. Sanity: nothing left behind ────────────────────────────────────────
leftovers = re.findall(r"[Ss]wim ?IQ", html)
storage_keys = re.findall(r"swimiq_[a-z_]+", html)

if html != original:
    shutil.copy(SRC, SRC + ".prename")
    open(SRC, "w", encoding="utf-8").write(html)

print("\n" + "=" * 62)
print(f"  {OLD_LONG}  ->  {NEW}   (a {COMPANY} project)")
print("=" * 62)
for n in notes: print("  •", n)
print("-" * 62)
if leftovers:
    print(f"  ⚠️  {len(leftovers)} visible 'SwimIQ' string(s) still left — search the file")
else:
    print("  ✅ no visible 'SwimIQ' text remains")
print(f"  🔒 {len(set(storage_keys))} localStorage key(s) left untouched on purpose:")
for k in sorted(set(storage_keys)): print("       ", k, "  (renaming this would wipe saved user data)")
if html != original:
    print(f"  💾 previous version saved as {SRC}.prename")
print("=" * 62)
print("""
STILL YOURS TO DO
  1. Buy the domain. Check tidelyne.com at a registrar — search results
     can't tell you if it's parked.
  2. Before you ever charge money, run BOTH names through the USPTO
     trademark database (tmsearch.uspto.gov). A web search is not a
     trademark search.
  3. Update robots.txt and sitemap.xml with the real domain once you have it.
  4. Rename the GitHub repo from JAC_Online to tidelyne, so the URL stops
     looking like homework.
""")
