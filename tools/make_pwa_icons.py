#!/usr/bin/env python3
"""
Tidelyne PWA icon generator
===========================
    python3 make_pwa_icons.py [--out DIR]

Outputs (into --out, default: the current directory):
    icon-512.png            purpose "any"      — the mark exactly as the favicon
                                                 draws it, at 512 px
    icon-512-maskable.png   purpose "maskable" — the mark scaled to 80 % and
                                                 centred on full-bleed brand navy
                                                 (#040d18). The waves (62 % of the
                                                 mark) sit inside the safe-zone
                                                 circle; only the badge's own
                                                 near-identical navy corners can
                                                 be clipped by a circular mask
    favicon.ico             32 px + 16 px BMP entries for legacy clients, link
                                                 unfurlers and crawlers that request
                                                 /favicon.ico unconditionally

The mark geometry is taken from tools/make_logo.py when this script sits next
to it (`from make_logo import draw_mark`), so the app icon can never drift from
the favicon. If that module is not importable, a verbatim copy of its wave data
and draw_mark() below is used instead — keep the copy in sync if the mark
changes.

Safe-zone reference: W3C Web App Manifest, "Icon masks and safe zone" — the
safe zone is a centred circle with a diameter of 80 % of the icon's width.
"""
import argparse
import math
import os
import sys

from PIL import Image, ImageDraw

NAVY = (4, 13, 24)          # brand background (#040d18) — same as theme_color

# ── Try the canonical source first ──────────────────────────────────────
HERE = os.path.dirname(os.path.abspath(__file__))
draw_mark = None
try:
    sys.path.insert(0, HERE)
    from make_logo import draw_mark as _dm   # noqa: E402
    draw_mark = _dm
    SOURCE = "tools/make_logo.py"
except Exception:
    SOURCE = "embedded copy of make_logo.py geometry"

if draw_mark is None:
    # ── Verbatim from tools/make_logo.py ───────────────────────────────
    NAVY2 = (8, 21, 38)
    CYAN = (0, 212, 255)
    CYAN_D = (0, 140, 180)
    WHITE = (238, 243, 248)

    def wave_points(cx, cy, width, amp, phase=0.0, steps=140):
        """A sine wave centred on (cx, cy), `width` wide, `amp` tall."""
        pts = []
        for i in range(steps + 1):
            t = i / steps
            x = cx - width / 2 + width * t
            y = cy + math.sin(t * math.pi * 2 + phase) * amp
            pts.append((x, y))
        return pts

    # (y offset, amplitude, thickness, colour) as fractions of the badge size
    WAVES = [
        (-0.155, 0.052, 0.055, WHITE),
        ( 0.020, 0.070, 0.082, CYAN),
        ( 0.190, 0.052, 0.055, CYAN_D),
    ]

    def draw_mark(size, bg=True, supersample=4):
        """Render the mark at `size` px. Supersampled for clean curves."""
        S = size * supersample
        img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        if bg:
            r = int(S * 0.22)                     # squircle corner radius
            d.rounded_rectangle([0, 0, S - 1, S - 1], radius=r, fill=NAVY2)
            d.rounded_rectangle([0, 0, S - 1, S - 1], radius=r,
                                outline=(0, 212, 255, 60), width=max(1, int(S * 0.012)))
        for y_off, amp, thick, col in WAVES:
            rr = S * thick / 2
            pts = wave_points(S / 2, S / 2 + S * y_off, S * 0.62, S * amp, steps=600)
            for px, py in pts:
                d.ellipse([px - rr, py - rr, px + rr, py + rr], fill=col)
        return img.resize((size, size), Image.LANCZOS)


def make_any(size=512):
    """purpose "any": the badge with its transparent corners, like favicon-192."""
    return draw_mark(size, bg=True)


def make_ico(sizes=(32, 16)):
    """favicon.ico: the badge at 32 and 16 px, stored as classic BMP entries."""
    return [draw_mark(s, bg=True) for s in sizes]


def make_maskable(size=512, safe=0.80):
    """purpose "maskable": full-bleed navy, mark scaled to the 80 % safe zone."""
    img = Image.new("RGBA", (size, size), NAVY + (255,))
    inner = int(round(size * safe))
    mark = draw_mark(inner, bg=True)
    off = (size - inner) // 2
    img.paste(mark, (off, off), mark)
    return img.convert("RGB")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=".", help="output directory (default: current directory)")
    ap.add_argument("--size", type=int, default=512)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    a = os.path.join(args.out, "icon-%d.png" % args.size)
    m = os.path.join(args.out, "icon-%d-maskable.png" % args.size)
    make_any(args.size).save(a, "PNG", optimize=True)
    make_maskable(args.size).save(m, "PNG", optimize=True)
    ico = os.path.join(args.out, "favicon.ico")
    frames = make_ico()
    frames[0].save(ico, format="ICO", sizes=[f.size for f in frames], append_images=frames[1:], bitmap_format="bmp")
    print("Wrote:", a, m, ico)
    print("Mark source:", SOURCE)
