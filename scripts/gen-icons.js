'use strict';

/**
 * Generates the PWA icons (public/icon-192.png, icon-512.png,
 * icon-maskable-512.png) with zero dependencies: it draws the keyboard glyph
 * into an RGBA buffer and encodes PNG chunks by hand with Node's zlib.
 *
 *   node scripts/gen-icons.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------- tiny PNG encoder ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // compression, filter, interlace = 0
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- drawing ----------
function hex(c) {
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16), 255];
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function render(size, { maskable }) {
  const px = Buffer.alloc(size * size * 4);
  const put = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = a;
  };

  const BG_TOP = hex('#131a26');
  const BG_BOTTOM = hex('#0d1117');
  const KEY = hex('#232e45');
  const KEY_ALT = hex('#161d2c');
  const KEY_ACCENT = hex('#0ea5c9');
  const DOT = hex('#22d3ee');

  // background: vertical gradient (full-bleed for maskable, rounded for "any")
  const corner = maskable ? 0 : size * 0.18;
  for (let y = 0; y < size; y++) {
    const t = y / size;
    const r = Math.round(lerp(BG_TOP[0], BG_BOTTOM[0], t));
    const g = Math.round(lerp(BG_TOP[1], BG_BOTTOM[1], t));
    const b = Math.round(lerp(BG_TOP[2], BG_BOTTOM[2], t));
    for (let x = 0; x < size; x++) {
      if (corner === 0) {
        put(x, y, r, g, b, 255);
        continue;
      }
      // rounded-corner test
      const rx = Math.min(x, size - 1 - x);
      const ry = Math.min(y, size - 1 - y);
      if (rx >= corner || ry >= corner) {
        put(x, y, r, g, b, 255);
      } else {
        const dx = corner - rx;
        const dy = corner - ry;
        if (dx * dx + dy * dy <= corner * corner) put(x, y, r, g, b, 255);
      }
    }
  }

  // rounded-rect SDF fill
  const fillRounded = (x0, y0, x1, y1, radius, color) => {
    const r = Math.max(1, Math.round(radius));
    for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
      for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
        const cx = Math.min(Math.max(x, x0 + r), x1 - r);
        const cy = Math.min(Math.max(y, y0 + r), y1 - r);
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= r * r) put(x, y, color[0], color[1], color[2], color[3]);
      }
    }
  };

  const circle = (cx, cy, radius, color) => {
    const r = Math.max(1, Math.round(radius));
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= r * r) put(x, y, color[0], color[1], color[2], color[3]);
      }
    }
  };

  // glyph area (scaled into the safe zone for maskable icons)
  const m = maskable ? 0.11 : 0.08;
  const x0 = size * m;
  const x1 = size * (1 - m);
  const yTop = size * (maskable ? 0.30 : 0.32);
  const yBot = size * (maskable ? 0.82 : 0.86);
  const gap = size * 0.014;
  const rad = size * 0.018;

  // 4 key rows + spacebar row
  const rows = [
    { y: 0, tint: [true, false] },
    { y: 1, tint: [true, true] },
    { y: 2, tint: [true, true] },
    { y: 3, tint: [true, true] },
  ];
  const nRows = rows.length;
  const rowGap = gap;
  const rowH = (yBot - yTop - rowGap * (nRows - 1)) / (nRows + 0.55);
  const nKeys = 10;
  const keyGap = gap;
  const keyW = (x1 - x0 - keyGap * (nKeys - 1)) / nKeys;

  rows.forEach((row, ri) => {
    const y0 = yTop + ri * (rowH + rowGap);
    for (let ki = 0; ki < nKeys; ki++) {
      const kx0 = x0 + ki * (keyW + keyGap);
      const alt = (ki === 0 && row.tint[0]) || (ki === nKeys - 1 && row.tint[1]);
      fillRounded(kx0, y0, kx0 + keyW, y0 + rowH, rad, alt ? KEY_ALT : KEY);
    }
  });

  // spacebar row (accent)
  const spY0 = yTop + nRows * (rowH + rowGap);
  const spX0 = x0 + keyW + keyGap * 1.5;
  const spX1 = x1 - keyW - keyGap * 1.5;
  fillRounded(spX0, spY0, spX1, spY0 + rowH, rad, KEY_ACCENT);

  // status dot (top-right)
  circle(size * 0.80, size * 0.14, size * 0.030, DOT);

  return encodePNG(size, size, px);
}

// ---------- ICO (Windows app icon) ----------
// A modern .ico is just an index header + a list of embedded PNGs.
function makeIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + pngs.length * 16;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 == 256)
    e.writeUInt8(size >= 256 ? 0 : size, 1); // height
    e.writeUInt8(0, 2); // palette
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bit depth
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

const outDir = path.join(__dirname, '..', 'public');
fs.writeFileSync(path.join(outDir, 'icon-192.png'), render(192, { maskable: false }));
fs.writeFileSync(path.join(outDir, 'icon-512.png'), render(512, { maskable: false }));
fs.writeFileSync(path.join(outDir, 'icon-maskable-512.png'), render(512, { maskable: true }));
fs.writeFileSync(
  path.join(outDir, 'icon.ico'),
  makeIco([16, 32, 48, 256].map((s) => ({ size: s, data: render(s, { maskable: false }) })))
);
console.log('Wrote icon-192.png, icon-512.png, icon-maskable-512.png, icon.ico');
console.log('wrote public/icon-192.png, public/icon-512.png, public/icon-maskable-512.png');