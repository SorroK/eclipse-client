#!/usr/bin/env python3
"""Build the Eclipse UI resource packs bundled by Eclipse Client.

The packs target Minecraft 1.21.11 (resource format 75) and replace the
title-screen artwork and Mojang loading splash. Each launcher theme gets its
own pack; the launcher installs and enables the one matching the selected
theme. Requires Pillow and numpy for asset generation; neither is a launcher
runtime dependency.
"""

from __future__ import annotations

import hashlib
import json
import math
import random
import zipfile
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parents[1]
ICON = ROOT / "assets" / "icon.png"
OUTPUT_DIR = ROOT / "src-tauri" / "assets"
PACK_VERSION = "1.0.2"
PACK_FORMAT = 75
TITLE_VISIBLE_HEIGHT = 176
PANORAMA_SIZE = 256


@dataclass(frozen=True)
class Theme:
    slug: str
    name: str
    dark: bool
    top: str
    middle: str
    bottom: str
    glow_a: str
    glow_b: str
    horizon: str
    particle: str
    logo_top: str
    logo_bottom: str
    accent: str
    glint: str
    edition: str
    overlay: tuple[int, int, int, int]
    motif: str
    sun: bool = False


THEMES = (
    Theme(
        "eclipse",
        "Eclipse",
        True,
        "#020609",
        "#081815",
        "#010505",
        "#11543f",
        "#2b265c",
        "#144135",
        "#d8ffe8",
        "#fafff9",
        "#96ebba",
        "#7df3b3",
        "#f4d8a0",
        "#f4d8a0",
        (2, 7, 6, 82),
        "stars",
    ),
    Theme(
        "aurora",
        "Aurora",
        True,
        "#030510",
        "#14183e",
        "#02040a",
        "#485ac8",
        "#9150d2",
        "#1c2855",
        "#e1e8ff",
        "#fbfbff",
        "#a0b4ff",
        "#a3b4ff",
        "#ffcf8b",
        "#ffcf8b",
        (4, 6, 16, 86),
        "stars",
    ),
    Theme(
        "ember",
        "Ember",
        True,
        "#0d0504",
        "#37140c",
        "#060202",
        "#b43e1c",
        "#87192e",
        "#502012",
        "#ffd7b9",
        "#fff8f0",
        "#ffa06e",
        "#ff8f62",
        "#ffc36f",
        "#ffc36f",
        (15, 4, 3, 84),
        "stars",
    ),
    Theme(
        "midnight",
        "Midnight",
        True,
        "#01040c",
        "#081837",
        "#000206",
        "#1482aa",
        "#2832a0",
        "#0c2346",
        "#dcf5ff",
        "#f0fdff",
        "#78dcf5",
        "#67e8f9",
        "#a5b4fc",
        "#a5b4fc",
        (1, 4, 10, 90),
        "stars",
    ),
    Theme(
        "daylight",
        "Daylight",
        False,
        "#ecf5ec",
        "#cae6d0",
        "#f8faf3",
        "#78cd9b",
        "#b4d2f0",
        "#e1f0e1",
        "#ffffff",
        "#12351f",
        "#0b4a2e",
        "#2c9d6a",
        "#d8a555",
        "#1b7a4e",
        (243, 247, 240, 28),
        "clouds",
        True,
    ),
    Theme(
        "frost",
        "Frost",
        False,
        "#e1f2fa",
        "#afd7eb",
        "#f5fcff",
        "#82c8e6",
        "#b9c8f0",
        "#d2ebf5",
        "#ffffff",
        "#0c4b5f",
        "#197891",
        "#0f7289",
        "#8fb6e2",
        "#0f5e72",
        (238, 248, 253, 30),
        "snow",
    ),
    Theme(
        "sakura",
        "Sakura",
        False,
        "#fff5f7",
        "#f6becd",
        "#fffafa",
        "#ee8caa",
        "#c896dc",
        "#ffe6ee",
        "#ff9fba",
        "#5a1e30",
        "#a23a54",
        "#be4c68",
        "#f1c37d",
        "#a23a54",
        (255, 240, 245, 30),
        "petals",
    ),
    Theme(
        "solar",
        "Solar",
        False,
        "#fff6e0",
        "#fad296",
        "#fffcf0",
        "#f5b450",
        "#eb823c",
        "#ffe6b4",
        "#ffd78a",
        "#503005",
        "#8c4807",
        "#d89137",
        "#ffe6b4",
        "#8c4807",
        (255, 250, 235, 24),
        "motes",
        True,
    ),
)


