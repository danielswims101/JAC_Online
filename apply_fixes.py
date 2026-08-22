#!/usr/bin/env python3
"""
TIDELYNE / JAC_Online — review fix patcher
========================================
Run this ONCE in the folder that contains index.html:

    python3 apply_fixes.py

It backs up index.html to index.html.backup, applies every code fix from the
review, and prints a report. Any patch whose anchor text isn't found is SKIPPED
and reported — it can never corrupt the file. Safe to re-run (already-applied
patches just report "already applied").

Covers:
  1  Pace Zones columns doubled  <-- the dangerous one
  2  Forgot-password silent failure (wrong element id)
  3  Password reset email redirect
  4  Training log date used UTC (could log tomorrow)
  5  GLTFLoader 0.128 vs engine r160 mismatch
  6  Workout formatter could inject unescaped AI HTML
  7  Duplicate stream-bubble id
  8  YouTube iframes missing allow/title
  9  Invalid #hash left in history
 10  Golf/HR scale never explained as a 10-second count
 11  Pool converter presented as exact
 12  Zones page: 5 bars but only 3 cards
 13  Season table shows a finished season
 14  Mobile: sub-44px targets, phase bar hidden
 15  A11y: skip link, <main>, canvas name, contrast, reduced-motion
 16  Print stylesheet leaked banner/tabs/3D chrome
 17  Every view shared one document title
 18  AI Coach never highlighted in nav
 19  Footer links to the new legal pages
"""
import re, sys, os, shutil

SRC = "index.html"
if not os.path.exists(SRC):
    sys.exit("ERROR: run this in the folder that contains index.html")

html = open(SRC, encoding="utf-8").read()
original = html
applied, skipped, already = [], [], []


def patch(name, old, new, marker=None, count=1):
    """Exact string replacement with reporting.

    `marker` is a fragment unique to the PATCHED file. Insert-style patches
    keep their own anchor inside the replacement, so without a marker a second
    run would happily insert the block again. With it, re-running is a no-op.
    """
    global html
    seen = marker if marker is not None else new
    if seen in html:
        already.append(name); return
    if old not in html:
        skipped.append(name); return
    html = html.replace(old, new, count)
    applied.append(name)


def patch_re(name, pattern, repl, flags=0):
    global html
    new_html, n = re.subn(pattern, repl, html, flags=flags)
    if n == 0:
        skipped.append(name); return
    html = new_html
    applied.append(f"{name} ({n}x)")


# ── 1. PACE ZONES: both columns were doubled ────────────────────────────────
# t is already a 100m time, so "per 100m" must NOT be multiplied by 2.
patch("1. Pace Zones column swap (CRITICAL)",
  "<td>${formatTime(fast*2)}–${formatTime(slow*2)}</td><td>${formatTime(fast)}–${formatTime(slow)}</td>",
  "<td>${formatTime(fast)}–${formatTime(slow)}</td><td>${formatTime(fast/2)}–${formatTime(slow/2)}</td>")

# ── 2. Forgot-password wrote to an element that doesn't exist ───────────────
patch("2. Forgot-password error id",
  "  var el = document.getElementById(screenPrefix + '-error');",
  "  var el = document.getElementById(screenPrefix + '-error') || document.getElementById(screenPrefix + '-msg');")

# ── 3. Reset email now returns to THIS page ────────────────────────────────
patch("3. Password reset redirectTo",
  "await sb.auth.resetPasswordForEmail(email);",
  "await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });")

# ── 4. Log date defaulted to UTC — an evening US user logged tomorrow ──────
patch("4. Training log local date",
  "if(todayInput) todayInput.value=new Date().toISOString().split('T')[0];",
  "if(todayInput){const _d=new Date();_d.setMinutes(_d.getMinutes()-_d.getTimezoneOffset());todayInput.value=_d.toISOString().split('T')[0];}")

