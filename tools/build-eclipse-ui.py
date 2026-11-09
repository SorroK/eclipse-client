#!/usr/bin/env python3
"""Build the Eclipse UI resource pack bundled by Eclipse Client.

The pack targets Minecraft 1.21.11 (resource format 75) and replaces only the
title-screen artwork and the Mojang loading splash. Requires Pillow and numpy
for asset generation; neither is a launcher runtime dependency.
"""

from __future__ import annotations

import hashlib
import json
import math
import random
import zipfile
from io import BytesIO
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
ICON = ROOT / "assets" / "icon.png"
OUTPUT = ROOT / "src-tauri" / "assets" / "eclipse-ui-1.0.0.zip"
PACK_FORMAT = 75
EMERALD = (125, 243, 179)
CREAM = (244, 216, 160)
MINT = (198, 255, 222)


def font(size: int, bold: bool = True, mono: bool = False) -> ImageFont.FreeTypeFont:
    if mono:
        choices = ["C:/Windows/Fonts/consola.ttf", "C:/Windows/Fonts/consolab.ttf"]
    elif bold:
        choices = ["C:/Windows/Fonts/bahnschrift.ttf", "C:/Windows/Fonts/segoeuib.ttf"]
    else:
        choices = ["C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/arial.ttf"]
    for choice in choices:
        path = Path(choice)
        if path.is_file():
            return ImageFont.truetype(str(path), size)
    return ImageFont.load_default(size)


def draw_tracked(
    draw: ImageDraw.ImageDraw,
    center_x: int,
    top: int,
    text: str,
    typeface: ImageFont.FreeTypeFont,
    tracking: int,
    fill,
) -> tuple[int, int, int, int]:
    widths = [draw.textlength(character, font=typeface) for character in text]
    width = int(sum(widths) + tracking * max(0, len(text) - 1))
    x = center_x - width / 2
    for character, character_width in zip(text, widths):
        draw.text((x, top), character, font=typeface, fill=fill)
        x += character_width + tracking
    bbox = draw.textbbox((0, 0), text, font=typeface)
    return (int(center_x - width / 2), top + bbox[1], width, bbox[3] - bbox[1])


def make_title_logo() -> Image.Image:
    canvas = Image.new("RGBA", (1024, 256), (0, 0, 0, 0))
    typeface = font(174, bold=True)
    tracking = 12

    # A restrained orbit behind the wordmark ties the title screen to the
    # Eclipse mark without obscuring the vanilla title-screen layout.
    orbit = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    orbit_draw = ImageDraw.Draw(orbit)
    orbit_draw.ellipse((64, 34, 960, 226), outline=(*EMERALD, 54), width=3)
    orbit_draw.arc((118, 50, 906, 210), 194, 344, fill=(*CREAM, 135), width=2)
    orbit_draw.ellipse((786, 40, 800, 54), fill=(*MINT, 220))
    orbit_draw.ellipse((218, 205, 226, 213), fill=(*CREAM, 190))
    canvas.alpha_composite(orbit)

    mask = Image.new("L", canvas.size, 0)
    mask_draw = ImageDraw.Draw(mask)
    text_bounds = mask_draw.textbbox((0, 0), "ECLIPSE", font=typeface)
    text_height = text_bounds[3] - text_bounds[1]
    text_top = int((canvas.height - text_height) / 2 - text_bounds[1])
    draw_tracked(mask_draw, 512, text_top, "ECLIPSE", typeface, tracking, 255)
    bbox = mask.getbbox()

    # Soft green bloom and a cool top edge make the wordmark feel illuminated.
    glow = mask.filter(ImageFilter.GaussianBlur(16))
    glow_layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    glow_layer.putalpha(glow.point(lambda value: int(value * 0.40)))
    glow_color = Image.new("RGBA", canvas.size, (*EMERALD, 255))
    glow_color.putalpha(glow_layer.getchannel("A"))
    canvas.alpha_composite(glow_color)

    gradient = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    pixels = gradient.load()
    for y in range(canvas.height):
        ratio = min(1.0, y / max(1, canvas.height - 1))
        color = (
            int(250 - 100 * ratio),
            int(255 - 20 * ratio),
            int(249 - 66 * ratio),
            255,
        )
        for x in range(canvas.width):
            pixels[x, y] = color
    text = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    text.paste(gradient, (0, 0), mask)
    canvas.alpha_composite(text)

    # A cream glint on the leading edge keeps the mark warm rather than neon.
    if bbox:
        glint = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
        glint_draw = ImageDraw.Draw(glint)
        glint_draw.line((bbox[0], bbox[1] + 14, bbox[0] + bbox[2] * 0.42, bbox[1] + 4), fill=(*CREAM, 140), width=2)
        glint = glint.filter(ImageFilter.GaussianBlur(1.2))
        canvas.alpha_composite(glint)

    return canvas


