// Generates the PNG assets used by the Electron shell (tray icons + app icon)
// without any binary dependencies. Run via `npm run icons`.
//
// Produces:
//   assets/tray-idle.png     16x16 hollow clock ring (grey)  — timer stopped
//   assets/tray-running.png  16x16 filled clock ring (green) — timer running
//   assets/icon.png          256x256 app icon
//
// A minimal PNG encoder (truecolour + alpha, single IDAT) is implemented here.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, "..", "assets");

// ── CRC32 (for PNG chunk framing) ────────────────────────────────────────────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Encodes RGBA pixel data (Uint8Array, length = w*h*4) into a PNG buffer. */
function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour + alpha
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Prepend a per-row filter byte (0 = none).
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── Simple raster helpers ────────────────────────────────────────────────────
function canvas(size) {
  return { size, px: Buffer.alloc(size * size * 4) };
}

function setPx(c, x, y, [r, g, b, a]) {
  if (x < 0 || y < 0 || x >= c.size || y >= c.size) return;
  const i = (y * c.size + x) * 4;
  // Alpha-composite over existing pixel.
  const sa = a / 255;
  const da = c.px[i + 3] / 255;
  const outA = sa + da * (1 - sa);
  const blend = (s, d) =>
    outA === 0 ? 0 : Math.round((s * sa + d * da * (1 - sa)) / outA);
  c.px[i] = blend(r, c.px[i]);
  c.px[i + 1] = blend(g, c.px[i + 1]);
  c.px[i + 2] = blend(b, c.px[i + 2]);
  c.px[i + 3] = Math.round(outA * 255);
}

/** Draws an anti-aliased ring (or disc when innerR <= 0). */
function ring(c, cx, cy, outerR, innerR, color) {
  const s = c.size;
  const ss = 3; // supersampling factor for smooth edges
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      let hits = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss;
          const py = y + (sy + 0.5) / ss;
          const d = Math.hypot(px - cx, py - cy);
          if (d <= outerR && d >= innerR) hits++;
        }
      }
      if (hits > 0) {
        const a = Math.round((hits / (ss * ss)) * color[3]);
        setPx(c, x, y, [color[0], color[1], color[2], a]);
      }
    }
  }
}

/** Draws two clock hands from the centre. */
function hands(c, cx, cy, len, color) {
  const line = (x2, y2) => {
    const steps = Math.ceil(len * 3);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      ring(c, cx + (x2 - cx) * t, cy + (y2 - cy) * t, 0.9, 0, color);
    }
  };
  line(cx, cy - len); // minute hand (up)
  line(cx + len * 0.62, cy); // hour hand (right)
}

function makeTray(color) {
  const size = 16;
  const c = canvas(size);
  const cx = 8;
  const cy = 8;
  ring(c, cx, cy, 7, 5.2, color); // clock rim
  hands(c, cx, cy, 4, color);
  return encodePng(size, size, c.px);
}

function makeAppIcon() {
  const size = 256;
  const c = canvas(size);
  const cx = 128;
  const cy = 128;
  ring(c, cx, cy, 120, 0, [37, 99, 235, 255]); // blue disc background
  ring(c, cx, cy, 92, 74, [255, 255, 255, 255]); // white clock rim
  hands(c, cx, cy, 62, [255, 255, 255, 255]);
  return encodePng(size, size, c.px);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(resolve(OUT_DIR, "tray-idle.png"), makeTray([120, 120, 120, 255]));
writeFileSync(
  resolve(OUT_DIR, "tray-running.png"),
  makeTray([34, 197, 94, 255]),
);
writeFileSync(resolve(OUT_DIR, "icon.png"), makeAppIcon());

console.log(`Icons written to ${OUT_DIR}`);
