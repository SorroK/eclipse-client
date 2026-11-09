'use strict';

/**
 * Generate the Eclipse Client icon without external image dependencies.
 *
 * The mark is a dark plate holding a luminous eclipse: a warm-to-emerald
 * corona around a near-black moon, with a faint orbit and a few pixel sparks.
 * It is rendered at 2x and downsampled for clean curves at taskbar sizes.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 512;
const OUTPUT_SIZE = 256;
const pixels = Buffer.alloc(SIZE * SIZE * 4, 0);

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const smoothstep = (edge0, edge1, value) => {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};
const mix = (from, to, amount) => from.map((channel, index) =>
  Math.round(channel + (to[index] - channel) * amount),
);

function blendPixel(x, y, color, alpha = 255) {
  const ix = Math.round(x);
  const iy = Math.round(y);
  if (ix < 0 || iy < 0 || ix >= SIZE || iy >= SIZE) return;
  const sourceAlpha = clamp(alpha, 0, 255) / 255;
  if (sourceAlpha <= 0) return;

  const offset = (iy * SIZE + ix) * 4;
  const destinationAlpha = pixels[offset + 3] / 255;
  const outAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
  if (outAlpha <= 0) return;

  for (let channel = 0; channel < 3; channel += 1) {
    pixels[offset + channel] = Math.round(
      (color[channel] * sourceAlpha + pixels[offset + channel] * destinationAlpha * (1 - sourceAlpha)) /
        outAlpha,
    );
  }
  pixels[offset + 3] = Math.round(outAlpha * 255);
}

function insideRoundedRect(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom) return false;
  const nearLeft = x < left + radius;
  const nearRight = x > right - radius;
  const nearTop = y < top + radius;
  const nearBottom = y > bottom - radius;
  if ((nearLeft || nearRight) && (nearTop || nearBottom)) {
    const centerX = nearLeft ? left + radius : right - radius;
    const centerY = nearTop ? top + radius : bottom - radius;
    return Math.hypot(x - centerX, y - centerY) <= radius;
  }
  return true;
}

function softDisc(cx, cy, radius, colorAt, alphaScale = 1) {
  const minX = Math.max(0, Math.floor(cx - radius - 1));
  const maxX = Math.min(SIZE - 1, Math.ceil(cx + radius + 1));
  const minY = Math.max(0, Math.floor(cy - radius - 1));
  const maxY = Math.min(SIZE - 1, Math.ceil(cy + radius + 1));

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const distance = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const coverage = clamp(radius - distance + 0.5, 0, 1) * alphaScale;
      if (coverage <= 0) continue;
      blendPixel(x, y, colorAt(x, y, distance), coverage * 255);
    }
  }
}

function softArc(cx, cy, rx, ry, rotation, color, alpha, width = 1.6, dash = 0) {
  const steps = 900;
  for (let step = 0; step <= steps; step += 1) {
    const angle = (step / steps) * Math.PI * 2;
    if (dash && Math.floor((step / steps) * 48) % 2 === 0) continue;
    const localX = rx * Math.cos(angle);
    const localY = ry * Math.sin(angle);
    const x = cx + localX * Math.cos(rotation) - localY * Math.sin(rotation);
    const y = cy + localX * Math.sin(rotation) + localY * Math.cos(rotation);
    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        if (offsetX * offsetX + offsetY * offsetY > 2) continue;
        blendPixel(x + offsetX, y + offsetY, color, alpha);
      }
    }
  }
}

function softRay(cx, cy, dx, dy, length, color, alpha, width = 1.2) {
  const steps = Math.ceil(length * 2);
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    const x = cx + dx * length * t;
    const y = cy + dy * length * t;
    const falloff = Math.pow(1 - t, 1.8);
    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        if (offsetX * offsetX + offsetY * offsetY > Math.ceil(width * width)) continue;
        blendPixel(x + offsetX, y + offsetY, color, alpha * falloff);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Plate and atmosphere                                                */
/* ------------------------------------------------------------------ */

for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    if (!insideRoundedRect(x, y, 12, 12, 500, 500, 98)) continue;
    const diagonal = (x + y) / (SIZE * 2);
    const cornerDistance = Math.hypot((x - 256) / 256, (y - 256) / 256);
    const shade = clamp(1 - cornerDistance * 0.35, 0.55, 1);
    const base = [
      Math.round((7 + diagonal * 8) * shade),
      Math.round((14 + diagonal * 11) * shade),
      Math.round((15 + diagonal * 9) * shade),
    ];
    blendPixel(x, y, base, 255);
  }
}

const centerX = 256;
const centerY = 248;

