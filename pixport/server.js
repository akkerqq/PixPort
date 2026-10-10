/**
 * PixPort — фото с телефона сразу в нужную папку на ПК.
 *
 * Как работает:
 *  1. node server.js "C:\папка"  → запускается сервер (или используется уже
 *     запущенный), генерируется одноразовый токен, открывается окно с QR.
 *  2. Скан QR телефоном → страница загрузки (камера или галерея).
 *  3. Фото конвертируется в JPG и сразу кладётся в целевую папку.
 *
 * Токен живёт, пока открыто окно QR (закрыл окно — код мёртв) и не дольше 30 минут.
 * Порт: 8765. Управление только с localhost, приём загрузок — вся локальная сеть.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const crypto = require('crypto');

const QRCode = require('qrcode');
const sharp = require('sharp');
const Busboy = require('busboy');

const PORT = 8765;
const HOST = '0.0.0.0';
const TOKEN_TTL = 30 * 60 * 1000; // 30 минут — жёсткий предел жизни QR

/** Активные сессии: token -> { folder, created, received, closed } */
const sessions = new Map();

/* ---------------------------------------------------------------- утилиты */

/** Локальный IP, по которому телефон достучится до ПК. */
function lanIp() {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const it of ifs[name] || []) {
      if (it.family === 'IPv4' && !it.internal) return it.address;
    }
  }
  return '127.0.0.1';
}