def make_edition_logo() -> Image.Image:
    canvas = Image.new("RGBA", (512, 64), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    typeface = font(27, bold=True)
    tracking = 10
    widths = [draw.textlength(character, font=typeface) for character in "CLIENT"]
    text_width = int(sum(widths) + tracking * 5)
    x = (512 - text_width) / 2
    y = 19
    for character, character_width in zip("CLIENT", widths):
        draw.text((x, y), character, font=typeface, fill=(*CREAM, 230))
        x += character_width + tracking
    line_y = 32
    draw.line((40, line_y, 176, line_y), fill=(*CREAM, 90), width=1)
    draw.line((336, line_y, 472, line_y), fill=(*CREAM, 90), width=1)
    draw.ellipse((182, line_y - 2, 186, line_y + 2), fill=(*EMERALD, 160))
    draw.ellipse((326, line_y - 2, 330, line_y + 2), fill=(*EMERALD, 160))
    return canvas


def make_loading_splash() -> Image.Image:
    canvas = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    icon = Image.open(ICON).convert("RGBA").resize((308, 308), Image.Resampling.LANCZOS)

    glow_alpha = icon.getchannel("A").filter(ImageFilter.GaussianBlur(22)).point(lambda value: int(value * 0.42))
    glow_color = Image.new("RGBA", icon.size, (*EMERALD, 255))
    glow_color.putalpha(glow_alpha)
    canvas.alpha_composite(glow_color, (102, 18))
    canvas.alpha_composite(icon, (102, 28))

    draw = ImageDraw.Draw(canvas)
    typeface = font(54, bold=True)
    draw_tracked(draw, 256, 356, "ECLIPSE", typeface, 7, (*MINT, 255))
    sub_font = font(17, bold=True)
    draw_tracked(draw, 256, 434, "C L I E N T", sub_font, 5, (*CREAM, 215))
    return canvas


def make_panorama(index: int) -> Image.Image:
    """Six dark, seam-friendly faces for the title-screen cubemap."""
    rng = random.Random(9001 + index * 97)
    width = height = 1024
    y, x = np.mgrid[0:height, 0:width]
    nx = x / (width - 1)
    ny = y / (height - 1)

    top = np.array([2, 6, 9], dtype=np.float32)
    middle = np.array([8, 24, 21], dtype=np.float32)
    bottom = np.array([1, 5, 5], dtype=np.float32)
    t = np.clip(ny * 1.18, 0, 1)[..., None]
    rgb = top * (1 - t) + bottom * t
    band = np.exp(-((ny - 0.46) ** 2) / (2 * 0.20 ** 2))[..., None]
    rgb = rgb * (1 - band * 0.35) + middle * (band * 0.35)

    # Broad, soft aurora pockets. Keeping every edge near the dark base color
    # avoids obvious seams where the six cubemap faces meet.
    glows = [
        (0.30 + 0.12 * math.sin(index * 1.7), 0.40, 0.28, 0.30, np.array([17, 84, 63]), 0.68),
        (0.76 + 0.08 * math.cos(index * 1.3), 0.60, 0.30, 0.24, np.array([43, 38, 92]), 0.46),
        (0.52, 0.23, 0.35, 0.18, np.array([21, 70, 83]), 0.34),
    ]
    for cx, cy, sx, sy, color, strength in glows:
        blob = np.exp(-(((nx - cx) ** 2) / (2 * sx ** 2) + ((ny - cy) ** 2) / (2 * sy ** 2)))
        edge = np.maximum(np.abs(nx * 2 - 1), np.abs(ny * 2 - 1))[..., None]
        rgb += blob[..., None] * color * strength * np.clip(1 - edge * 1.3, 0, 1)

    # Faint grain prevents visible banding without looking noisy.
    grain = np.random.default_rng(1200 + index).normal(0, 1.6, (height, width, 1))
    rgb += grain

    image = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8), "RGB").convert("RGBA")
    haze = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    haze_draw = ImageDraw.Draw(haze)
    for band_index in range(5):
        band_y = int(height * (0.31 + band_index * 0.105 + rng.uniform(-0.024, 0.024)))
        band_height = rng.randint(28, 92)
        alpha = rng.randint(8, 24)
        hue = (rng.randint(35, 96), rng.randint(120, 220), rng.randint(95, 180), alpha)
        offset = (index * 173 + band_index * 61) % 400
        haze_draw.ellipse(
            (-300 + offset, band_y, width + 300, band_y + band_height),
            fill=hue,
        )
    haze = haze.filter(ImageFilter.GaussianBlur(34))
    edge = np.maximum(np.abs(nx * 2 - 1), np.abs(ny * 2 - 1))
    haze_pixels = np.array(haze)
    haze_pixels[..., 3] = (haze_pixels[..., 3].astype(np.float32) * np.clip(1 - edge * 1.2, 0, 1)).astype(np.uint8)
    image.alpha_composite(Image.fromarray(haze_pixels, "RGBA"))

    draw = ImageDraw.Draw(image)
    for _ in range(340):
        sx = rng.randint(18, width - 19)
        sy = rng.randint(18, height - 19)
        size = 1 if rng.random() < 0.88 else 2
        brightness = rng.randint(115, 235)
        tint = rng.choice([(brightness, brightness, int(brightness * 0.88)),
                           (int(brightness * 0.84), brightness, int(brightness * 0.90)),
                           (int(brightness * 0.92), int(brightness * 0.98), brightness)])
        draw.ellipse((sx, sy, sx + size, sy + size), fill=(*tint, 255))
        if rng.random() < 0.035:
            draw.line((sx - 5, sy, sx + 6, sy), fill=(*tint, 80), width=1)
            draw.line((sx, sy - 5, sx, sy + 6), fill=(*tint, 80), width=1)

    # A pale horizon sliver adds depth behind the menu without competing with it.
    horizon = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    horizon_draw = ImageDraw.Draw(horizon)
    horizon_draw.ellipse((-220, 660, width + 220, 930), fill=(20, 65, 53, 32))
    horizon = horizon.filter(ImageFilter.GaussianBlur(46))
    horizon_pixels = np.array(horizon)
    horizon_pixels[..., 3] = (horizon_pixels[..., 3].astype(np.float32) * np.clip(1 - edge * 1.2, 0, 1)).astype(np.uint8)
    image.alpha_composite(Image.fromarray(horizon_pixels, "RGBA"))
    return image.convert("RGB")