def color(value: str) -> tuple[int, int, int]:
    raw = value.lstrip("#")
    return tuple(int(raw[index:index + 2], 16) for index in (0, 2, 4))


def lighten(value: tuple[int, int, int], amount: float) -> tuple[int, int, int]:
    return tuple(int(channel + (255 - channel) * amount) for channel in value)


def mix(left: tuple[int, int, int], right: tuple[int, int, int], amount: float) -> tuple[int, int, int]:
    return tuple(int(a + (b - a) * amount) for a, b in zip(left, right))


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


def make_title_logo(theme: Theme) -> Image.Image:
    canvas = Image.new("RGBA", (1024, 256), (0, 0, 0, 0))
    typeface = font(166, bold=True)
    tracking = 36
    accent = color(theme.accent)
    glint = color(theme.glint)

    # Minecraft samples only the top 44/64 of this texture. Keep the orbit and
    # glow above that cutoff so the wordmark is never clipped at the bottom.
    orbit = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    orbit_draw = ImageDraw.Draw(orbit)
    orbit_draw.ellipse((52, 4, 972, 146), outline=(*accent, 54), width=3)
    orbit_draw.arc((106, 20, 918, 130), 194, 344, fill=(*glint, 135), width=2)
    orbit_draw.ellipse((798, 10, 812, 24), fill=(*lighten(accent, 0.4), 220))
    orbit_draw.ellipse((206, 125, 214, 133), fill=(*glint, 190))
    canvas.alpha_composite(orbit)

    mask = Image.new("L", canvas.size, 0)
    mask_draw = ImageDraw.Draw(mask)
    text_bounds = mask_draw.textbbox((0, 0), "ECLIPSE", font=typeface)
    text_top = 10 - text_bounds[1]
    draw_tracked(mask_draw, 512, text_top, "ECLIPSE", typeface, tracking, 255)
    bbox = mask.getbbox()

    # A soft theme-coloured bloom keeps the mark legible on both light and dark
    # panoramas without turning it into a neon sign.
    glow = mask.filter(ImageFilter.GaussianBlur(14))
    glow_layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    glow_layer.putalpha(glow.point(lambda value: int(value * (0.28 if not theme.dark else 0.40))))
    glow_color = Image.new("RGBA", canvas.size, (*accent, 255))
    glow_color.putalpha(glow_layer.getchannel("A"))
    canvas.alpha_composite(glow_color)

    gradient = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    gradient_draw = ImageDraw.Draw(gradient)
    top = color(theme.logo_top)
    bottom = color(theme.logo_bottom)
    for y in range(canvas.height):
        ratio = min(1.0, y / max(1, canvas.height - 1))
        gradient_draw.line((0, y, canvas.width, y), fill=(*mix(top, bottom, ratio), 255))
    text = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    text.paste(gradient, (0, 0), mask)
    canvas.alpha_composite(text)

    # A glint on the leading edge keeps the mark warm rather than neon.
    if bbox:
        glint_layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
        glint_draw = ImageDraw.Draw(glint_layer)
        glint_draw.line((bbox[0], bbox[1] + 14, bbox[0] + bbox[2] * 0.42, bbox[1] + 4), fill=(*glint, 140), width=2)
        glint_layer = glint_layer.filter(ImageFilter.GaussianBlur(1.2))
        canvas.alpha_composite(glint_layer)

    visible = canvas.getbbox()
    if visible and visible[3] > TITLE_VISIBLE_HEIGHT:
        raise ValueError(f"Title logo extends to y={visible[3]}, past Minecraft's {TITLE_VISIBLE_HEIGHT}px crop")
    return canvas