# ── 5. GLTFLoader version mismatch (0.128 script vs r160 engine) ───────────
patch("5. GLTFLoader r160 via module import",
  """  gltfLoaderState = 'loading';
  const s = document.createElement('script');
  s.src = GLTF_LOADER_URL;
  s.onload = function(){ gltfLoaderState = 'ready'; cb(); };
  s.onerror = function(){ gltfLoaderState = 'failed'; humanStatus('3D model loader unavailable — mannequin shown.'); applyModelVisibility(); };
  document.head.appendChild(s);""",
  """  gltfLoaderState = 'loading';
  // r160 ships GLTFLoader as an ES module only — a 0.128 <script> tag would
  // load a loader that can't talk to this engine.
  import('three/addons/loaders/GLTFLoader.js').then(function(m){
    THREE.GLTFLoader = m.GLTFLoader; gltfLoaderState = 'ready'; cb();
  }).catch(function(){
    gltfLoaderState = 'failed';
    humanStatus('3D model loader unavailable — showing the built-in swimmer.');
    applyModelVisibility();
  });""")

# ── 6. Workout formatter fallback dumped raw model output ──────────────────
patch("6. Workout formatter escapes fallback",
  "  return html||'<p>'+text+'</p>';",
  "  return html||'<p>'+escapeHTML(text)+'</p>';")

# ── 7. Two live streams could share one element id ────────────────────────
patch("7. Unique stream bubble id",
  """function createStreamBubble(){
  const msgs=document.getElementById('ai-messages');""",
  """function createStreamBubble(){
  const msgs=document.getElementById('ai-messages');
  // Retire any orphaned bubble so the id is always unique
  const stale=document.getElementById('stream-bubble-active');
  if(stale){stale.id='';stale.classList.remove('streaming');}""",
  marker="Retire any orphaned bubble")

# ── 8. YouTube iframes: permissions + accessible names ────────────────────
patch_re("8. YouTube iframe allow/title",
  r'<iframe src="(https://www\.youtube-nocookie\.com/embed/[\w-]+)" loading="lazy" allowfullscreen>',
  r'<iframe src="\1" loading="lazy" title="Swimming technique video" '
  r'allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" '
  r'referrerpolicy="strict-origin-when-cross-origin" allowfullscreen>')

# ── 9. A junk #hash no longer sticks in history ───────────────────────────
patch("9. Invalid hash cleanup",
  """window.addEventListener('hashchange',()=>{
  const n=(location.hash||'').replace('#','');
  if(n&&document.getElementById('page-'+n)) showPage(n);
});""",
  """window.addEventListener('hashchange',()=>{
  const n=(location.hash||'').replace('#','');
  if(n&&document.getElementById('page-'+n)) showPage(n);
  else if(n){ // unknown hash — don't leave a dead entry in history
    const cur=document.querySelector('.page.active');
    const back=cur?cur.id.replace('page-',''):'home';
    try{history.replaceState(null,'','#'+back);}catch(e){}
  }
});""")

# ── 10. HR "golf scale" is a 10-second count, not bpm ────────────────────
patch("10. Golf/HR scale explained",
  '<div class="section-title">TRAINING <span>ZONES</span></div>',
  '<h1 class="section-title">TRAINING <span>ZONES</span></h1>\n'
  '  <div class="info-box"><strong>Read the HR numbers as a 10-second count, not bpm.</strong> '
  'Stop, find your pulse, count for 10 seconds — "HR 26–28" means 26–28 beats in that 10 seconds '
  '(roughly 156–168 bpm). Lactate values are typical ranges from the literature, not measurements '
  'of you.</div>',
  marker="Read the HR numbers as a 10-second count")

# ── 11. Pool conversion is approximate ───────────────────────────────────
patch("11. Converter accuracy note",
  '<div class="info-box" style="margin-top:1.5rem"><strong>Note:</strong> LCM ~2–3% slower than SCM due to fewer turns.</div>',
  '<div class="info-box" style="margin-top:1.5rem"><strong>Note:</strong> LCM is ~2–3% slower than SCM '
  'because of fewer turns. These are flat approximations for training reference — they are <strong>not</strong> '
  'the official USA Swimming conversion factors, which vary by event and distance. For anything that counts '
  '(cuts, entries, seeding), use the official conversion on '
  '<a href="https://www.usaswimming.org" target="_blank" rel="noopener">usaswimming.org</a>.</div>')

