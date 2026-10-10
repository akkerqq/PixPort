// Проверка лицензий и лимита 720p: без ключа — ресайз, с ключом — оригинал.
const http = require('http');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { mintKey, validateKey, activateKey, clearLicense, licenseState } = require('./license');

const BASE = 'http://127.0.0.1:8765';
const FOLDER = process.argv[2];

function get(url) {
  return new Promise((res, rej) => http.get(url, r => {
    let d = ''; r.on('data', c => d += c); r.on('end', () => res({ code: r.statusCode, body: d }));
  }).on('error', rej));
}
function post(url, obj) {
  const body = Buffer.from(JSON.stringify(obj || {}));
  return new Promise((res, rej) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } },
      r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res({ code: r.statusCode, body: d })); });
    req.on('error', rej); req.end(body);
  });
}
function postForm(url, filename, buf) {
  const boundary = '----pixport' + Math.random().toString(16).slice(2);
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/jpeg\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, buf, tail]);
  return new Promise((res, rej) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length } },
      r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res({ code: r.statusCode, body: d })); });
    req.on('error', rej); req.end(body);
  });
}

(async () => {
  const ok = [], bad = [];
  const check = (n, c, e = '') => (c ? ok : bad).push(n + (e ? ' → ' + e : ''));

  // --- юнит: ключи ---
  const key = mintKey();
  check('свежий ключ валиден', validateKey(key), key);
  check('битый ключ отклонён', !validateKey('PP-AAAAAA-BBBBBB-CCCCCC'));
  check('мусор отклонён', !validateKey('hello'));
  check('пустой отклонён', !validateKey(''));

  // --- активация через API (localhost) ---
  const off0 = await post(`${BASE}/api/license/off`);
  check('сброс до теста ok', JSON.parse(off0.body).pro === false, off0.body);
  const bad1 = await post(`${BASE}/api/license`, { key: 'PP-ZZZZZZ-ZZZZZZ-ZZZZZZ' });
  check('неверный ключ → 400', bad1.code === 400, bad1.body);
  const good = await post(`${BASE}/api/license`, { key });
  const gs = JSON.parse(good.body);
  check('верный ключ → Pro', gs.ok === true && gs.pro === true, good.body);
  const st = await get(`${BASE}/api/license`);
  check('GET /api/license → pro', JSON.parse(st.body).pro === true, st.body);

  // --- лимит 720p vs Pro ---
  const jpg = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: { r: 30, g: 90, b: 200 } } }).jpeg().toBuffer();

  // Pro: оригинал 3000x2000
  const page1 = await get(`${BASE}/?folder=${encodeURIComponent(FOLDER)}`);
  const t1 = (page1.body.match(/const token = '([^']+)'/) || [])[1];
  await postForm(`${BASE}/u?t=${t1}`, 'a.jpg', jpg);
  await new Promise(r => setTimeout(r, 600));
  const f1 = fs.readdirSync(FOLDER);
  const m1 = await sharp(fs.readFileSync(path.join(FOLDER, f1[0]))).metadata();
  check('Pro: 3000x2000 без потерь', m1.width === 3000 && m1.height === 2000, `${m1.width}x${m1.height}`);
  check('секция подписки в окне QR', page1.body.includes('id="subRow"') && page1.body.includes('subDescFree'));

  // Free: 1280 по длинной стороне
  const off = await post(`${BASE}/api/license/off`);
  check('deactivate ok', JSON.parse(off.body).pro === false, off.body);
  const page2 = await get(`${BASE}/?folder=${encodeURIComponent(FOLDER)}`);
  const t2 = (page2.body.match(/const token = '([^']+)'/) || [])[1];
  await postForm(`${BASE}/u?t=${t2}`, 'b.jpg', jpg);
  await new Promise(r => setTimeout(r, 600));
  const f2 = fs.readdirSync(FOLDER).sort((a, b) => fs.statSync(path.join(FOLDER, b)).mtimeMs - fs.statSync(path.join(FOLDER, a)).mtimeMs);
  check('free: второй файл лёг', f2.length === 2, f2.join(','));
  const m2 = await sharp(fs.readFileSync(path.join(FOLDER, f2[0]))).metadata();
  check('free: длинная сторона 1280', Math.max(m2.width, m2.height) === 1280, `${m2.width}x${m2.height}`);

  // маленькое фото не дуем
  const small = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().toBuffer();
  await postForm(`${BASE}/u?t=${t2}`, 'c.jpg', small);
  await new Promise(r => setTimeout(r, 600));
  const f3 = fs.readdirSync(FOLDER).sort((a, b) => fs.statSync(path.join(FOLDER, b)).mtimeMs - fs.statSync(path.join(FOLDER, a)).mtimeMs);
  const m3 = await sharp(fs.readFileSync(path.join(FOLDER, f3[0]))).metadata();
  check('free: маленькое фото не увеличивается', m3.width === 640 && m3.height === 480, `${m3.width}x${m3.height}`);

  // восстановить состояние: было free
  clearLicense();
  await get(`${BASE}/api/close?t=${t2}`);
  await get(`${BASE}/api/close?t=${t1}`);

  console.log('\nПРОЙДЕНО:'); ok.forEach(o => console.log('  ✓ ' + o));
  if (bad.length) { console.log('ПРОВАЛЕНО:'); bad.forEach(b => console.log('  ✗ ' + b)); }
  console.log(`\nИтог: ${ok.length} ок, ${bad.length} провалено`);
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('Ошибка теста:', e); process.exit(1); });
