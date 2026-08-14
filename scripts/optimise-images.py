#!/usr/bin/env python3
"""
Kandy's Treats - image optimiser.

Regenerates the WebP variants under assets/images/food/ and rewrites
js/data/image-variants.js to match what is actually on disk.

Run it after adding or replacing a photo:

    python3 scripts/optimise-images.py

Requires Pillow with WebP support:  python3 -m pip install --user Pillow

The original .jpg files are never modified or deleted - they remain the
universal <img src> fallback for any browser that cannot take WebP.
"""
from PIL import Image
import glob
import io
import json
import os

FOOD_DIR = "assets/images/food"
TARGET_WIDTHS = [160, 400, 800]  # 160w ring thumbnails, 400w card grids, 800w heroes
QUALITY = 82
WORDMARK_WIDTH = 420         # rendered at 210px CSS, so 2x for retina


def build_food_variants():
    manifest = {}
    for path in sorted(glob.glob(os.path.join(FOOD_DIR, "*.jpg"))):
        key = os.path.splitext(os.path.basename(path))[0]
        with Image.open(path) as im:
            im = im.convert("RGB")
            native_w, native_h = im.size
            widths = []
            for target in TARGET_WIDTHS:
                w = min(target, native_w)      # never upscale past the source
                if w in widths:
                    continue
                h = max(1, round(native_h * w / native_w))
                out = os.path.join(FOOD_DIR, "%s-%d.webp" % (key, w))
                im.resize((w, h), Image.LANCZOS).save(
                    out, "WEBP", quality=QUALITY, method=6)
                widths.append(w)
            manifest[key] = widths
    return manifest


def build_wordmark():
    src = "assets/logo/kandys-treats-wordmark.png"
    if not os.path.exists(src):
        return
    with Image.open(src) as im:
        im = im.convert("RGBA")
        h = round(im.size[1] * WORDMARK_WIDTH / im.size[0])
        im.resize((WORDMARK_WIDTH, h), Image.LANCZOS).save(
            "assets/logo/kandys-treats-wordmark.webp",
            "WEBP", quality=90, method=6)


def write_manifest(manifest):
    body = json.dumps(manifest, indent=2, sort_keys=True).replace("\n", "\n  ")
    io.open("js/data/image-variants.js", "w", encoding="utf-8").write(
        "/* ==========================================================================\n"
        "   Kandy's Treats - Generated image variant manifest\n"
        "   --------------------------------------------------------------------------\n"
        "   GENERATED FILE - do not hand-edit. Regenerate with:\n"
        "       python3 scripts/optimise-images.py\n"
        "\n"
        "   Maps an image key to the WebP widths that actually exist on disk, so\n"
        "   js/data/images.js can build an honest srcset. Widths are never upscaled\n"
        "   past the source, which is why some keys carry only one entry.\n"
        "   ========================================================================== */\n"
        "(function (KT) {\n"
        '  "use strict";\n'
        "  KT.imageVariants = " + body + ";\n"
        "})(window.KT || (window.KT = {}));\n"
    )


if __name__ == "__main__":
    m = build_food_variants()
    build_wordmark()
    write_manifest(m)
    print("regenerated %d keys, %d WebP variants"
          % (len(m), sum(len(v) for v in m.values())))
