# Tidelyne

A free training platform for competitive swimmers — technique library, an
interactive 3D stroke-biomechanics lab, pace/time calculators, a training log,
race-day and taper guidance, and an AI swim coach.

**Live site:** https://danielswims101.github.io/JAC_Online/

## What's in here

| Path | Purpose |
| --- | --- |
| `index.html` | The whole app — one self-contained file (inline CSS/JS, hash-routed sections, a lazily-loaded Three.js visualizer, calculators, training log). |
| `privacy.html`, `terms.html`, `disclaimer.html` | Legal pages. |
| `robots.txt`, `sitemap.xml`, `site.webmanifest` | SEO / PWA. |
| `logo-*.svg`, `favicon-*.png`, `apple-touch-180.png`, `og.png` | Brand assets. |
| `tools/` | Build/one-shot scripts (logo generation, past migrations). **Not part of the site** — kept for maintenance only. |

## Stack

- Static site hosted on **GitHub Pages** — no build step; `index.html` is the deployed artifact.
- **Three.js r128** (loaded from jsDelivr, on demand) powers the 3D stroke lab.
- **Supabase** handles email/password accounts and gates the AI features; the AI itself runs in a Supabase Edge Function (`ask-ai`) that holds the server-side key and enforces the rate limit (20 messages / 5 hours). Only the public anon key ships in the page.
- Google Fonts for typography; technique videos embed via `youtube-nocookie.com`.

## Local preview

```bash
python3 -m http.server 8000
# then open http://localhost:8000/
```

## Regenerating brand assets

The logo and favicons are produced by the scripts in `tools/` (see `tools/make_logo.py`). Run them if you change the mark; they overwrite the SVG/PNG assets in the repo root.

## Data & privacy

Personal data (swimmer name, PRs, training log) is stored only in the visitor's browser via `localStorage`; the **Export Backup** button on the My PRs page downloads it as JSON so it can be restored on another device. See `privacy.html` for the full policy.

## Notice

This is a personal, all-rights-reserved project. See [`LICENSE`](LICENSE) and `terms.html`. Informational only — not medical, coaching, or dietetic advice.
