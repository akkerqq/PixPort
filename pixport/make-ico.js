// Собирает assets/icon.ico из assets/icon.png (PNG-in-ICO, поддерживается Vista+).
const fs = require('fs');
const sharp = require('sharp');
const path = require('path');

const src = path.join(__dirname, 'assets', 'icon.png');
const out = path.join(__dirname, 'assets', 'icon.ico');

(async () => {
  const sizes = [16, 32, 48, 64, 128, 256];
  const pngs = [];
  for (const s of sizes) {
    pngs.push({ size: s, buf: await sharp(src).resize(s, s, { fit: 'fill' }).png().toBuffer() });
  }
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);      // reserved
  header.writeUInt16LE(1, 2);      // type: icon
  header.writeUInt16LE(pngs.length, 4);
  let offset = 6 + pngs.length * 16;
  const entries = [];
  for (const { size, buf } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size === 256 ? 0 : size, 0); // width (0 = 256)
    e.writeUInt8(size === 256 ? 0 : size, 1); // height
    e.writeUInt8(0, 2);  // palette
    e.writeUInt8(0, 3);  // reserved
    e.writeUInt16LE(1, 4);  // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(buf.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += buf.length;
    entries.push({ e, buf });
  }
  const ico = Buffer.concat([header, ...entries.map(x => x.e), ...entries.map(x => x.buf)]);
  fs.writeFileSync(out, ico);
  console.log('icon.ico ok:', ico.length, 'bytes');
})().catch(e => { console.error(e); process.exit(1); });