# ── 12. Zones page had 5 bars but only 3 cards ───────────────────────────
patch("12. Zones page missing cards",
  '<div class="card"><div class="badge cyan">Zone 2 — AeT</div>',
  '<div class="card"><div class="badge green">Zone 1</div><h3>RECOVERY</h3><p><strong>Lactate:</strong> '
  'below 1.5 mmol/L · <strong>HR:</strong> under 23 on the 10-second count · Easy enough to hold a full '
  'conversation. Used for warm-up, cool-down, and between hard sets — it clears lactate rather than '
  'building fitness, and going too hard here is the most common way swimmers blunt the next quality set.</p></div>\n'
  '    <div class="card"><div class="badge cyan">Zone 2 — AeT</div>',
  marker="<h3>RECOVERY</h3>")

patch("12b. Zone 5 card",
  '<div class="card"><div class="badge red">Zone 4–5</div><h3>VO₂ MAX & SPRINT</h3>',
  '<div class="card"><div class="badge red">Zone 4–5</div><h3>VO₂ MAX &amp; SPRINT</h3>')

# ── 13. Season table: archive state when the season is over ─────────────
patch("13. Season archive state",
  """  if (tableBody) {
    // Always render chronologically, regardless of array order
    tableBody.innerHTML = SEASON_MEETS.slice().sort((a,b)=>a.start.localeCompare(b.start)).map(m => {""",
  """  // If every listed meet has finished, say so plainly instead of showing a
  // wall of "Completed" — a live calendar that is empty reads as abandoned.
  const allDone = SEASON_MEETS.every(m => now > new Date(m.end + 'T23:59:59'));
  const note = document.getElementById('season-archive-note');
  if (note) {
    note.style.display = allDone ? 'block' : 'none';
    if (allDone) note.innerHTML = 'The 2025–26 national calendar below has finished. Next season\\'s ' +
      'dates are published by USA Swimming — check <a href="https://www.usaswimming.org/events" ' +
      'target="_blank" rel="noopener">usaswimming.org/events</a> for the current schedule. ' +
      'Dates are not guessed here on purpose.';
  }
  if (tableBody) {
    // Always render chronologically, regardless of array order
    tableBody.innerHTML = SEASON_MEETS.slice().sort((a,b)=>a.start.localeCompare(b.start)).map(m => {""",
  marker="const allDone = SEASON_MEETS.every")

patch("13b. Season archive note element",
  '<div class="section-eyebrow" style="margin-top:0">2025–26 National Meet Calendar</div>',
  '<div class="section-eyebrow" style="margin-top:0">2025–26 National Meet Calendar</div>\n'
  '  <div class="warn-box" id="season-archive-note" style="display:none"></div>',
  marker='<div class="warn-box" id="season-archive-note"')