// A wide, soft corona haze.
for (let y = 24; y <= 484; y += 1) {
  for (let x = 24; x <= 484; x += 1) {
    if (!insideRoundedRect(x, y, 20, 20, 492, 492, 92)) continue;
    const distance = Math.hypot(x + 0.5 - centerX, y + 0.5 - centerY);
    const halo =
      Math.exp(-Math.pow((distance - 140) / 54, 2)) * 0.3 +
      Math.exp(-Math.pow(distance / 214, 2)) * 0.075;
    if (halo <= 0.003) continue;
    blendPixel(x, y, [65, 224, 158], clamp(halo, 0, 1) * 255);
  }
}

// Subtle diagonal glass sheen across the plate.
for (let y = 12; y < 500; y += 1) {
  for (let x = 12; x < 500; x += 1) {
    if (!insideRoundedRect(x, y, 12, 12, 500, 500, 98)) continue;
    const band = smoothstep(40, 100, x + y - 220) * (1 - smoothstep(210, 330, x + y - 220));
    if (band <= 0) continue;
    blendPixel(x, y, [129, 245, 190], band * 10);
  }
}

// Faint vertical and horizontal grid, like an astronomical plate.
for (let line = 1; line <= 3; line += 1) {
  const radius = 150 + line * 38;
  softArc(centerX, centerY, radius, radius, 0, [165, 255, 211], 10, 1, 0);
}

