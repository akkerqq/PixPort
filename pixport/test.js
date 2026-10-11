// Автотест PixPort: открывает окно QR, забирает токен, шлёт фото, проверяет папку.
const http = require('http');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const BASE = 'http://127.0.0.1:8765';
const FOLDER = process.argv[2];

function get(url) {
  return new Promise((res, rej) => {
    http.get(url, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => res({ code: r.statusCode, body: d, headers: r.headers }));
    }).on('error', rej);
  });
}

function postForm(url, filename, buf) {
  const boundary = '----pixport' + Math.random().toString(16).slice(2);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: image/jpeg\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, buf, tail]);
  return new Promise((res, rej) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length }
    }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => res({ code: r.statusCode, body: d }));
    });
    req.on('error', rej);
    req.end(body);
  });
}

(async () => {
  const ok = [];
  const bad = [];
  const check = (name, cond, extra = '') => (cond ? ok : bad).push(name + (extra ? ' → ' + extra : ''));

  // 1. открыть окно QR
  const page = await get(`${BASE}/?folder=${encodeURIComponent(FOLDER)}`);
  check('окно QR отдаёт 200', page.code === 200);
  check('галочка автозапуска в окне QR', page.body.includes('id="autoChk"') && page.body.includes('autostartSet'));
  check('автоподгон окна', page.body.includes('fitWin') && page.body.includes('__fitSoon'));
  check('бейдж FREE/PRO + кнопка и модалка Pro', page.body.includes('id="planBadgeTop"') && page.body.includes('id="goProBtn"') && page.body.includes('id="proOverlay"') && page.body.includes('proPay'));
  const token = (page.body.match(/const token = '([^']+)'/) || [])[1];
  check('токен извлечён', !!token, token || 'нет');

  // 2. QR-картинка
  const qr = await get(`${BASE}/api/qr?t=${token}`);
  check('QR-картинка (data:image)', qr.code === 200 && qr.body.startsWith('"data:image/png'), qr.body.slice(0, 30));

  // 3. страница телефона
  const up = await get(`${BASE}/u?t=${token}`);
  check('страница загрузки 200', up.code === 200 && up.body.includes('Снять фото'));
  check('прогресс-бар на телефоне', up.body.includes('id="upBar"') && up.body.includes('upload.onprogress'));

  // 4. отправка фото (портрет с EXIF-поворотом, 1000x1500)
  const jpg = await sharp({
    create: { width: 1000, height: 1500, channels: 3, background: { r: 30, g: 90, b: 200 } }
  }).jpeg().toBuffer();
  const send = await postForm(`${BASE}/u?t=${token}`, 'IMG_1234.HEIC', jpg);
  check('загрузка принята', send.code === 200 && JSON.parse(send.body).ok, send.body);

  // 5. файл реально в папке и это JPG
  await new Promise(r => setTimeout(r, 500));
  const files = fs.readdirSync(FOLDER);
  check('файл в папке', files.length === 1, files.join(','));
  if (files.length) {
    const buf = fs.readFileSync(path.join(FOLDER, files[0]));
    check('это валидный JPG', buf[0] === 0xFF && buf[1] === 0xD8);
    const meta = await sharp(buf).metadata();
    // free-режим (дефолт): длинная сторона режется до 960
    check('free: ужато до 960', Math.max(meta.width, meta.height) === 960, `${meta.width}x${meta.height}`);
    check('имя по нашему шаблону', /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.jpg$/.test(files[0]), files[0]);
  }

  // 6. статус для окна QR
  const st = await get(`${BASE}/api/status?t=${token}`);
  check('статус: принято 1', JSON.parse(st.body).received === 1, st.body);

  // 7. закрыли окно → токен мёртв
  await get(`${BASE}/api/close?t=${token}`);
  const dead = await get(`${BASE}/u?t=${token}`);
  check('после закрытия QR — 404', dead.code === 404);
  const dead2 = await postForm(`${BASE}/u?t=${token}`, 'x.jpg', jpg);
  check('мёртвый токен не принимает файлы', dead2.code === 404, dead2.body);

  // 8. мусорный токен
  const fake = await get(`${BASE}/api/qr?t=chemtebe`);
  check('чужой токен — 404', fake.code === 404);

  console.log('\nПРОЙДЕНО:');
  ok.forEach(o => console.log('  ✓ ' + o));
  if (bad.length) { console.log('ПРОВАЛЕНО:'); bad.forEach(b => console.log('  ✗ ' + b)); }
  console.log(`\nИтог: ${ok.length} ок, ${bad.length} провалено`);
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('Ошибка теста:', e); process.exit(1); });