# ── 14/15/16. CSS: touch targets, phase bar, a11y, print ────────────────
CSS_ADDITIONS = """
/* ===== REVIEW FIXES: touch targets, a11y, print ===== */
/* Skip link — first tab stop on every page */
.skip-link{position:absolute;left:-9999px;top:0;z-index:10001;background:var(--cyan);color:var(--navy);
  padding:10px 18px;border-radius:0 0 8px 0;font-family:var(--fm);font-size:0.8rem;font-weight:700}
.skip-link:focus{left:0}
/* Higher-contrast muted text (was ~2.4:1 against navy) */
:root{--white3:#8ba5bd;--white4:#6d879f}
/* Pool-deck touch targets: 44px minimum on phones */
@media(max-width:768px){
  .viz-btn,.btn-sm,.btn-ghost-sm,.qp,.tab-btn,.ai-mode-btn{min-height:44px;display:inline-flex;
    align-items:center;justify-content:center}
  .nav-links li a{line-height:44px;padding:4px 12px;font-size:0.72rem}
  .form-input,.form-select,.form-textarea,.pr-input,.goal-input{min-height:44px}
  .calc-btn,.ai-send{min-height:48px}
}
/* The phase bar is the point of the lab — never hide it, just shrink it */
@media(max-width:480px){
  .viz-phase-bar{display:flex!important;height:34px}
  .phase-step{font-size:0.42rem;letter-spacing:0}
}
/* Reduced motion: also stop the WebGL stroke loop, not just CSS particles */
@media (prefers-reduced-motion: reduce){ .ai-dot{animation:none} }
/* Print: hide the rest of the app chrome so a workout prints clean */
@media print{
  #update-banner,.tabs,.viz-canvas-wrap,.viz-overlay-stats,.force-legend,
  .ai-mode-btns,.ai-header,#human-status,#motion-status,.nav-scroll,
  .cmdk-hint,#mobile-nav{display:none!important}
}
"""
patch("14/15/16. CSS additions (targets, a11y, print)",
  "/* PRINT — clean workout printouts, no dark theme ink waste */",
  CSS_ADDITIONS + "/* PRINT — clean workout printouts, no dark theme ink waste */",
  marker="REVIEW FIXES: touch targets")

# Skip link + <main> landmark
patch("15b. Skip link + main landmark (open)",
  '<body>\n<div class="noise"></div>',
  '<body>\n<a class="skip-link" href="#main">Skip to content</a>\n<div class="noise"></div>',
  marker='class="skip-link"')
patch("15c. main landmark (open)",
  '<!-- HOME PAGE -->\n<div class="page active" id="page-home">',
  '<main id="main">\n<!-- HOME PAGE -->\n<div class="page active" id="page-home">',
  marker='<main id="main">')
patch("15d. main landmark (close)",
  '<!-- AUTH — real Supabase email/password accounts.',
  '</main>\n<!-- AUTH — real Supabase email/password accounts.',
  marker='</main>')

# 3D canvas needs a name + text alternative
patch("15e. 3D canvas accessible name",
  '<div id="viz3d-container"></div>',
  '<div id="viz3d-container" role="img" tabindex="0" aria-label="Interactive 3D swimmer. '
  'Use the stroke and phase buttons below, or the arrow keys, to step through each phase. '
  'Each phase is described in words in the panel underneath."></div>')

# Reduced motion pauses the render loop
patch("15f. Reduced motion pauses WebGL",
  "  buildForceArrows();\n  rebuildSwimmer(currentStroke);",
  "  // Respect the OS 'reduce motion' setting — start paused, user can play.\n"
  "  try{ if(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches){\n"
  "    playing=false; const pb=document.getElementById('vbtn-play');\n"
  "    if(pb){pb.textContent='▶ Play';pb.classList.remove('active');}\n"
  "  } }catch(e){}\n"
  "  buildForceArrows();\n  rebuildSwimmer(currentStroke);",
  marker="Respect the OS 'reduce motion' setting")

# ── 17. Per-page document titles (SEO + screen readers) ─────────────────
patch("17. Per-page document titles",
  "function switchTab(btn,id){",
  """const PAGE_TITLES={
  home:'TIDELYNE Pro — Swimming Technique & Training Tools',
  whatsnew:"What's New — TIDELYNE Pro",
  technique:'Swimming Technique Library — Freestyle, Back, Breast, Fly',
  videos:'Swimming Technique Video Library',
  sets:'Training Set Library — AeT, Threshold, Kick, Speed',
  dryland:'Dryland Training for Swimmers',
  visualizer:'3D Stroke Visualizer — Swimming Biomechanics Lab',
  workouts:'Swim Workout Generator',
  calculator:'Swim Pace Calculators — CSS, Golf Score, Splits, Conversions',
  tempo:'Tempo Trainer — Stroke Rate Metronome',
  zones:'Swim Training Zones — AeT, Threshold, VO2 Max',
  profile:'My PRs & Goal Times',
  log:'Training Log & Weekly Volume',
  nutrition:'Nutrition & Fueling for Swimmers',
  race:'Race Strategy & Meet Day Plan',
  taper:'Taper & Recovery for Swimmers',
  mental:'Mental Performance for Swimmers',
  injury:'Swimming Injury Prevention',
  season:'Season & Meet Calendar',
  ai:'AI Swim Coach'
};
function setPageTitle(name){
  document.title = PAGE_TITLES[name] || 'TIDELYNE Pro';
}
function switchTab(btn,id){""",
  marker="const PAGE_TITLES=")

