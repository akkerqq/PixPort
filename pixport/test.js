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

function postChunk(token, cid, i, n, filename, buf) {
  return new Promise((res, rej) => {
    const req = http.request({
      hostname: '127.0.0.1', port: 8765, method: 'POST',
      path: `/u?t=${token}&cid=${cid}&i=${i}&n=${n}&name=${encodeURIComponent(filename)}`,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length }
    }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => res({ code: r.statusCode, body: d }));
    });
    req.on('error', rej);
    req.end(buf);
  });
}
// кусок в multipart-упаковке (как шлёт новый клиент): поля ПЕРЕД файлом
function postChunkMulti(token, fields, filename, buf) {
  const boundary = '----pixport' + Math.random().toString(16).slice(2);
  const parts = [];
  for (const k of Object.keys(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${fields[k]}\r\n`));
  }
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="chunk"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`));
  parts.push(buf);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  const body = Buffer.concat(parts);
  return new Promise((res, rej) => {
    const req = http.request({
      hostname: '127.0.0.1', port: 8765, method: 'POST', path: `/u?t=${token}`,
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

function postJson(url, obj) {
  const body = Buffer.from(JSON.stringify(obj || {}));
  return new Promise((res, rej) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length }
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

  // 0. окно выбора папки (до создания сессий): патчноут «что нового»
  const pick0 = await get(`${BASE}/`);
  check('что нового: окно + текст версии', pick0.body.includes('id="wnOverlay"') && pick0.body.includes('pixport-wn-seen') && pick0.body.includes('Чат сессии'), 'патчноута нет');
  const wimg = await get(`${BASE}/assets/whatsnew.png`);
  check('что нового: баннер отдаётся', wimg.code === 200 && (wimg.headers['content-type'] || '').includes('image/png'), wimg.code + '');

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

  // 9. чанковая загрузка (баг №1: большие видео кусками, а не одним XHR)
  const page2 = await get(`${BASE}/?folder=${encodeURIComponent(FOLDER)}`);
  const token2 = (page2.body.match(/const token = '([^']+)'/) || [])[1];
  check('чанки: вторая сессия открыта', !!token2);
  const up2 = await get(`${BASE}/u?t=${token2}`);
  check('предпроверка лимита и чанки на телефоне', up2.body.includes('const MAXSIZE') && up2.body.includes('sendChunked') && up2.body.includes('sendFiles'), up2.body.slice(0, 80));
  // JS страницы телефона обязан парситься: немая смерть скрипта = «выбрал и тишина» (баг 12.10, лишний })
  let jsOk = false, jsErr = '';
  try {
    const blocks = [...up2.body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x => x[1]);
    const sendJs = blocks.find(s => s.includes('function sendFiles'));
    if (!sendJs) throw new Error('блок отправки не найден');
    new (require('vm').Script)(sendJs);
    jsOk = true;
  } catch (e) { jsErr = e.message; }
  check('JS отправки без синтаксических ошибок', jsOk, jsErr);
  const half = Math.ceil(jpg.length / 2);
  const cid = 'abcdef0123456789';
  const c0 = await postChunk(token2, cid, 0, 2, 'IMG_CHUNK.jpg', jpg.subarray(0, half));
  check('чанк 0 принят', c0.code === 200 && JSON.parse(c0.body).ok, c0.body);
  const cdup = await postChunk(token2, cid, 0, 2, 'IMG_CHUNK.jpg', jpg.subarray(0, half));
  check('дубль чанка — тоже ок (ретрай)', cdup.code === 200 && JSON.parse(cdup.body).ok, cdup.body);
  const c1 = await postChunk(token2, cid, 1, 2, 'IMG_CHUNK.jpg', jpg.subarray(half));
  check('чанк 1 склеен в файл', c1.code === 200 && JSON.parse(c1.body).ok, c1.body);
  const cbad = await postChunk(token2, 'zzz', 0, 2, 'x.jpg', jpg.subarray(0, half));
  check('кривой cid отклонён', cbad.code === 400, cbad.body);

  // 10. куски в multipart-упаковке (новые клиенты): для middlebox как обычное фото
  const page3 = await get(`${BASE}/?folder=${encodeURIComponent(FOLDER)}`);
  const token3 = (page3.body.match(/const token = '([^']+)'/) || [])[1];
  const cid3 = 'feedface12345678';
  const m0 = await postChunkMulti(token3, { cid: cid3, i: 0, n: 2, name: 'IMG_MULTI.jpg' }, 'chunk', jpg.subarray(0, half));
  check('multipart-кусок 0 принят', m0.code === 200 && JSON.parse(m0.body).ok, m0.body);
  const m1 = await postChunkMulti(token3, { cid: cid3, i: 1, n: 2, name: 'IMG_MULTI.jpg' }, 'chunk', jpg.subarray(half));
  check('multipart-кусок 1 склеен в файл', m1.code === 200 && JSON.parse(m1.body).ok, m1.body);
  const mno = await postChunkMulti(token3, { i: 0, n: 1, name: 'x.jpg' }, 'chunk', jpg.subarray(0, 100));
  check('multipart без cid — обычное фото (мусор отклонён как фото)', mno.code === 500 && mno.body.includes('только фото'), mno.body);

  // 11. пустой файл (iOS iCloud: виден в пикере, но не скачан) — честная ошибка, а не пустой файл в папке
  const page4 = await get(`${BASE}/?folder=${encodeURIComponent(FOLDER)}`);
  const token4 = (page4.body.match(/const token = '([^']+)'/) || [])[1];
  const zero = await postChunkMulti(token4, { i: 0, n: 1, name: 'EMPTY.mp4' }, 'chunk', Buffer.alloc(0));
  const zj = JSON.parse(zero.body);
  check('пустой файл отклонён с ключом empty', zero.code === 500 && zj.error === 'empty', zero.body);

  // 12. чат сессии: текст/ссылки с телефона на ПК без интернета (+ записка в папку)
  const page5 = await get(`${BASE}/?folder=${encodeURIComponent(FOLDER)}`);
  const token5 = (page5.body.match(/const token = '([^']+)'/) || [])[1];
  check('чат: кнопка в окне QR', page5.body.includes('id="chatBtn"') && page5.body.includes('id="chatOverlay"'), 'кнопки нет');
  let qrJsOk = false, qrJsErr = '';
  try {
    const qblocks = [...page5.body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x => x[1]);
    const chatJs = qblocks.find(s => s.includes('function openChat'));
    if (!chatJs) throw new Error('блок чата не найден');
    new (require('vm').Script)(chatJs);
    qrJsOk = true;
  } catch (e) { qrJsErr = e.message; }
  check('чат: JS окна без синтаксических ошибок', qrJsOk, qrJsErr);
  const up5 = await get(`${BASE}/u?t=${token5}`);
  check('чат: поле ввода на телефоне', up5.body.includes('id="msgIn"') && up5.body.includes('function sendMsg'), 'поля нет');
  check('чат: шторка на телефоне как на ПК', up5.body.includes('id="msgOverlay"') && up5.body.includes('function openMsgs') && up5.body.includes('id="msgOpenBtn"'), 'шторки нет');
  const g1 = await postJson(`${BASE}/u?t=${token5}&msg=1`, { text: 'https://example.com/very/long/link?x=1' });
  check('чат: сообщение с телефона принято', g1.code === 200 && JSON.parse(g1.body).ok, g1.body);
  const gEmpty = await postJson(`${BASE}/u?t=${token5}&msg=1`, { text: '   ' });
  check('чат: пустое отклонено', gEmpty.code === 400, gEmpty.body);
  const gPc = await postJson(`${BASE}/api/msg?t=${token5}`, { text: 'привет с ПК <b>не тег</b>' });
  check('чат: ответ с ПК принят', gPc.code === 200 && JSON.parse(gPc.body).ok, gPc.body);
  const ml = await get(`${BASE}/u?t=${token5}&msgs=1&since=0`);
  const mlj = JSON.parse(ml.body);
  check('чат: оба сообщения читаются', ml.code === 200 && mlj.n === 2 && mlj.msgs[0].from === 'phone' && mlj.msgs[1].from === 'pc', ml.body);
  check('чат: HTML хранится сырым (экранирует клиент)', mlj.msgs[1].text.includes('<b>'), mlj.msgs[1].text);
  const ml1 = await get(`${BASE}/u?t=${token5}&msgs=1&since=1`);
  check('чат: since отдаёт только новые', JSON.parse(ml1.body).msgs.length === 1, ml1.body);
  const st5 = await get(`${BASE}/api/status?t=${token5}`);
  check('чат: статус несёт счётчик', JSON.parse(st5.body).msgN === 2, st5.body);
  await new Promise(r => setTimeout(r, 300));
  const notes = fs.readdirSync(FOLDER).filter(f => f.startsWith('note-') && f.endsWith('.txt'));
  check('чат: записка note-*.txt в папке', notes.length === 2, notes.join(','));

  // 13. обратная передача ПК → телефон: выложил в окне — забрал по ссылке
  fs.writeFileSync(path.join(FOLDER, 'give.jpg'), jpg);
  fs.writeFileSync(path.join(FOLDER, 'give.txt'), 'hello-share');
  const page6 = await get(`${BASE}/?folder=${encodeURIComponent(FOLDER)}`);
  const token6 = (page6.body.match(/const token = '([^']+)'/) || [])[1];
  check('раздача: блок в окне QR', page6.body.includes('id="shareBox"') && page6.body.includes('function postShare'), 'блока нет');
  const up6 = await get(`${BASE}/u?t=${token6}`);
  check('раздача: секция на телефоне', up6.body.includes('id="dlList"') && up6.body.includes('function pollDl'), 'секции нет');
  const sh = await postJson(`${BASE}/api/share?t=${token6}`, { paths: [path.join(FOLDER, 'give.jpg'), path.join(FOLDER, 'give.txt'), path.join(FOLDER, 'нетакого.bin')] });
  const shj = JSON.parse(sh.body);
  check('раздача: 2 добавлено, мусор пропущен', sh.code === 200 && shj.added.length === 2 && !shj.folder, sh.body);
  const shDup = await postJson(`${BASE}/api/share?t=${token6}`, { paths: [path.join(FOLDER, 'give.jpg')] });
  check('раздача: дубль не плодится', JSON.parse(shDup.body).added.length === 0, shDup.body);
  const dl = await get(`${BASE}/u?t=${token6}&share=1`);
  const dlj = JSON.parse(dl.body);
  check('раздача: free видит только картинки', dl.code === 200 && dlj.items.length === 1 && dlj.items[0].name === 'give.jpg', dl.body);
  const gid = dlj.items[0].id;
  const gf = await get(`${BASE}/u?t=${token6}&get=` + gid);
  check('раздача: скачивание 200 + jpeg', gf.code === 200 && (gf.headers['content-type'] || '').includes('image/jpeg'), gf.code + ' ' + gf.headers['content-type']);
  const gBad = await get(`${BASE}/u?t=${token6}&get=nope`);
  check('раздача: чужой id — 404', gBad.code === 404, gBad.body);
  const gTrav = await get(`${BASE}/u?t=${token6}&get=../give.jpg`);
  check('раздача: обход путём — 404', gTrav.code === 404, gTrav.body);
  const uns = await postJson(`${BASE}/api/unshare?t=${token6}`, { id: gid });
  check('раздача: снятие с раздачи', uns.code === 200 && JSON.parse(uns.body).share.length === 1, uns.body);
  const dl2 = await get(`${BASE}/u?t=${token6}&share=1`);
  check('раздача: телефон больше не видит', JSON.parse(dl2.body).items.length === 0, dl2.body);

  // 14. чистка записок: вопрос перед новым QR + ручная кнопка, чужие файлы целы
  const page7 = await get(`${BASE}/?folder=${encodeURIComponent(FOLDER)}`);
  const token7 = (page7.body.match(/const token = '([^']+)'/) || [])[1];
  check('чистка: окно-подтверждение в QR', page7.body.includes('id="cleanOverlay"') && page7.body.includes('function cleanAsk'), 'окна нет');
  await postJson(`${BASE}/api/msg?t=${token7}`, { text: 'удали меня 1' });
  await postJson(`${BASE}/api/msg?t=${token7}`, { text: 'удали меня 2' });
  await new Promise(r => setTimeout(r, 200));
  const notesBefore = fs.readdirSync(FOLDER).filter(f => f.startsWith('note-') && f.endsWith('.txt'));
  const st7 = await get(`${BASE}/api/status?t=${token7}`);
  check('чистка: счётчик записок в статусе', JSON.parse(st7.body).notes === 2, st7.body);
  const cl = await postJson(`${BASE}/api/cleannotes?t=${token7}`, {});
  check('чистка: удалено 2', cl.code === 200 && JSON.parse(cl.body).removed === 2, cl.body);
  const notesAfter = fs.readdirSync(FOLDER).filter(f => f.startsWith('note-') && f.endsWith('.txt'));
  check('чистка: с диска ушли только свои', notesAfter.length === notesBefore.length - 2, notesAfter.join(','));
  check('чистка: чужие файлы целы', fs.existsSync(path.join(FOLDER, 'give.jpg')) && fs.existsSync(path.join(FOLDER, 'give.txt')), 'побили чужое');
  const st7b = await get(`${BASE}/api/status?t=${token7}`);
  check('чистка: счётчик обнулён', JSON.parse(st7b.body).notes === 0, st7b.body);
  const cl2 = await postJson(`${BASE}/api/cleannotes?t=${token7}`, {});
  check('чистка: повтор — 0', JSON.parse(cl2.body).removed === 0, cl2.body);

  console.log('\nПРОЙДЕНО:');
  ok.forEach(o => console.log('  ✓ ' + o));
  if (bad.length) { console.log('ПРОВАЛЕНО:'); bad.forEach(b => console.log('  ✗ ' + b)); }
  console.log(`\nИтог: ${ok.length} ок, ${bad.length} провалено`);
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('Ошибка теста:', e); process.exit(1); });
