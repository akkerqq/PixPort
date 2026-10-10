// Проверка собранной версии: sharp должен конвертировать и сохранять фото.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const sharp = require('sharp');

const FOLDER = path.join(os.tmpdir(), 'pixport-pack-test');

function get(u) {
  return new Promise((res, rej) => {
    http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); })
      .on('error', rej);
  });
}

function post(u, filename, buf) {
  const b = '----t' + Date.now();
  const body = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/jpeg\r\n\r\n`),
    buf,
    Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  return new Promise((res, rej) => {
    const q = http.request({
      hostname: '127.0.0.1', port: 8765, path: u, method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${b}`, 'Content-Length': body.length },
    }, x => { let d = ''; x.on('data', c => d += c); x.on('end', () => res({ code: x.statusCode, body: d })); });
    q.on('error', rej);
    q.end(body);
  });
}

(async () => {
  fs.mkdirSync(FOLDER, { recursive: true });
  const page = await get('http://127.0.0.1:8765/?folder=' + encodeURIComponent(FOLDER));
  const t = /const token = '([^']+)'/.exec(page)[1];

  // картинка «с телефона» — пусть с поворотом
  const jpg = await sharp({ create: { width: 900, height: 600, channels: 3, background: { r: 10, g: 200, b: 90 } } })
    .rotate(90).jpeg().toBuffer();

  const r = await post('/u?t=' + t, 'IMG_999.HEIC', jpg);
  const files = fs.readdirSync(FOLDER);
  let meta = null;
  if (files.length) meta = await sharp(path.join(FOLDER, files[0])).metadata();

  console.log('ответ сервера :', r.code, r.body);
  console.log('файлы         :', files);
  console.log('метаданные    :', meta ? `${meta.width}x${meta.height} ${meta.format}` : 'нет');

  const ok = r.code === 200 && files.length === 1 && meta && meta.format === 'jpeg';
  console.log(ok ? '\n✓ СОБРАННАЯ ВЕРСИЯ РАБОТАЕТ (sharp жив)' : '\n✗ ПРОБЛЕМА');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('ОШИБКА:', e.message); process.exit(1); });