// Static pixel stars around the mark.
const stars = [
  [86, 104, 4, [208, 255, 230]],
  [424, 96, 3, [255, 225, 171]],
  [438, 386, 3, [145, 244, 190]],
  [96, 401, 2, [145, 244, 190]],
  [196, 70, 2, [232, 255, 241]],
  [328, 448, 2, [124, 233, 173]],
  [117, 302, 2, [255, 212, 151]],
];
for (const [x, y, size, color] of stars) {
  softDisc(x, y, size * 2.3, () => color, 0.1);
  for (let offsetY = 0; offsetY < size; offsetY += 1) {
    for (let offsetX = 0; offsetX < size; offsetX += 1) {
      blendPixel(x + offsetX, y + offsetY, color, 185);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Corona and moon                                                     */
/* ------------------------------------------------------------------ */

const ringInner = 108;
const ringOuter = 136;

for (let y = centerY - 180; y <= centerY + 180; y += 1) {
  for (let x = centerX - 180; x <= centerX + 180; x += 1) {
    const distance = Math.hypot(x + 0.5 - centerX, y + 0.5 - centerY);
    if (distance < ringInner - 3 || distance > ringOuter + 4) continue;

    const ring =
      smoothstep(ringInner - 1.6, ringInner + 2.2, distance) *
      (1 - smoothstep(ringOuter - 2.4, ringOuter + 1.2, distance));
    if (ring <= 0) continue;

    const angle = Math.atan2(y + 0.5 - centerY, x + 0.5 - centerX);
    const warmth = clamp((Math.sin(angle - 0.72) + 1) / 2, 0, 1);
    const color =
      warmth < 0.55
        ? mix([236, 255, 244], [102, 244, 181], warmth / 0.55)
        : mix([102, 244, 181], [255, 207, 136], (warmth - 0.55) / 0.45);
    blendPixel(x, y, color, ring * (210 + warmth * 45));
  }
}

// A thin, hotter inner rim gives the corona depth.
for (let y = centerY - 150; y <= centerY + 150; y += 1) {
  for (let x = centerX - 150; x <= centerX + 150; x += 1) {
    const distance = Math.hypot(x + 0.5 - centerX, y + 0.5 - centerY);
    const rim = smoothstep(103, 107, distance) * (1 - smoothstep(108, 112, distance));
    if (rim <= 0) continue;
    const angle = Math.atan2(y + 0.5 - centerY, x + 0.5 - centerX);
    const glow = clamp((Math.sin(angle - 1.1) + 1) / 2, 0, 1);
    blendPixel(x, y, [248, 255, 236], rim * (90 + glow * 120));
  }
}

// Near-black moon, offset slightly so one side of the corona glows wider.
const moonX = 262;
const moonY = 241;
const moonRadius = 105;
softDisc(moonX, moonY, moonRadius, (x, y) => {
  const nx = (x + 0.5 - moonX) / moonRadius;
  const ny = (y + 0.5 - moonY) / moonRadius;
  const depth = clamp(1 - (nx * 0.22 + ny * 0.38), 0, 1);
  return [3 + depth * 7, 9 + depth * 12, 9 + depth * 11];
}, 1);

// Soft sunset rim along the moon's lower-left edge.
for (let y = moonY - moonRadius - 6; y <= moonY + moonRadius + 6; y += 1) {
  for (let x = moonX - moonRadius - 6; x <= moonX + moonRadius + 6; x += 1) {
    const distance = Math.hypot(x + 0.5 - moonX, y + 0.5 - moonY);
    if (distance < moonRadius - 1 || distance > moonRadius + 4) continue;
    const angle = Math.atan2(y + 0.5 - moonY, x + 0.5 - moonX);
    const visible = smoothstep(-0.3, 1.2, Math.cos(angle - 2.25));
    if (visible <= 0) continue;
    blendPixel(x, y, [126, 241, 178], visible * 38);
  }
}

// Diamond-ring flare on the exposed upper-right edge.
const flareX = 342;
const flareY = 158;
softDisc(flareX, flareY, 22, () => [180, 255, 212], 0.12);
softDisc(flareX, flareY, 8, () => [255, 250, 222], 0.7);
softDisc(flareX, flareY, 3, () => [255, 255, 248], 0.95);
softRay(flareX, flareY, 1, 0, 28, [255, 241, 206], 120, 1.2);
softRay(flareX, flareY, -1, 0, 20, [255, 241, 206], 85, 1.1);
softRay(flareX, flareY, 0, -1, 17, [230, 255, 240], 90, 1.1);
softRay(flareX, flareY, 0, 1, 12, [230, 255, 240], 65, 1.1);

// Orbit line and a small companion world.
softArc(centerX, centerY + 6, 202, 92, -0.4, [127, 243, 184], 30, 1.3, 0);
const orbitAngle = 2.58;
const orbitX = centerX + 202 * Math.cos(orbitAngle) * Math.cos(-0.4) - 92 * Math.sin(orbitAngle) * Math.sin(-0.4);
const orbitY = centerY + 6 + 202 * Math.cos(orbitAngle) * Math.sin(-0.4) + 92 * Math.sin(orbitAngle) * Math.cos(-0.4);
softDisc(orbitX, orbitY, 12, () => [111, 240, 176], 0.12);
softDisc(orbitX, orbitY, 4.5, () => [226, 255, 237], 0.95);

/* ------------------------------------------------------------------ */
/* Plate rim                                                           */
/* ------------------------------------------------------------------ */

for (let y = 10; y <= 502; y += 1) {
  for (let x = 10; x <= 502; x += 1) {
    const outer = insideRoundedRect(x, y, 12, 12, 500, 500, 98);
    const inner = insideRoundedRect(x, y, 15, 15, 497, 497, 95);
    if (!outer || inner) continue;
    const warmth = clamp((x + y) / 1000, 0, 1);
    const color = mix([80, 191, 144], [183, 162, 104], warmth * 0.5);
    const alpha = 90 + (1 - warmth) * 85;
    blendPixel(x, y, color, alpha);
  }
}

// Cropped top highlight.
softArc(256, 256, 225, 225, 0, [225, 255, 238], 34, 1, 0);

/* ------------------------------------------------------------------ */
/* Downsample and encode                                               */
/* ------------------------------------------------------------------ */

const outputPixels = Buffer.alloc(OUTPUT_SIZE * OUTPUT_SIZE * 4, 0);
for (let y = 0; y < OUTPUT_SIZE; y += 1) {
  for (let x = 0; x < OUTPUT_SIZE; x += 1) {
    let alphaSum = 0;
    const colorSums = [0, 0, 0];
    for (let sampleY = 0; sampleY < 2; sampleY += 1) {
      for (let sampleX = 0; sampleX < 2; sampleX += 1) {
        const sourceOffset = ((y * 2 + sampleY) * SIZE + (x * 2 + sampleX)) * 4;
        const alpha = pixels[sourceOffset + 3] / 255;
        alphaSum += alpha;
        for (let channel = 0; channel < 3; channel += 1) {
          colorSums[channel] += pixels[sourceOffset + channel] * alpha;
        }
      }
    }
    const offset = (y * OUTPUT_SIZE + x) * 4;
    const outAlpha = alphaSum / 4;
    outputPixels[offset + 3] = Math.round(outAlpha * 255);
    if (alphaSum > 0) {
      for (let channel = 0; channel < 3; channel += 1) {
        outputPixels[offset + channel] = Math.round(colorSums[channel] / alphaSum);
      }
    }
  }
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc ^= buffer[index];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuffer, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

const raw = Buffer.alloc((OUTPUT_SIZE * 4 + 1) * OUTPUT_SIZE);
for (let y = 0; y < OUTPUT_SIZE; y += 1) {
  const rowOffset = y * (OUTPUT_SIZE * 4 + 1);
  raw[rowOffset] = 0;
  outputPixels.copy(raw, rowOffset + 1, y * OUTPUT_SIZE * 4, (y + 1) * OUTPUT_SIZE * 4);
}

const header = Buffer.alloc(13);
header.writeUInt32BE(OUTPUT_SIZE, 0);
header.writeUInt32BE(OUTPUT_SIZE, 4);
header[8] = 8;
header[9] = 6;
header[10] = 0;
header[11] = 0;
header[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  pngChunk('IHDR', header),
  pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  pngChunk('IEND', Buffer.alloc(0)),
]);

const output = path.join(__dirname, '..', 'assets', 'icon.png');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, png);
console.log(`Wrote ${output} (${png.length} bytes)`);
