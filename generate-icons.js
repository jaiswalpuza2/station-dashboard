// Generates assets/icon-192.png and assets/icon-512.png from scratch.
// No npm dependencies — uses only Node built-ins.
// Produces a valid PNG with: dark navy background + brass compass glyph.
// Run once: node generate-icons.js

'use strict';
const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const BACKGROUND = { r: 0x12, g: 0x18, b: 0x1F, a: 255 }; // --ink-900
const BRASS      = { r: 0xC9, g: 0xA6, b: 0x6B, a: 255 }; // --brass
const TRANSPARENT = { r: 0, g: 0, b: 0, a: 0 };

// ---------------------------------------------------------------------------
// Minimal PNG encoder
// ---------------------------------------------------------------------------

function crc32(buf) {
  let c = 0xFFFFFFFF;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let v = i;
      for (let j = 0; j < 8; j++) v = (v & 1) ? (0xEDB88320 ^ (v >>> 1)) : (v >>> 1);
      t[i] = v;
    }
    return t;
  })());
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const body      = Buffer.concat([typeBytes, data]);
  const len       = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crc       = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, pixels) {
  // pixels: Uint8Array of width*height*4 RGBA values, row-major
  const IHDR_data = Buffer.alloc(13);
  IHDR_data.writeUInt32BE(width,  0);
  IHDR_data.writeUInt32BE(height, 4);
  IHDR_data[8]  = 8;  // bit depth
  IHDR_data[9]  = 2;  // color type: RGB  — we'll use 6 (RGBA)
  IHDR_data[9]  = 6;
  IHDR_data[10] = 0;  // compression
  IHDR_data[11] = 0;  // filter
  IHDR_data[12] = 0;  // interlace

  // Build raw filtered scanlines (filter type 0 = None for each row)
  const raw = Buffer.alloc((1 + width * 4) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter byte
    for (let x = 0; x < width; x++) {
      const src  = (y * width + x) * 4;
      const dst  = y * (width * 4 + 1) + 1 + x * 4;
      raw[dst]   = pixels[src];
      raw[dst+1] = pixels[src+1];
      raw[dst+2] = pixels[src+2];
      raw[dst+3] = pixels[src+3];
    }
  }

  const compressed = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    chunk('IHDR', IHDR_data),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Rasterizer helpers — draw into a flat RGBA pixel array
// ---------------------------------------------------------------------------

function makePixels(size) {
  return new Uint8Array(size * size * 4);
}

function setPixel(pixels, size, x, y, color, alpha = 1) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || x >= size || y < 0 || y >= size) return;
  const i = (y * size + x) * 4;
  // Alpha-blend over existing pixel
  const a  = color.a / 255 * alpha;
  const ia = 1 - a;
  pixels[i]   = Math.round(color.r * a + pixels[i]   * ia);
  pixels[i+1] = Math.round(color.g * a + pixels[i+1] * ia);
  pixels[i+2] = Math.round(color.b * a + pixels[i+2] * ia);
  pixels[i+3] = Math.min(255, pixels[i+3] + Math.round(255 * a));
}

function fillBackground(pixels, size, color) {
  for (let i = 0; i < size * size; i++) {
    pixels[i*4]   = color.r;
    pixels[i*4+1] = color.g;
    pixels[i*4+2] = color.b;
    pixels[i*4+3] = color.a;
  }
}

// Wu anti-aliased line
function drawLineAA(pixels, size, x0, y0, x1, y1, color, width = 1) {
  const steps = Math.ceil(Math.hypot(x1-x0, y1-y0) * 2);
  for (let i = 0; i <= steps; i++) {
    const t  = i / steps;
    const cx = x0 + (x1-x0) * t;
    const cy = y0 + (y1-y0) * t;
    const hw = width / 2;
    for (let dy = -Math.ceil(hw+1); dy <= Math.ceil(hw+1); dy++) {
      for (let dx = -Math.ceil(hw+1); dx <= Math.ceil(hw+1); dx++) {
        const dist = Math.hypot(dx, dy);
        if (dist > hw + 1) continue;
        const alpha = Math.max(0, Math.min(1, hw - dist + 1));
        setPixel(pixels, size, Math.round(cx+dx), Math.round(cy+dy), color, alpha);
      }
    }
  }
}

