'use strict';
// Gera os ícones do app (esfera dourada) sem dependências: build/icon.png (256), build/icon.ico e build/tray.png (32).
// Rode `node scripts/make-icons.js` se quiser mudar o desenho.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5, size);
      raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// esfera âmbar com brilho no centro e um anel fino
function sphere(x, y, size) {
  const c = size / 2, d = Math.hypot(x - c, y - c) / c;   // 0 no centro, 1 na borda
  if (d > 0.94) return [0, 0, 0, 0];
  const edge = Math.min(1, (0.94 - d) / 0.03);              // borda suave
  const ring = Math.abs(d - 0.72) < 0.035 ? 0.35 : 0;
  const core = Math.max(0, 1 - d / 0.55) ** 1.5;
  const t = Math.min(1, 0.18 + core * 0.9 + ring + (1 - d) * 0.25);
  const dim = d > 0.8 ? 0.6 : 1;
  const r = Math.round(dim * 255 * Math.min(1, 0.45 + t)), g = Math.round(154 + 100 * t * t), b = Math.round(31 + 150 * core);
  return [r, Math.min(255, g), Math.min(255, b), Math.round(255 * edge)];
}

const dir = path.join(__dirname, '..', 'build');
fs.mkdirSync(dir, { recursive: true });
const big = png(256, sphere);
fs.writeFileSync(path.join(dir, 'icon.png'), big);
fs.writeFileSync(path.join(dir, 'tray.png'), png(32, sphere));
// .ico com um único PNG de 256x256 (formato aceito desde o Windows Vista)
const head = Buffer.alloc(22);
head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
head[6] = 0; head[7] = 0; head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12);
head.writeUInt32LE(big.length, 14); head.writeUInt32LE(22, 18);
fs.writeFileSync(path.join(dir, 'icon.ico'), Buffer.concat([head, big]));
console.log('ícones gerados em build/');
