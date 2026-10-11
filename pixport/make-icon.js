// Генератор эмблемы PixPort: SVG -> assets/icon.png (512). Потом node make-ico.js.
// Запуск: node make-icon.js
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const BRAND = '#3d52f0';

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect x="16" y="16" width="480" height="480" rx="112" fill="${BRAND}"/>
  <text x="256" y="352" text-anchor="middle" font-family="Arial, Helvetica, sans-serif"
        font-weight="900" font-size="228" letter-spacing="2" fill="#ffffff">PxP</text>
</svg>`;

(async () => {
  const out = path.join(__dirname, 'assets', 'icon.png');
  fs.writeFileSync(path.join(__dirname, 'assets', 'icon.svg'), svg);
  await sharp(Buffer.from(svg)).png().toFile(out);
  console.log('icon.png ok');
})().catch(e => { console.error(e); process.exit(1); });