patch("17b. Title on page change",
  "  if(!alreadyActive) window.scrollTo({top:0,behavior:'smooth'});",
  "  if(!alreadyActive) window.scrollTo({top:0,behavior:'smooth'});\n"
  "  if(typeof setPageTitle==='function') setPageTitle(name);",
  marker="if(typeof setPageTitle==='function')")

# ── 18. AI Coach gets a real nav entry so it highlights ────────────────
patch("18. AI Coach nav item",
  '<li><a href="#whatsnew" id="nav-whatsnew">',
  '<li><a href="#ai" id="nav-ai">AI Coach</a></li>\n      <li><a href="#whatsnew" id="nav-whatsnew">',
  marker='id="nav-ai"')

# ── 19. Footer links to the legal pages ───────────────────────────────
patch("19. Footer legal links",
  '<div class="footer-bottom"><p>TIDELYNE Pro</p><p>Built for serious swimmers</p><p>Informational only — not medical advice</p></div>',
  '<div class="footer-bottom"><p>TIDELYNE Pro</p>'
  '<p><a href="privacy.html">Privacy</a> · <a href="terms.html">Terms</a> · '
  '<a href="disclaimer.html">Medical Disclaimer</a></p>'
  '<p>Educational information only — not medical advice</p></div>')

# ── Legal pages: stamp today's date, flag unfilled placeholders ────────
import datetime
today = datetime.date.today().strftime("%B %-d, %Y") if os.name != "nt" else datetime.date.today().strftime("%B %d, %Y")
todo = []
for page in ("privacy.html", "terms.html", "disclaimer.html"):
    if not os.path.exists(page):
        todo.append(f"{page} is missing — copy it in from the outputs folder")
        continue
    t = open(page, encoding="utf-8").read()
    if "__DATE__" in t:
        t = t.replace("__DATE__", today)
        open(page, "w", encoding="utf-8").write(t)
        applied.append(f"legal: dated {page}")
    for ph, what in (("__CONTACT_EMAIL__", "your contact email"),
                     ("__STATE_OR_COUNTRY__", "your state/country")):
        if ph in t:
            todo.append(f"{page}: replace {ph} with {what}")

# ── Save ───────────────────────────────────────────────────────────────
if html == original:
    print("\nNo changes made — every patch was already applied or no anchors matched.\n")
else:
    shutil.copy(SRC, SRC + ".backup")
    open(SRC, "w", encoding="utf-8").write(html)

print("\n" + "=" * 62)
print("  TIDELYNE fix patcher")
print("=" * 62)
for a in applied:  print("  ✅ APPLIED   ", a)
for a in already:  print("  ⏭  ALREADY   ", a)
for s in skipped:  print("  ⚠️  SKIPPED   ", s, "(anchor not found — file already edited?)")
print("=" * 62)
print(f"  {len(applied)} applied · {len(already)} already done · {len(skipped)} skipped")
if html != original:
    print(f"  Original saved as {SRC}.backup")
print("=" * 62 + "\n")
if todo:
    print("STILL TO DO BY HAND:")
    for t in todo: print("   •", t)
    print()
print("NEXT: open the site, go to Calculator → Pace Zones, enter 1:00.00.")
print("Recovery should now read about 1:16–1:27 per 100m (was 2:33–2:54).\n")
