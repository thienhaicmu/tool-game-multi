'use strict';
// Phỏm QA brand icons — ONE source (phom-logo.svg) for the tool AND the bundled Chromium (user 2026-10-06: "đồng bộ
// từ tool lẫn trình duyệt"). Renders the SVG at every Windows icon size with the bundled Chromium (headless, transparent
// background) and packs them into build/phom-icon.ico (PNG-compressed entries, Vista+), plus build/phom-icon.png (256).
// Run: node scripts/phom-brand/build-icons.cjs   (outputs are committed; the packaging only reads them)
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SVG = path.join(__dirname, 'phom-logo.svg');
const CHROME = path.join(ROOT, 'runtime', 'phom-chromium', 'chrome.exe');
const OUT_ICO = path.join(ROOT, 'build', 'phom-icon.ico');
const OUT_PNG = path.join(ROOT, 'build', 'phom-icon.png');
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

function render(size, dir) {
  const html = path.join(dir, `logo-${size}.html`);
  const svg = fs.readFileSync(SVG, 'utf8').replace('<svg ', `<svg width="${size}" height="${size}" `);
  fs.writeFileSync(html, `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`);
  const png = path.join(dir, `logo-${size}.png`);
  // the headless window has a minimum size: render into a bigger page, the PNG is cropped below
  execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--default-background-color=00000000',
    `--window-size=${Math.max(size, 256)},${Math.max(size, 256)}`, `--screenshot=${png}`, 'file:///' + html.split(path.sep).join('/')], { stdio: 'ignore' });
  return cropPng(fs.readFileSync(png), size);
}

// --- minimal PNG decode/encode (RGBA 8-bit, as Chromium writes it) to crop the top-left size×size ---
const zlib = require('node:zlib');
function crc32(buf) { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function cropPng(buf, size) {
  let off = 8, w = 0, h = 0, bitDepth = 0, colorType = 0; const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); const type = buf.toString('ascii', off + 4, off + 8); const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) throw new Error(`unexpected PNG format depth=${bitDepth} type=${colorType}`);
  const bpp = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp; const px = Buffer.alloc(h * stride); let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]; const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)); const out = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[x] = v & 0xff;
    }
    out.copy(px, y * stride); prev = out;
  }
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) { const i = y * stride + x * bpp; row[1 + x * 4] = px[i]; row[2 + x * 4] = px[i + 1]; row[3 + x * 4] = px[i + 2]; row[4 + x * 4] = bpp === 4 ? px[i + 3] : 255; }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function ico(pngs) {
  const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  const dir = []; let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; e[1] = size >= 256 ? 0 : size; e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12);
    dir.push(e); offset += data.length;
  }
  return Buffer.concat([head, ...dir, ...pngs.map((p) => p.data)]);
}

function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phom-icon-'));
  const pngs = SIZES.map((size) => ({ size, data: render(size, dir) }));
  fs.mkdirSync(path.dirname(OUT_ICO), { recursive: true });
  fs.writeFileSync(OUT_ICO, ico(pngs));
  fs.writeFileSync(OUT_PNG, pngs.find((p) => p.size === 256).data);
  for (const p of pngs) fs.writeFileSync(path.join(dir, `final-${p.size}.png`), p.data);
  console.log('wrote', OUT_ICO, OUT_PNG, 'previews in', dir);
}
if (require.main === module) main();
module.exports = { ico, cropPng, SIZES };