def make_edition_logo(theme: Theme) -> Image.Image:
    canvas = Image.new("RGBA", (512, 64), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    typeface = font(27, bold=True)
    tracking = 10
    edition = color(theme.edition)
    accent = color(theme.accent)
    widths = [draw.textlength(character, font=typeface) for character in "CLIENT"]
    text_width = int(sum(widths) + tracking * 5)
    x = (512 - text_width) / 2
    y = 19
    for character, character_width in zip("CLIENT", widths):
        draw.text((x, y), character, font=typeface, fill=(*edition, 230))
        x += character_width + tracking
    line_y = 32
    draw.line((40, line_y, 176, line_y), fill=(*edition, 90), width=1)
    draw.line((336, line_y, 472, line_y), fill=(*edition, 90), width=1)
    draw.ellipse((182, line_y - 2, 186, line_y + 2), fill=(*accent, 160))
    draw.ellipse((326, line_y - 2, 330, line_y + 2), fill=(*accent, 160))
    return canvas


def make_loading_splash(theme: Theme) -> Image.Image:
    canvas = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    splash = lighten(color(theme.accent), 0.38 if theme.dark else 0.18)
    icon = Image.open(ICON).convert("RGBA").resize((308, 308), Image.Resampling.LANCZOS)
    alpha = icon.getchannel("A")
    tinted = ImageOps.colorize(icon.convert("L"), black=(8, 8, 12), white=splash).convert("RGBA")
    tinted.putalpha(alpha)

    glow_alpha = alpha.filter(ImageFilter.GaussianBlur(22)).point(lambda value: int(value * 0.42))
    glow_color = Image.new("RGBA", tinted.size, (*splash, 255))
    glow_color.putalpha(glow_alpha)
    canvas.alpha_composite(glow_color, (102, 18))
    canvas.alpha_composite(tinted, (102, 28))

    draw = ImageDraw.Draw(canvas)
    typeface = font(54, bold=True)
    draw_tracked(draw, 256, 356, "ECLIPSE", typeface, 7, (*lighten(splash, 0.35), 255))
    sub_font = font(17, bold=True)
    draw_tracked(draw, 256, 434, "C L I E N T", sub_font, 5, (*color(theme.glint), 215))
    return canvas


def add_sun(image: Image.Image, theme: Theme) -> None:
    glint = color(theme.glint)
    size = image.width
    cx = int(size * (0.73 if theme.slug == "solar" else 0.77))
    cy = int(size * (0.18 if theme.slug == "solar" else 0.20))
    radius = int(size * (0.075 if theme.slug == "solar" else 0.055))
    glow = Image.new("RGBA", image.size, (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.ellipse(
        (cx - radius * 3, cy - radius * 3, cx + radius * 3, cy + radius * 3),
        fill=(*glint, 48 if theme.slug == "solar" else 34),
    )
    glow = glow.filter(ImageFilter.GaussianBlur(radius * 0.9))
    image.alpha_composite(glow)
    draw = ImageDraw.Draw(image)
    draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=(*lighten(glint, 0.35), 225))


def add_clouds(image: Image.Image, theme: Theme, rng: random.Random) -> None:
    size = image.width
    cloud = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(cloud)
    for _ in range(7):
        cx = rng.uniform(0.1, 0.9) * size
        cy = rng.uniform(0.12, 0.68) * size
        width = rng.uniform(0.18, 0.38) * size
        height = rng.uniform(0.025, 0.06) * size
        draw.ellipse((cx - width / 2, cy - height / 2, cx + width / 2, cy + height / 2), fill=(*color(theme.particle), 36))
    cloud = cloud.filter(ImageFilter.GaussianBlur(size * 0.035))
    image.alpha_composite(cloud)


def add_particles(image: Image.Image, theme: Theme, index: int) -> None:
    size = image.width
    rng = random.Random(9001 + index * 97)
    draw = ImageDraw.Draw(image)
    particle = color(theme.particle)
    count = 140 if theme.dark else 125

    if theme.motif == "stars":
        for _ in range(count):
            sx = rng.randint(14, size - 15)
            sy = rng.randint(14, size - 15)
            radius = 1 if rng.random() < 0.88 else 2
            brightness = rng.randint(115, 235)
            tint = rng.choice(
                [
                    (brightness, brightness, int(brightness * 0.88)),
                    (int(brightness * 0.84), brightness, int(brightness * 0.90)),
                    (int(brightness * 0.92), int(brightness * 0.98), brightness),
                ]
            )
            draw.ellipse((sx, sy, sx + radius, sy + radius), fill=(*tint, 255))
            if rng.random() < 0.035:
                draw.line((sx - 5, sy, sx + 6, sy), fill=(*tint, 80), width=1)
                draw.line((sx, sy - 5, sx, sy + 6), fill=(*tint, 80), width=1)
        return

    if theme.motif == "snow":
        for _ in range(count):
            sx = rng.randint(12, size - 13)
            sy = rng.randint(12, size - 13)
            radius = rng.randint(1, 2)
            draw.ellipse((sx, sy, sx + radius, sy + radius), fill=(*particle, rng.randint(110, 220)))
            if rng.random() < 0.22:
                draw.line((sx - 2, sy + radius, sx + 3, sy + radius), fill=(*particle, 100), width=1)
                draw.line((sx + radius, sy - 2, sx + radius, sy + 3), fill=(*particle, 100), width=1)
        return

    if theme.motif == "petals":
        for _ in range(count):
            sx = rng.randint(12, size - 18)
            sy = rng.randint(12, size - 18)
            length = rng.randint(3, 6)
            draw.ellipse((sx, sy, sx + length, sy + max(2, length // 2)), fill=(*particle, rng.randint(70, 175)))
            if rng.random() < 0.18:
                draw.line((sx - 2, sy + length + 2, sx + length + 3, sy + length + 2), fill=(*particle, 55), width=1)
        return

    # Daylight and Solar use small floating motes rather than stars.
    for _ in range(count):
        sx = rng.randint(12, size - 13)
        sy = rng.randint(12, size - 13)
        radius = 1 if rng.random() < 0.75 else 2
        draw.ellipse((sx, sy, sx + radius, sy + radius), fill=(*particle, rng.randint(55, 150)))


def make_panorama(index: int, theme: Theme) -> Image.Image:
    """Six soft, seam-friendly faces for the title-screen cubemap."""
    rng = random.Random(9001 + index * 97)
    width = height = PANORAMA_SIZE
    y, x = np.mgrid[0:height, 0:width]
    nx = x / (width - 1)
    ny = y / (height - 1)

    top = np.array(color(theme.top), dtype=np.float32)
    middle = np.array(color(theme.middle), dtype=np.float32)
    bottom = np.array(color(theme.bottom), dtype=np.float32)
    t = np.clip(ny * 1.18, 0, 1)[..., None]
    rgb = top * (1 - t) + bottom * t
    band = np.exp(-((ny - 0.46) ** 2) / (2 * 0.20 ** 2))[..., None]
    rgb = rgb * (1 - band * 0.35) + middle * (band * 0.35)

    # Broad, soft theme-coloured pockets. Keeping every edge near the base color
    # avoids obvious seams where the six cubemap faces meet.
    glow_a = np.array(color(theme.glow_a), dtype=np.float32)
    glow_b = np.array(color(theme.glow_b), dtype=np.float32)
    glows = [
        (0.30 + 0.12 * math.sin(index * 1.7), 0.40, 0.28, 0.30, glow_a, 0.68),
        (0.76 + 0.08 * math.cos(index * 1.3), 0.60, 0.30, 0.24, glow_b, 0.46),
        (0.52, 0.23, 0.35, 0.18, glow_a, 0.34),
    ]
    for cx, cy, sx, sy, glow_color, strength in glows:
        blob = np.exp(-(((nx - cx) ** 2) / (2 * sx ** 2) + ((ny - cy) ** 2) / (2 * sy ** 2)))
        edge = np.maximum(np.abs(nx * 2 - 1), np.abs(ny * 2 - 1))[..., None]
        rgb += blob[..., None] * glow_color * strength * np.clip(1 - edge * 1.3, 0, 1)

    # Faint grain prevents visible banding without looking noisy.
    grain = np.random.default_rng(1200 + index).normal(0, 1.2 if theme.dark else 0.75, (height, width, 1))
    rgb += grain

    image = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8), "RGB").convert("RGBA")
    haze = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    haze_draw = ImageDraw.Draw(haze)
    for band_index in range(5):
        band_y = int(height * (0.31 + band_index * 0.105 + rng.uniform(-0.024, 0.024)))
        band_height = int(rng.randint(28, 92) * (height / 1024))
        alpha = rng.randint(8, 18) if theme.dark else rng.randint(10, 22)
        hue = (*mix(color(theme.glow_a), color(theme.glow_b), rng.random()), alpha)
        offset = (index * 173 + band_index * 61) % 400
        haze_draw.ellipse(
            (-300 + offset, band_y, width + 300, band_y + max(6, band_height)),
            fill=hue,
        )
    haze = haze.filter(ImageFilter.GaussianBlur(height * 0.034))
    edge = np.maximum(np.abs(nx * 2 - 1), np.abs(ny * 2 - 1))
    haze_pixels = np.array(haze)
    haze_pixels[..., 3] = (haze_pixels[..., 3].astype(np.float32) * np.clip(1 - edge * 1.2, 0, 1)).astype(np.uint8)
    image.alpha_composite(Image.fromarray(haze_pixels, "RGBA"))

    if theme.motif == "clouds":
        add_clouds(image, theme, rng)
    if theme.sun:
        add_sun(image, theme)

    add_particles(image, theme, index)

    # A pale horizon sliver adds depth behind the menu without competing with it.
    horizon = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    horizon_draw = ImageDraw.Draw(horizon)
    horizon_draw.ellipse(
        (-220, 660, width + 220, 930),
        fill=(*color(theme.horizon), 32 if theme.dark else 48),
    )
    horizon = horizon.filter(ImageFilter.GaussianBlur(height * 0.045))
    horizon_pixels = np.array(horizon)
    horizon_pixels[..., 3] = (horizon_pixels[..., 3].astype(np.float32) * np.clip(1 - edge * 1.2, 0, 1)).astype(np.uint8)
    image.alpha_composite(Image.fromarray(horizon_pixels, "RGBA"))
    return image.convert("RGB")


def write_zip(output: Path, files: dict[str, bytes]) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in sorted(files):
            info = zipfile.ZipInfo(name, date_time=(2026, 11, 8, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, files[name])


def png_bytes(image: Image.Image) -> bytes:
    buffer = BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def build_pack(theme: Theme) -> tuple[Path, str]:
    output = OUTPUT_DIR / f"eclipse-ui-{PACK_VERSION}-{theme.slug}.zip"
    files: dict[str, bytes] = {}
    files["pack.mcmeta"] = (json.dumps({
        "pack": {
            "min_format": [PACK_FORMAT, 0],
            "max_format": [PACK_FORMAT, 0],
            "description": f"Eclipse Client - {theme.name} title screen without splash text",
        }
    }, indent=2) + "\n").encode("utf-8")

    files["pack.png"] = png_bytes(
        Image.open(ICON).convert("RGBA").resize((128, 128), Image.Resampling.LANCZOS)
    )
    files["assets/minecraft/textures/gui/title/mojangstudios.png"] = png_bytes(make_loading_splash(theme))
    files["assets/minecraft/textures/gui/title/minecraft.png"] = png_bytes(make_title_logo(theme))
    # Replacing the vanilla list with an empty file leaves the title screen with
    # no splash text; TitleScreen skips the splash when the list is empty.
    files["assets/minecraft/texts/splashes.txt"] = b""
    files["assets/minecraft/textures/gui/title/edition.png"] = png_bytes(make_edition_logo(theme))
    files["assets/minecraft/textures/gui/title/background/panorama_overlay.png"] = png_bytes(
        Image.new("RGBA", (1, 1), theme.overlay)
    )
    for index in range(6):
        face = make_panorama(index, theme)
        face = face.quantize(colors=96, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).convert("RGB")
        files[f"assets/minecraft/textures/gui/title/background/panorama_{index}.png"] = png_bytes(face)

    write_zip(output, files)
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    return output, digest


def main() -> None:
    stale = OUTPUT_DIR / f"eclipse-ui-1.0.1.zip"
    if stale.exists():
        stale.unlink()
    for theme in THEMES:
        output, digest = build_pack(theme)
        print(f"Wrote {output.relative_to(ROOT)} ({output.stat().st_size} bytes)")
        print(f"  SHA-256 {digest}")


if __name__ == "__main__":
    main()