function isLoopback(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

/** Открыть URL в браузере по умолчанию (Windows). */
function openInBrowser(url) {
  spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' })
    .unref();
}

/** Надёжное имя файла в папке: 2026-10-10_15-30-12.jpg, без коллизий. */
function uniqueName(folder, ext) {
  const ts = new Date().toISOString().replace('T', '_').replace(/:/g, '-').slice(0, 19);
  let base = ts;
  let i = 1;
  while (fs.existsSync(path.join(folder, base + ext))) base = `${ts} (${i++})`;
  return base + ext;
}

/** Создать одноразовую сессию для папки. */
function createSession(folder) {
  const token = crypto.randomBytes(12).toString('base64url');
  sessions.set(token, { folder, created: Date.now(), received: 0, files: [] });
  console.log(`\n[QR] Папка: ${folder}`);
  console.log(`[QR] Ссылка живёт 30 минут или до закрытия окна QR.\n`);
  return token;
}

/** Уборка протухших сессий. */
setInterval(() => {
  for (const [t, s] of sessions) {
    if (Date.now() - s.created > TOKEN_TTL) sessions.delete(t);
  }
}, 60 * 1000).unref();

/* ------------------------------------------------------- страницы (HTML) */

function uploadPage(token, folderName) {
  const title = escapeHtml(folderName);
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>PixPort — ${title}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  body {
    min-height:100dvh; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    background:linear-gradient(160deg,#0b1026 0%,#131a3d 100%); color:#eef1ff;
    display:flex; flex-direction:column; align-items:center;
    padding:calc(env(safe-area-inset-top) + 24px) 20px calc(env(safe-area-inset-bottom) + 24px);
  }
  .logo { font-size:13px; letter-spacing:4px; text-transform:uppercase; color:#7f8cff; font-weight:700; }
  .folder {
    margin-top:14px; font-size:20px; font-weight:800; text-align:center;
    background:#1b2350; border:1px solid #2e3a7d; padding:10px 18px; border-radius:14px;
    max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  }
  .hint { margin-top:10px; font-size:13px; color:#8b93c7; text-align:center; }
  .btns { margin-top:28px; width:100%; max-width:420px; display:flex; flex-direction:column; gap:12px; }
  label.btn {
    display:flex; align-items:center; justify-content:center; gap:10px;
    background:#3d52f0; color:#fff; font-size:18px; font-weight:700;
    padding:18px; border-radius:16px; cursor:pointer; transition:transform .08s;
  }
  label.btn:active { transform:scale(.97); }
  label.btn.alt { background:#232c60; border:1px solid #37429a; }
  label.btn input { display:none; }
  #status {
    margin-top:22px; min-height:56px; width:100%; max-width:420px;
    background:#101637; border:1px solid #232c60; border-radius:14px;
    padding:14px 16px; font-size:15px; color:#9fe6b4; text-align:center;
    display:none;
  }
  #status.err { color:#ff9c9c; }
  #status.show { display:block; }
  .count { font-size:34px; font-weight:800; }
  .dir { font-size:12px; color:#7f88bd; margin-top:6px; word-break:break-all; }
</style>
</head>
<body>
  <div class="logo">PixPort</div>
  <div class="folder">📁 ${title}</div>
  <div class="hint">Фото сразу попадут в папку на компьютере</div>

  <div class="btns">
    <label class="btn">
      📷 Снять фото
      <input type="file" accept="image/*" capture="environment" multiple onchange="send(this.files)">
    </label>
    <label class="btn alt">
      🖼 Выбрать из галереи
      <input type="file" accept="image/*" multiple onchange="send(this.files)">
    </label>
  </div>

  <div id="status"></div>

<script>
let sending = false;
let total = 0;

async function send(files) {
  if (!files || !files.length || sending) return;
  sending = true;
  const st = document.getElementById('status');
  st.className = 'show';
  for (const f of files) {
    st.textContent = 'Отправляю ' + f.name + '…';
    try {
      const fd = new FormData();
      fd.append('file', f, f.name);
      const r = await fetch('/u?t=${token}', { method: 'POST', body: fd });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      total++;
      st.className = 'show';
      st.innerHTML = '<div class="count">✓ ' + total + '</div>отправлено в папку' +
        (total > 1 ? ' — фото' : 'е') ;
    } catch (e) {
      st.className = 'show err';
      st.textContent = 'Ошибка: ' + e.message + '. Попробуй ещё раз.';
      sending = false;
      return;
    }
  }
  sending = false;
}
// не даём экрану заснуть во время загрузки
if ('wakeLock' in navigator) navigator.wakeLock.request('screen').catch(()=>{});
</script>
</body>
</html>`;
}

function qrPage(token, folder) {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<title>PixPort — QR</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    min-height:100vh; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    background:#0b1026; color:#eef1ff;
    display:flex; flex-direction:column; align-items:center; justify-content:center; gap:14px;
    padding:24px;
  }
  .logo { font-size:12px; letter-spacing:4px; text-transform:uppercase; color:#7f8cff; font-weight:700; }
  .folder { font-size:17px; font-weight:700; color:#c8cfff; max-width:90vw;
            overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #qr { background:#fff; padding:16px; border-radius:20px; box-shadow:0 12px 50px rgba(60,80,255,.35); }
  #qr img { display:block; width:280px; height:280px; }
  .status { font-size:14px; color:#8b93c7; min-height:20px; text-align:center; }
  .status b { color:#9fe6b4; }
  .actions { display:flex; gap:10px; margin-top:6px; }
  .actions button {
    font-size:14px; padding:9px 16px; border-radius:12px; cursor:pointer;
    border:1px solid #37429a; background:#1b2350; color:#c8cfff;
  }
  .actions button:hover { background:#232c60; }
  .hint { font-size:12px; color:#5c6499; }
</style>
</head>
<body>
  <div class="logo">PixPort</div>
  <div class="folder">📷 ${escapeHtml(folder)}</div>
  <div id="qr"><img id="qrimg" alt="QR"></div>
  <div class="status" id="status">Ожидание телефона…</div>
  <div class="actions">
    <button onclick="newQr()">Новый QR</button>
    <button onclick="closeQr()">Закрыть</button>
    <button onclick="openFolder()">Открыть папку</button>
    <button id="pickBtn" style="display:none" onclick="pickFolder()">Сменить папку</button>
  </div>
  <div class="hint">Сканируй камерой телефона · код живёт 30 минут</div>
  <div class="hint" id="dropHint" style="display:none">…или перетащи папку сюда</div>

<script>
const token = '${token}';
let dead = false;
const desktop = !!window.pixport;

if (desktop) {
  document.getElementById('pickBtn').style.display = '';
  document.getElementById('dropHint').style.display = '';
}

async function refresh() {
  if (dead) return;
  try {
    const r = await fetch('/api/status?t=' + token);
    if (r.status === 404) { die('QR закрыт'); return; }
    const s = await r.json();
    const st = document.getElementById('status');
    if (s.received > 0) st.innerHTML = 'Принято фото: <b>' + s.received + '</b>';
  } catch (e) { /* сервер жив, просто мигнули */ }
}
setInterval(refresh, 1200);

function die(msg) { dead = true; document.getElementById('status').textContent = msg; }

function newQr() { location.href = '/api/new?t=' + token; }
function closeQr() {
  navigator.sendBeacon('/api/close?t=' + token);
  if (desktop) setTimeout(() => window.close(), 250);
  else die('QR закрыт — можно закрывать вкладку');
}
function openFolder() {
  if (desktop) window.pixport.openPath(location.search.split('folder=')[1] ? decodeURIComponent(location.search.split('folder=')[1]) : '');
  else fetch('/api/open?t=' + token);
}
async function pickFolder() {
  const p = await window.pixport.pickFolder();
  if (p) location.href = '/?folder=' + encodeURIComponent(p);
}

// перетаскивание папки в окно
if (desktop) {
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (!f) return;
    const p = window.pixport.pathForFile(f);
    if (p) window.pixport.dropPath(p);
  });
}

// закрыли вкладку — токен умер
window.addEventListener('pagehide', () => navigator.sendBeacon('/api/close?t=' + token));

// QR-картинка
fetch('/api/qr?t=' + token)
  .then(r => r.ok ? r.json() : Promise.reject(r.status))
  .then(u => {
    document.getElementById('qrimg').src = u;
    refresh();
  })
  .catch(e => { document.getElementById('status').textContent = 'Не удалось получить QR: ' + e; });
</script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ------------------------------------------------------------ обработка */

function readBody(req, limit = 60 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('Файл больше 60 МБ')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(b);
}

async function handleUpload(req, res, token) {
  const s = sessions.get(token);
  if (!s) return json(res, 404, { ok: false, error: 'QR устарел' });
  if (Date.now() - s.created > TOKEN_TTL) { sessions.delete(token); return json(res, 404, { ok: false, error: 'QR устарел' }); }

  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('multipart/form-data')) return json(res, 400, { ok: false, error: 'Нет файла' });

  const bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: 60 * 1024 * 1024 } });
  let saved = null;
  let failed = null;
  let pending = Promise.resolve(); // ждём завершения записи файла

  bb.on('file', (name, stream, info) => {
    const chunks = [];
    stream.on('data', c => chunks.push(c));
    stream.on('limit', () => { failed = 'Файл больше 60 МБ'; });
    pending = new Promise(resolve => stream.on('end', async () => {
      if (failed) return resolve();
      const buf = Buffer.concat(chunks);
      const orig = info.filename || 'photo.jpg';
      try {
        // Всегда JPG: поворачиваем по EXIF (rotate без аргументов) и кодируем.
        const jpg = await sharp(buf).rotate().jpeg({ quality: 92, mozjpeg: true }).toBuffer();
        const fname = uniqueName(s.folder, '.jpg');
        fs.writeFileSync(path.join(s.folder, fname), jpg);
        saved = fname;
        s.received++;
        s.files.push(fname);
        console.log(`[OK] ${path.join(s.folder, fname)}`);
      } catch (e) {
        // Не удалось декодировать (редкий формат) — кладём как пришло.
        try {
          const ext = path.extname(orig).toLowerCase() || '.bin';
          const fname = uniqueName(s.folder, ext);
          fs.writeFileSync(path.join(s.folder, fname), buf);
          saved = fname;
          s.received++;
          s.files.push(fname);
          console.log(`[OK, оригинал] ${fname} (${e.message})`);
        } catch (e2) {
          failed = e2.message;
        }
      }
      resolve();
    }));
  });

  bb.on('error', () => { failed = 'Ошибка чтения'; });
  bb.on('close', async () => {
    await pending; // боди прочитано — ждём, пока файл доедет до папки
    if (failed) json(res, 500, { ok: false, error: failed });
    else if (saved) json(res, 200, { ok: true, file: saved, total: s.received });
    else json(res, 400, { ok: false, error: 'Файл не получен' });
  });

  req.pipe(bb);
}

/** Проверить папку и вернуть абсолютный путь. */
function resolveFolder(p) {
  if (!p) return null;
  const abs = path.resolve(p);
  try { if (fs.statSync(abs).isDirectory()) return abs; } catch (e) {}
  return null;
}

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://x');
  const q = url.searchParams.get('t') || '';
  const s = q ? sessions.get(q) : null;

  /* --- только с localhost: управление --- */
  if (isLoopback(req)) {
    if (url.pathname === '/api/new' && req.method === 'GET') {
      // перегенерация QR: токен старый убиваем, папку сохраняем
      const folder = s ? s.folder : null;
      if (s) sessions.delete(q);
      const loc = folder ? `/?folder=${encodeURIComponent(folder)}` : '/';
      return res.writeHead(302, { Location: loc }).end();
    }
    if (url.pathname === '/api/status') {
      if (!s) return json(res, 404, { ok: false });
      return json(res, 200, { ok: true, received: s.received, folder: s.folder });
    }
    if (url.pathname === '/api/close') {
      if (s) sessions.delete(q);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/qr') {
      if (!s) return json(res, 404, { ok: false });
      const link = `http://${lanIp()}:${PORT}/u?t=${q}`;
      const data = await QRCode.toDataURL(link, { width: 560, margin: 1, errorCorrectionLevel: 'M' });
      return json(res, 200, data);
    }
    if (url.pathname === '/api/open') {
      if (s) openInBrowser(s.folder);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/') {
      // окно QR: принимает папку через query, иначе последняя сессия
      const folder = resolveFolder(url.searchParams.get('folder')) ||
                     (s ? s.folder : [...sessions.values()].at(-1)?.folder);
      if (!folder) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:system-ui;background:#0b1026;color:#eef1ff;min-height:100vh;
display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:30px;text-align:center}
.logo{font-size:12px;letter-spacing:4px;text-transform:uppercase;color:#7f8cff;font-weight:700}
h2{font-size:20px;margin:0}p{color:#8b93c7;font-size:14px;margin:0;max-width:340px;line-height:1.5}
button{font-size:16px;font-weight:700;padding:14px 26px;border-radius:14px;border:0;
background:#3d52f0;color:#fff;cursor:pointer}button:active{transform:scale(.97)}
</style></head><body>
<div class="logo">PixPort</div>
<h2>Выбери папку для фото</h2>
<p>Нажми кнопку ниже или перетащи папку в это окно.<br>Потом наведи камеру телефона на QR-код.</p>
<button id="b">📁 Выбрать папку</button>
<script>
if (window.pixport) {
  document.getElementById('b').onclick = async () => {
    const p = await window.pixport.pickFolder();
    if (p) location.href = '/?folder=' + encodeURIComponent(p);
  };
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', async e => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (!f) return;
    const p = window.pixport.pathForFile(f);
    if (p) window.pixport.dropPath(p);
  });
} else {
  document.getElementById('b').style.display = 'none';
  document.querySelector('p').innerHTML = 'Запусти PixPort с папкой:<br><code>node server.js "C:\\\\папка"</code>';
}
</script></body></html>`);
      }
      const token = createSession(folder);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(qrPage(token, folder));
    }
  }

  /* --- для телефона --- */
  if (url.pathname === '/u') {
    if (!s) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<p style="font-family:sans-serif;padding:40px">Ссылка устарела. Покажи QR на компьютере ещё раз.</p>');
    }
    if (req.method === 'POST') return handleUpload(req, res, q);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(uploadPage(q, path.basename(s.folder)));
  }

  json(res, 404, { ok: false });
}

/* ------------------------------------------------------------------ старт */

async function start({ openBrowser = true } = {}) {
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch(e => {
      console.error(e);
      try { json(res, 500, { ok: false, error: e.message }); } catch (_) {}
    });
  });

  return new Promise(resolve => {
    server.on('error', e => {
      if (e.code === 'EADDRINUSE') {
        // сервер уже работает — просто открой окно QR у существующего
        if (openBrowser) {
          const folder = resolveFolder(process.argv[2]);
          const target = folder
            ? `http://127.0.0.1:${PORT}/?folder=${encodeURIComponent(folder)}`
            : `http://127.0.0.1:${PORT}/`;
          console.log('PixPort уже запущен — открываю окно QR.');
          openInBrowser(target);
        }
        resolve('already-running');
        return;
      }
      console.error('Ошибка:', e.message);
      process.exit(1);
    });

    server.listen(PORT, HOST, () => {
      console.log('PixPort запущен.');
      console.log(`IP для телефона: http://${lanIp()}:${PORT}`);

      const folder = resolveFolder(process.argv[2]);
      if (openBrowser && folder) {
        openInBrowser(`http://127.0.0.1:${PORT}/?folder=${encodeURIComponent(folder)}`);
      } else if (openBrowser && sessions.size === 0) {
        openInBrowser(`http://127.0.0.1:${PORT}/`);
      }
      resolve('started');
    });
  });
}

// запуск из консоли: node server.js "C:\папка"
if (require.main === module) start({ openBrowser: true });

module.exports = { start, lanIp, PORT, resolveFolder };
