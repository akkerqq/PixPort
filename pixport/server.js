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
<script>(function(){try{var t=localStorage.getItem('pixport-theme');if(t)document.documentElement.dataset.theme=t;}catch(e){}})();</script>
<style>
  :root {
    color-scheme:light;
    --bg:#f2f4fb; --card:#ffffff; --ink:#181b2e; --muted:#6d7394;
    --line:#e3e7f4; --brand:#3d52f0; --brand-ink:#fff; --soft:#edf0ff;
    --ok:#1d9e57; --err:#cf3a3a; --shadow:0 10px 30px rgba(35,45,110,.10);
  }
  [data-theme="dark"] {
    color-scheme:dark;
    --bg:#0b1026; --card:#101637; --ink:#eef1ff; --muted:#8b93c7;
    --line:#232c60; --brand:#3d52f0; --brand-ink:#fff; --soft:#1b2350;
    --ok:#9fe6b4; --err:#ff9c9c; --shadow:0 12px 40px rgba(0,0,0,.45);
  }
  * { margin:0; padding:0; box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  body {
    min-height:100dvh; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    background:var(--bg); color:var(--ink);
    display:flex; flex-direction:column; align-items:center;
    padding:calc(env(safe-area-inset-top) + 20px) 20px calc(env(safe-area-inset-bottom) + 24px);
  }
  .top { width:100%; max-width:420px; display:flex; align-items:center; justify-content:space-between; }
  .logo { font-size:13px; letter-spacing:4px; text-transform:uppercase; color:var(--brand); font-weight:800; }
  #themeBtn {
    width:38px; height:38px; aspect-ratio:1/1; padding:0; flex:0 0 auto;
    border-radius:50%; border:1px solid var(--line); overflow:hidden;
    background:var(--card); font-size:17px; cursor:pointer;
    display:inline-flex; align-items:center; justify-content:center; line-height:1;
    box-shadow:var(--shadow);
  }
  .card {
    margin-top:16px; width:100%; max-width:420px; background:var(--card);
    border:1px solid var(--line); border-radius:22px; padding:22px 20px;
    box-shadow:var(--shadow); text-align:center;
  }
  .folder {
    margin-top:12px; font-size:19px; font-weight:800;
    background:var(--soft); border:1px solid var(--line);
    padding:12px 16px; border-radius:14px;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  }
  .hint { margin-top:10px; font-size:13px; color:var(--muted); }
  .btns { margin-top:20px; width:100%; display:flex; flex-direction:column; gap:12px; }
  label.btn {
    display:flex; align-items:center; justify-content:center; gap:10px;
    background:var(--brand); color:var(--brand-ink); font-size:18px; font-weight:700;
    padding:18px; border-radius:16px; cursor:pointer; transition:transform .08s, filter .15s;
    border:0;
  }
  label.btn:active { transform:scale(.97); }
  label.btn.alt { background:var(--soft); color:var(--ink); border:1px solid var(--line); }
  label.btn input { display:none; }
  #status {
    margin-top:16px; width:100%; background:var(--card); border:1px solid var(--line);
    border-radius:14px; padding:14px 16px; font-size:15px; color:var(--ok); text-align:center;
    display:none; box-shadow:var(--shadow);
  }
  #status.err { color:var(--err); }
  #status.show { display:block; }
  .count { font-size:34px; font-weight:800; }
  .foot { margin-top:18px; font-size:12px; color:var(--muted); }
</style>
</head>
<body>
  <div class="top">
    <div class="logo">PixPort</div>
    <button id="themeBtn" onclick="toggleTheme()" title="Тёмная / светлая тема">🌙</button>
  </div>
  <div class="card">
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
  </div>
  <div class="foot">PixPort · без проводов и мессенджеров</div>