def write_zip(files: dict[str, bytes]) -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(OUTPUT, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in sorted(files):
            info = zipfile.ZipInfo(name, date_time=(2026, 11, 8, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, files[name])


def main() -> None:
    files: dict[str, bytes] = {}
    files["pack.mcmeta"] = (json.dumps({
        "pack": {
            "min_format": [PACK_FORMAT, 0],
            "max_format": [PACK_FORMAT, 0],
            "description": "Eclipse Client - custom loading splash and title screen",
        }
    }, indent=2) + "\n").encode("utf-8")
    def png_bytes(image: Image.Image) -> bytes:
        buffer = BytesIO()
        image.save(buffer, format="PNG", optimize=True)
        return buffer.getvalue()

    files["pack.png"] = png_bytes(Image.open(ICON).convert("RGBA").resize((128, 128), Image.Resampling.LANCZOS))
    files["assets/minecraft/textures/gui/title/mojangstudios.png"] = png_bytes(make_loading_splash())
    files["assets/minecraft/textures/gui/title/minecraft.png"] = png_bytes(make_title_logo())
    files["assets/minecraft/textures/gui/title/edition.png"] = png_bytes(make_edition_logo())
    files["assets/minecraft/textures/gui/title/background/panorama_overlay.png"] = png_bytes(
        Image.new("RGBA", (1, 1), (2, 7, 6, 82))
    )
    for index in range(6):
        # 512 px is plenty for a slow-moving, deliberately soft backdrop, and
        # indexed color keeps the bundled pack below a megabyte.
        face = make_panorama(index).resize((512, 512), Image.Resampling.LANCZOS)
        face = face.quantize(colors=96, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).convert("RGB")
        files[f"assets/minecraft/textures/gui/title/background/panorama_{index}.png"] = png_bytes(face)

    write_zip(files)
    digest = hashlib.sha256(OUTPUT.read_bytes()).hexdigest()
    print(f"Wrote {OUTPUT.relative_to(ROOT)} ({OUTPUT.stat().st_size} bytes)")
    print(f"SHA-256 {digest}")


if __name__ == "__main__":
    main()