// Anti-aliased circle outline
function drawCircleAA(pixels, size, cx, cy, r, color, lineWidth = 1) {
  const steps = Math.ceil(2 * Math.PI * r * 4);
  for (let i = 0; i < steps; i++) {
    const angle = (i / steps) * 2 * Math.PI;
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    // Paint a small disk at each point for smooth thick lines
    const hw = lineWidth / 2;
    for (let dy = -Math.ceil(hw+1); dy <= Math.ceil(hw+1); dy++) {
      for (let dx = -Math.ceil(hw+1); dx <= Math.ceil(hw+1); dx++) {
        const dist = Math.hypot(dx, dy);
        if (dist > hw + 1) continue;
        const alpha = Math.max(0, Math.min(1, hw - dist + 1));
        setPixel(pixels, size, Math.round(x+dx), Math.round(y+dy), color, alpha);
      }
    }
  }
}

// Filled circle (for center dot)
function fillCircle(pixels, size, cx, cy, r, color) {
  for (let dy = -Math.ceil(r+1); dy <= Math.ceil(r+1); dy++) {
    for (let dx = -Math.ceil(r+1); dx <= Math.ceil(r+1); dx++) {
      const dist = Math.hypot(dx, dy);
      const alpha = Math.max(0, Math.min(1, r - dist + 1));
      setPixel(pixels, size, Math.round(cx+dx), Math.round(cy+dy), color, alpha);
    }
  }
}

// Tick marks at compass cardinal points
function drawTicks(pixels, size, cx, cy, outerR, innerR, count, color, lineWidth) {
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * 2 * Math.PI - Math.PI / 2;
    const x0 = cx + outerR * Math.cos(angle);
    const y0 = cy + outerR * Math.sin(angle);
    const x1 = cx + innerR * Math.cos(angle);
    const y1 = cy + innerR * Math.sin(angle);
    drawLineAA(pixels, size, x0, y0, x1, y1, color, lineWidth);
  }
}

// ---------------------------------------------------------------------------
// Render one icon at the given size
// ---------------------------------------------------------------------------

function renderIcon(size) {
  const pixels = makePixels(size);
  fillBackground(pixels, size, BACKGROUND);

  const cx = size / 2;
  const cy = size / 2;
  const pad = size * 0.08;
  const outerR = size / 2 - pad;
  const lw = Math.max(1, size * 0.032); // line width scales with size

  // Outer circle
  drawCircleAA(pixels, size, cx, cy, outerR, BRASS, lw);

  // 4 cardinal tick marks (N/E/S/W)
  drawTicks(pixels, size, cx, cy, outerR, outerR - size * 0.10, 4, BRASS, lw);

  // 4 inter-cardinal tick marks (shorter)
  drawTicks(pixels, size, cx, cy, outerR, outerR - size * 0.06, 8, BRASS, lw * 0.7);

  // Center dot
  fillCircle(pixels, size, cx, cy, lw * 1.4, BRASS);

  // Needle pointing NE (compass hand) — tip at ~40° from top, tail opposite
  const needleAngle = -45 * Math.PI / 180; // -45° = NE from top
  const tipR   = outerR * 0.62;
  const tailR  = outerR * 0.30;
  const tipX   = cx + tipR  * Math.sin(needleAngle);
  const tipY   = cy - tipR  * Math.cos(needleAngle);
  const tailX  = cx - tailR * Math.sin(needleAngle);
  const tailY  = cy + tailR * Math.cos(needleAngle);
  drawLineAA(pixels, size, tailX, tailY, tipX, tipY, BRASS, lw * 1.4);

  return pixels;
}

// ---------------------------------------------------------------------------
// Write files
// ---------------------------------------------------------------------------

const assetsDir = path.join(__dirname, 'assets');
if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir);

for (const size of [192, 512]) {
  const pixels = renderIcon(size);
  const png    = encodePNG(size, size, pixels);
  const dest   = path.join(assetsDir, `icon-${size}.png`);
  fs.writeFileSync(dest, png);
  console.log(`Written ${dest} (${png.length} bytes)`);
}

console.log('Done.');
