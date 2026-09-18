#!/usr/bin/env python3
"""
Tidelyne logo generator
=======================
Regenerates every brand file from one place, so the mark can never drift
between the favicon, the app icon and the share image.

    python3 make_logo.py

Outputs:
    logo-mark.svg        the mark alone (scalable, used as favicon.svg)
    favicon-32.png       browser tab
    favicon-192.png      Android / PWA
    apple-touch-180.png  iOS home screen (full-bleed opaque: iOS masks its own corners)
    og.png               1200x630 link preview

    logo-full.svg (mark + wordmark lockup) is opt-in — `python3 make_logo.py --full` —
    because the site no longer references it (removed in 40e227d).

THE MARK: three waves in a rounded-square badge. "Tide" + "lyne" — the middle
cyan wave is the waterline, the ones above and below are the swell. It reads as
water at 16px, which a swimmer emoji does not.
"""
import math, os, sys
from PIL import Image, ImageDraw, ImageFont

NAVY   = (4, 13, 24)
NAVY2  = (8, 21, 38)
CYAN   = (0, 212, 255)
CYAN_D = (0, 140, 180)
WHITE  = (238, 243, 248)
MUTED  = (139, 165, 189)

FONT_DIRS = [
    # macOS
    "/System/Library/Fonts/Supplemental/", "/System/Library/Fonts/", "/Library/Fonts/",
    os.path.expanduser("~/Library/Fonts/"),
    # Linux
    "/usr/share/fonts/truetype/liberation/", "/usr/share/fonts/truetype/liberation2/",
    "/usr/share/fonts/truetype/google-fonts/", "/usr/share/fonts/truetype/dejavu/",
]
def find_font(*names):
    for n in names:
        for d in FONT_DIRS:
            p = os.path.join(d, n)
            if os.path.exists(p): return p
    return None

# Condensed + heavy, closest to the site's Bebas Neue. macOS names first.
DISPLAY = find_font(
    "Impact.ttf", "Arial Narrow Bold.ttf", "AvenirNextCondensed.ttc", "HelveticaNeue.ttc",
    "LiberationSansNarrow-Bold.ttf", "Poppins-Bold.ttf", "DejaVuSansCondensed-Bold.ttf")
BODY = find_font(
    "Helvetica.ttc", "Arial.ttf", "HelveticaNeue.ttc",
    "Poppins-Medium.ttf", "LiberationSans-Regular.ttf", "DejaVuSans.ttf")

if not DISPLAY or not BODY:
    print("⚠️  No system font found for the share image text.")
    print("   The icons will still be perfect (they're pure geometry).")
    print("   Tell me which OS you're on and I'll add the right font path.")


# ── wave geometry, shared by every output ────────────────────────────────
def wave_points(cx, cy, width, amp, phase=0.0, steps=140):
    """A sine wave centred on (cx, cy), `width` wide, `amp` tall."""
    pts = []
    for i in range(steps + 1):
        t = i / steps
        x = cx - width / 2 + width * t
        y = cy + math.sin(t * math.pi * 2 + phase) * amp
        pts.append((x, y))
    return pts


# The three waves, expressed as fractions of the badge size so they scale.
# (y offset, amplitude, thickness, colour)
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

    # Stamp overlapping circles along each curve. PIL's thick `line()` notches
    # at every joint on a curve this tight; stamping gives a genuinely smooth
    # stroke with round caps for free.
    for y_off, amp, thick, col in WAVES:
        rr = S * thick / 2
        pts = wave_points(S / 2, S / 2 + S * y_off, S * 0.62, S * amp, steps=600)
        for px, py in pts:
            d.ellipse([px - rr, py - rr, px + rr, py + rr], fill=col)

    return img.resize((size, size), Image.LANCZOS)


def draw_touch(size=180):
    """apple-touch-icon: iOS applies its own corner mask and composites transparent pixels
    as BLACK, so the tile must be a full-bleed opaque square — the badge colour edge to
    edge with the waves at the badge's own proportion, no rounded corners, no margin."""
    img = Image.new("RGB", (size, size), NAVY2)
    waves = draw_mark(size, bg=False)
    img.paste(waves, (0, 0), waves)
    return img


def svg_wave_path(cx, cy, width, amp, steps=48):
    pts = wave_points(cx, cy, width, amp, steps=steps)
    return "M " + " L ".join(f"{x:.1f} {y:.1f}" for x, y in pts)