<script>
function syncThemeBtn() {
  const dark = document.documentElement.dataset.theme === 'dark';
  document.getElementById('themeBtn').textContent = dark ? '☀️' : '🌙';
}
function toggleTheme() {
  const dark = document.documentElement.dataset.theme !== 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  try { localStorage.setItem('pixport-theme', dark ? 'dark' : 'light'); } catch (e) {}
  syncThemeBtn();
}
syncThemeBtn();
</script>
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
<script>(function(){try{var t=localStorage.getItem('pixport-theme');if(t)document.documentElement.dataset.theme=t;}catch(e){}})();</script>
<style>
  :root {
    color-scheme:light;
    --bg:#f2f4fb; --card:#ffffff; --ink:#181b2e; --muted:#6d7394;
    --line:#e3e7f4; --brand:#3d52f0; --brand-ink:#fff; --soft:#edf0ff;
    --ok:#1d9e57; --err:#cf3a3a; --shadow:0 10px 30px rgba(35,45,110,.10);
    --qr-glow:0 12px 50px rgba(61,82,240,.25);
  }
  [data-theme="dark"] {
    color-scheme:dark;
    --bg:#0b1026; --card:#101637; --ink:#eef1ff; --muted:#8b93c7;
    --line:#232c60; --brand:#3d52f0; --brand-ink:#fff; --soft:#1b2350;
    --ok:#9fe6b4; --err:#ff9c9c; --shadow:0 12px 40px rgba(0,0,0,.45);
    --qr-glow:0 12px 50px rgba(60,80,255,.35);
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    min-height:100vh; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    background:var(--bg); color:var(--ink);
    display:flex; flex-direction:column; align-items:center; justify-content:center; gap:14px;
    padding:24px;
  }
  .top { width:100%; max-width:420px; display:flex; align-items:center; justify-content:space-between; }
  .logo { font-size:12px; letter-spacing:4px; text-transform:uppercase; color:var(--brand); font-weight:800; }
  #themeBtn {
    width:36px; height:36px; aspect-ratio:1/1; padding:0; flex:0 0 auto;
    border-radius:50%; border:1px solid var(--line); overflow:hidden;
    background:var(--card); font-size:16px; cursor:pointer;
    display:inline-flex; align-items:center; justify-content:center; line-height:1;
    box-shadow:var(--shadow);
  }
  .card {
    background:var(--card); border:1px solid var(--line); border-radius:24px;
    padding:26px 26px 22px; display:flex; flex-direction:column; align-items:center; gap:13px;
    box-shadow:var(--shadow); max-width:420px; width:100%;
  }
  .folder { font-size:16px; font-weight:700; color:var(--ink); max-width:100%;
            overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #qr { background:#fff; padding:16px; border-radius:20px; box-shadow:var(--qr-glow); }
  #qr img { display:block; width:280px; height:280px; }
  .status { font-size:14px; color:var(--muted); min-height:20px; text-align:center; }
  .status b { color:var(--ok); }
  .actions { display:flex; gap:8px; margin-top:4px; flex-wrap:wrap; justify-content:center; }
  .actions button {
    font-size:13.5px; font-weight:600; padding:9px 15px; border-radius:12px; cursor:pointer;
    border:1px solid var(--line); background:var(--soft); color:var(--ink);
    transition:transform .08s, filter .15s;
  }
  .actions button:hover { filter:brightness(.97); }
  .actions button:active { transform:scale(.96); }
  .actions button:disabled { opacity:.6; cursor:default; }
  .hint { font-size:12px; color:var(--muted); text-align:center; }
</style>
</head>
<body>
  <div class="top">
    <div class="logo">PixPort</div>
    <button id="themeBtn" onclick="toggleTheme()" title="Тёмная / светлая тема">🌙</button>
  </div>
  <div class="card">
  <div class="folder">📷 ${escapeHtml(folder)}</div>
  <div id="qr"><img id="qrimg" alt="QR"></div>
  <div class="status" id="status">Ожидание телефона…</div>
  <div class="actions">
    <button onclick="newQr()">Новый QR</button>
    <button onclick="closeQr()">Закрыть</button>
    <button onclick="openFolder()">Открыть папку</button>
    <button id="pickBtn" style="display:none" onclick="pickFolder()">Сменить папку</button>
    <button id="menuBtn" style="display:none" onclick="toggleMenu()">В меню проводника</button>
  </div>
  <div class="hint">Сканируй камерой телефона · код живёт 30 минут</div>
  <div class="hint" id="dropHint" style="display:none">…или перетащи папку сюда</div>
  </div>

<script>
function syncThemeBtn() {
  const dark = document.documentElement.dataset.theme === 'dark';
  const b = document.getElementById('themeBtn');
  if (b) b.textContent = dark ? '☀️' : '🌙';
}
function toggleTheme() {
  const dark = document.documentElement.dataset.theme !== 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  try { localStorage.setItem('pixport-theme', dark ? 'dark' : 'light'); } catch (e) {}
  syncThemeBtn();
}
syncThemeBtn();
</script>
<script>
const token = '${token}';
let dead = false;
const desktop = !!window.pixport;

if (desktop) {
  document.getElementById('pickBtn').style.display = '';
  document.getElementById('dropHint').style.display = '';
  document.getElementById('menuBtn').style.display = '';
  refreshMenuBtn();
}

// --- пункт в контекстном меню проводника ---
async function refreshMenuBtn() {
  const b = document.getElementById('menuBtn');
  const on = await window.pixport.menuStatus();
  b.textContent = on ? 'Убрать из меню' : 'В меню проводника';
  b.style.borderColor = on ? '#1d9e57' : '';
}

async function toggleMenu() {
  const b = document.getElementById('menuBtn');
  const removing = b.textContent.includes('Убрать'); // запоминаем ДО смены текста
  b.disabled = true;
  b.textContent = 'Секунду…';
  try {
    const r = await (removing ? window.pixport.menuRemove() : window.pixport.menuInstall());
    const st = document.getElementById('status');
    if (r && r.ok) {
      st.className = 'status';
      st.innerHTML = removing
        ? 'Пункт убран из контекстного меню'
        : '✓ Готово: правый клик по папке → <b>Показать QR</b>';
    } else {
      st.className = 'status';
      st.style.color = 'var(--err)';
      st.textContent = 'Не получилось: ' + ((r && r.error) || 'неизвестно');
      setTimeout(() => { st.style.color = ''; }, 4000);
    }
  } catch (e) {
    document.getElementById('status').textContent = 'Ошибка: ' + e.message;
  }
  b.disabled = false;
  await refreshMenuBtn();
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
        return res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><script>(function(){try{var t=localStorage.getItem('pixport-theme');if(t)document.documentElement.dataset.theme=t;}catch(e){}})();</script><style>
:root{color-scheme:light;--bg:#f2f4fb;--card:#fff;--ink:#181b2e;--muted:#6d7394;--line:#e3e7f4;--brand:#3d52f0;--brand-ink:#fff;--soft:#edf0ff;--ok:#1d9e57;--err:#cf3a3a;--shadow:0 10px 30px rgba(35,45,110,.10)}
[data-theme="dark"]{color-scheme:dark;--bg:#0b1026;--card:#101637;--ink:#eef1ff;--muted:#8b93c7;--line:#232c60;--brand:#3d52f0;--brand-ink:#fff;--soft:#1b2350;--ok:#9fe6b4;--err:#ff9c9c;--shadow:0 12px 40px rgba(0,0,0,.45)}
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%}
body{margin:0;font-family:system-ui;background:var(--bg);color:var(--ink);min-height:100vh;
display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:30px;text-align:center;overflow:hidden}
.top{width:100%;max-width:380px;display:flex;align-items:center;justify-content:space-between}
.logo{font-size:12px;letter-spacing:4px;text-transform:uppercase;color:var(--brand);font-weight:800}
#themeBtn{width:36px;height:36px;aspect-ratio:1/1;padding:0;flex:0 0 auto;border-radius:50%;border:1px solid var(--line);overflow:hidden;background:var(--card);font-size:16px;cursor:pointer;box-shadow:var(--shadow);display:inline-flex;align-items:center;justify-content:center;line-height:1}
.card{background:var(--card);border:1px solid var(--line);border-radius:24px;padding:30px 28px;display:flex;flex-direction:column;align-items:center;gap:14px;box-shadow:var(--shadow);max-width:380px}
h2{font-size:20px;margin:0}p{color:var(--muted);font-size:14px;margin:0;max-width:340px;line-height:1.5}
button{font-size:16px;font-weight:700;padding:14px 26px;border-radius:14px;border:0;
background:var(--brand);color:var(--brand-ink);cursor:pointer}button:active{transform:scale(.97)}
</style></head><body>
<div class="top"><div class="logo">PixPort</div><button id="themeBtn" title="Тёмная / светлая тема">🌙</button></div>
<div class="card">
<h2>Выбери папку для фото</h2>
<p>Нажми кнопку ниже или перетащи папку в это окно.<br>Потом наведи камеру телефона на QR-код.</p>
<button id="b">📁 Выбрать папку</button>
<button id="mb" style="display:none;background:var(--soft);color:var(--ink);border:1px solid var(--line);font-size:14px;padding:10px 20px">В меню проводника</button>
<div id="ms" style="color:var(--ok);font-size:13px;min-height:18px"></div>
</div>
<script>
(function(){function s(){var d=document.documentElement.dataset.theme==='dark';document.getElementById('themeBtn').textContent=d?'☀️':'🌙';}
document.getElementById('themeBtn').onclick=function(){var d=document.documentElement.dataset.theme!=='dark';document.documentElement.dataset.theme=d?'dark':'light';try{localStorage.setItem('pixport-theme',d?'dark':'light');}catch(e){}s();};s();})();
</script>
<script>
if (window.pixport) {
  document.getElementById('b').onclick = async () => {
    const p = await window.pixport.pickFolder();
    if (p) location.href = '/?folder=' + encodeURIComponent(p);
  };

  // пункт контекстного меню
  const mb = document.getElementById('mb'), ms = document.getElementById('ms');
  mb.style.display = '';
  async function sync() {
    const on = await window.pixport.menuStatus();
    mb.textContent = on ? 'Убрать из меню проводника' : 'В меню проводника';
  }
  mb.onclick = async () => {
    const removing = mb.textContent.includes('Убрать'); // запоминаем ДО смены текста
    mb.disabled = true; mb.textContent = 'Секунду…';
    const r = removing ? await window.pixport.menuRemove() : await window.pixport.menuInstall();
    ms.textContent = r && r.ok
      ? (removing ? 'Пункт убран' : '✓ Готово: правый клик по любой папке → Показать QR')
      : 'Не получилось: ' + ((r && r.error) || 'неизвестно');
    ms.style.color = r && r.ok ? 'var(--ok)' : 'var(--err)';
    mb.disabled = false; sync();
  };
  sync();

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
