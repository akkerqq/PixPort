// Проверка лицензий и лимита 960px: без ключа — ресайз, с ключом — оригинал.
const http = require('http');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { mintKey, mintBoundKey, validateKey, activateKey, clearLicense, licenseState } = require('./license');

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

  // --- юнит: именные ключи (привязка к железу) ---
  process.env.PIXPORT_HWID = 'TEST-PC-1';
  const bk = mintBoundKey('TEST-PC-1');
  check('именной: свой код — ок', validateKey(bk), bk);
  process.env.PIXPORT_HWID = 'TEST-PC-2';
  check('именной: чужой ПК — отказ', !validateKey(bk));
  check('открытый: работает на любом ПК', validateKey(key));
  process.env.PIXPORT_HWID = 'TEST-PC-1';
  check('именной: кривой формат — отказ', !validateKey(bk.slice(0, -2) + 'ZZ'));
  delete process.env.PIXPORT_HWID;

  // --- активация через API (localhost) ---
  const off0 = await post(`${BASE}/api/license/off`);
  check('сброс до теста ok', JSON.parse(off0.body).pro === false, off0.body);
  const bad1 = await post(`${BASE}/api/license`, { key: 'PP-ZZZZZZ-ZZZZZZ-ZZZZZZ' });
  check('неверный ключ → 400', bad1.code === 400, bad1.body);
  const good = await post(`${BASE}/api/license`, { key });
  const gs = JSON.parse(good.body);
  check('верный ключ → Pro', gs.ok === true && gs.pro === true, good.body);
  const st = await get(`${BASE}/api/license`);
  const stj = JSON.parse(st.body);
  check('GET /api/license → pro', stj.pro === true, st.body);
  check('GET /api/license → код машины', typeof stj.hwid === 'string' && stj.hwid.length > 0, st.body);

  // --- лимит 960px vs Pro ---
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
  check('код машины + показ ключа в настройках', page1.body.includes('id="pcCode"') && page1.body.includes('id="subKeyShow"') && page1.body.includes('pcCodeHint'));

  // --- именной ключ сквозняком через API: под код машины сервера — Pro, под чужой — 400 ---
  await post(`${BASE}/api/license/off`);
  const bgood = await post(`${BASE}/api/license`, { key: mintBoundKey(stj.hwid) });
  check('именной под этот ПК → Pro', JSON.parse(bgood.body).pro === true, bgood.body);
  await post(`${BASE}/api/license/off`);
  const bbad = await post(`${BASE}/api/license`, { key: mintBoundKey('PC-СОСЕДА-123') });
  check('именной под чужой ПК → 400', bbad.code === 400, bbad.body);
  await post(`${BASE}/api/license`, { key }); // вернуть Pro для дальнейших кейсов

  // Free: 960 по длинной стороне
  const off = await post(`${BASE}/api/license/off`);
  check('deactivate ok', JSON.parse(off.body).pro === false, off.body);
  const page2 = await get(`${BASE}/?folder=${encodeURIComponent(FOLDER)}`);
  const t2 = (page2.body.match(/const token = '([^']+)'/) || [])[1];
  await postForm(`${BASE}/u?t=${t2}`, 'b.jpg', jpg);
  await new Promise(r => setTimeout(r, 600));
  const f2 = fs.readdirSync(FOLDER).sort((a, b) => fs.statSync(path.join(FOLDER, b)).mtimeMs - fs.statSync(path.join(FOLDER, a)).mtimeMs);
  check('free: второй файл лёг', f2.length === 2, f2.join(','));
  const m2 = await sharp(fs.readFileSync(path.join(FOLDER, f2[0]))).metadata();
  check('free: длинная сторона 960', Math.max(m2.width, m2.height) === 960, `${m2.width}x${m2.height}`);

  // маленькое фото не дуем
  const small = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().toBuffer();
  await postForm(`${BASE}/u?t=${t2}`, 'c.jpg', small);
  await new Promise(r => setTimeout(r, 600));
  const f3 = fs.readdirSync(FOLDER).sort((a, b) => fs.statSync(path.join(FOLDER, b)).mtimeMs - fs.statSync(path.join(FOLDER, a)).mtimeMs);
  const m3 = await sharp(fs.readFileSync(path.join(FOLDER, f3[0]))).metadata();
  check('free: маленькое фото не увеличивается', m3.width === 640 && m3.height === 480, `${m3.width}x${m3.height}`);

  // --- файлы и видео: только Pro ---
  const mp4 = Buffer.concat([Buffer.from('....ftypisom....mp4fake'), Buffer.alloc(5000, 7)]); // псевдо-mp4, байт в байт
  // Pro кладёт как есть
  await post(`${BASE}/api/license`, { key });
  const page3 = await get(`${BASE}/?folder=${encodeURIComponent(FOLDER)}`);
  const t3 = (page3.body.match(/const token = '([^']+)'/) || [])[1];
  check('кнопка Файл видна в Pro', (await get(`${BASE}/u?t=${t3}`)).body.includes('data-i="btn_file"'));
  const vd = await postForm(`${BASE}/u?t=${t3}`, 'clip.mp4', mp4);
  check('pro: видео принято', vd.code === 200 && JSON.parse(vd.body).ok, vd.body);
  await new Promise(r => setTimeout(r, 600));
  const f4 = fs.readdirSync(FOLDER).sort((a, b) => fs.statSync(path.join(FOLDER, b)).mtimeMs - fs.statSync(path.join(FOLDER, a)).mtimeMs);
  const rawBack = fs.readFileSync(path.join(FOLDER, f4[0]));
  check('pro: видео лежит как есть (.mp4, байт в байт)', f4[0].endsWith('.mp4') && rawBack.equals(mp4), `${f4[0]}, ${rawBack.length} байт`);
  await get(`${BASE}/api/close?t=${t3}`);
  // free видео не берёт
  await post(`${BASE}/api/license/off`);
  const page4 = await get(`${BASE}/?folder=${encodeURIComponent(FOLDER)}`);
  const t4 = (page4.body.match(/const token = '([^']+)'/) || [])[1];
  check('кнопки Файл нет во free', !(await get(`${BASE}/u?t=${t4}`)).body.includes('data-i="btn_file"'));
  const vdFree = await postForm(`${BASE}/u?t=${t4}`, 'clip.mp4', mp4);
  check('free: видео отклонено', vdFree.code === 500 && vdFree.body.includes('только фото'), vdFree.body);
  await get(`${BASE}/api/close?t=${t4}`);

  // --- лимиты веса ---
  const page5 = await get(`${BASE}/?folder=${encodeURIComponent(FOLDER)}`);
  const t5 = (page5.body.match(/const token = '([^']+)'/) || [])[1];
  const big = Buffer.alloc(70 * 1024 * 1024, 3); // 70 МБ > free-лимита 60 МБ
  const bigFree = await postForm(`${BASE}/u?t=${t5}`, 'big.mp4', big);
  check('free: больше 60 МБ отклонено', bigFree.code === 500 && bigFree.body.includes('больше 60'), bigFree.body);
  await get(`${BASE}/api/close?t=${t5}`);

  // moveFile (rename внутри, copy между дисками) отдельно не дёрнуть —
  // но каждый Pro-файл выше уже прошёл через него. Здесь только лимит:
  check('moveFile есть в коде', fs.readFileSync(require('path').join(__dirname, 'server.js'), 'utf8').includes('function moveFile'));

  // восстановить состояние: было free
  clearLicense();
  await get(`${BASE}/api/close?t=${t2}`);
  await get(`${BASE}/api/close?t=${t1}`);

  console.log('\nПРОЙДЕНО:'); ok.forEach(o => console.log('  ✓ ' + o));
  if (bad.length) { console.log('ПРОВАЛЕНО:'); bad.forEach(b => console.log('  ✗ ' + b)); }
  console.log(`\nИтог: ${ok.length} ок, ${bad.length} провалено`);
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('Ошибка теста:', e); process.exit(1); });