def write_mark_svg(path, size=128):
    r = size * 0.22
    strokes = []
    for y_off, amp, thick, col in WAVES:
        hexc = "#%02x%02x%02x" % col
        dpath = svg_wave_path(size / 2, size / 2 + size * y_off, size * 0.62, size * amp)
        strokes.append(
            f'  <path d="{dpath}" fill="none" stroke="{hexc}" '
            f'stroke-width="{size*thick:.1f}" stroke-linecap="round"/>'
        )
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}">
  <title>Tidelyne</title>
  <rect width="{size}" height="{size}" rx="{r:.1f}" fill="#081526"/>
  <rect x="0.75" y="0.75" width="{size-1.5}" height="{size-1.5}" rx="{r:.1f}"
        fill="none" stroke="#00d4ff" stroke-opacity="0.25" stroke-width="1.5"/>
{chr(10).join(strokes)}
</svg>
'''
    open(path, "w").write(svg)


def write_full_svg(path):
    """Mark + wordmark lockup. Uses Bebas Neue, which the site already loads."""
    svg = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 460 128" width="460" height="128">
  <title>Tidelyne</title>
  <rect width="128" height="128" rx="28.2" fill="#081526"/>
  <rect x="0.75" y="0.75" width="126.5" height="126.5" rx="28.2"
        fill="none" stroke="#00d4ff" stroke-opacity="0.25" stroke-width="1.5"/>
  <path d="PATH_TOP" fill="none" stroke="#eef3f8" stroke-width="7.0" stroke-linecap="round"/>
  <path d="PATH_MID" fill="none" stroke="#00d4ff" stroke-width="10.5" stroke-linecap="round"/>
  <path d="PATH_BOT" fill="none" stroke="#008cb4" stroke-width="7.0" stroke-linecap="round"/>
  <text x="156" y="78" font-family="'Bebas Neue', Impact, sans-serif" font-size="62"
        letter-spacing="3" fill="#eef3f8">TIDE<tspan fill="#00d4ff">LYNE</tspan></text>
  <text x="158" y="100" font-family="'DM Mono', ui-monospace, monospace" font-size="11"
        letter-spacing="3.2" fill="#8ba5bd">STROKE LAB FOR SWIMMERS</text>
</svg>
'''
    size = 128
    for key, (y_off, amp, thick, _) in zip(("PATH_TOP", "PATH_MID", "PATH_BOT"), WAVES):
        svg = svg.replace(key, svg_wave_path(size/2, size/2 + size*y_off, size*0.62, size*amp))
    open(path, "w").write(svg)


def make_og(path):
    """1200x630 link preview — what Slack, iMessage and X will show."""
    W, H = 1200, 630
    img = Image.new("RGB", (W, H), NAVY)
    d = ImageDraw.Draw(img)

    # soft cyan glow from the top, matching the site's hero
    glow = Image.new("RGB", (W, H), NAVY)
    gd = ImageDraw.Draw(glow)
    for i in range(40, 0, -1):
        a = i / 40
        rx, ry = int(W * 0.75 * a), int(H * 0.85 * a)
        gd.ellipse([W//2 - rx, -ry//2 - 60, W//2 + rx, ry//2 - 60],
                   fill=(int(4 + 10*(1-a)), int(13 + 34*(1-a)), int(24 + 54*(1-a))))
    img = Image.blend(img, glow, 0.85)
    d = ImageDraw.Draw(img)

    mark = draw_mark(150, bg=True)
    img.paste(mark, (92, 150), mark)

    f_word = ImageFont.truetype(DISPLAY, 118) if DISPLAY else ImageFont.load_default()
    f_tag  = ImageFont.truetype(BODY, 34) if BODY else ImageFont.load_default()
    f_url  = ImageFont.truetype(BODY, 24) if BODY else ImageFont.load_default()

    x = 280
    d.text((x, 152), "TIDE", font=f_word, fill=WHITE)
    tw = d.textlength("TIDE", font=f_word)
    d.text((x + tw, 152), "LYNE", font=f_word, fill=CYAN)

    d.text((x + 4, 300), "3D stroke lab for competitive swimmers", font=f_tag, fill=MUTED)

    d.line([(92, 452), (1108, 452)], fill=(0, 212, 255, 90), width=2)
    d.text((92, 486), "Technique  ·  3D visualizer  ·  Deck tools  ·  AI coach",
           font=f_url, fill=MUTED)
    d.text((92, 526), "Free · installable · works offline", font=f_url, fill=CYAN)

    img.save(path, "PNG", optimize=True)


if __name__ == "__main__":
    write_mark_svg("logo-mark.svg")
    full = "--full" in sys.argv[1:]   # the lockup is unreferenced by the site; only write it on request
    if full:
        write_full_svg("logo-full.svg")
    for px, name in ((32, "favicon-32.png"), (192, "favicon-192.png")):
        draw_mark(px).save(name, "PNG", optimize=True)
    draw_touch(180).save("apple-touch-180.png", "PNG", optimize=True)
    make_og("og.png")
    print("Wrote: logo-mark.svg " + ("logo-full.svg " if full else "") + "favicon-32.png favicon-192.png "
          "apple-touch-180.png og.png")
    print("Display font used:", DISPLAY or "(default)")
