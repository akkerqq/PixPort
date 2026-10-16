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
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const crypto = require('crypto');

const QRCode = require('qrcode');
const sharp = require('sharp');
const Busboy = require('busboy');
const { licenseState, activateKey, clearLicense, isPro, machineId } = require('./license');

const PORT = 8765;
const HOST = '0.0.0.0';
const APP_VERSION = '1.2.0'; // видна в окне — по ней проверяем, та ли сборка
// GitHub-репозиторий релизов: проверка обновлений тянет
// https://api.github.com/repos/<repo>/releases/latest (тег vX.Y.Z + Setup-*.exe).
const UPDATE_REPO = 'akkerqq/PixPort';
// Оплата Pro: ссылку даст Platega/ЮKassa при подключении. Пока пусто —
// кнопка «Купить» честно говорит «скоро», ключ уже вводится в настройках.
const PRO_PAY_URL = '';
const TOKEN_TTL = 30 * 60 * 1000; // 30 минут — жёсткий предел жизни QR

/** Активные сессии: token -> { folder, created, received, closed } */
const sessions = new Map();

/* ---------------------------------------------------------------- утилиты */

/** Локальный IP, по которому телефон достучится до ПК.
 *
 * Ловушка: в Windows есть виртуальные адаптеры («Мобильная точка доступа»,
 * Wi-Fi Direct) — они висят с заглушечным адресом 169.254.x.x (DHCP не ответил).
 * Если брать первый попавшийся IPv4 — QR ведёт на мёртвый адрес, и телефон
 * просто таймаутит. Так и было у друга Аккера. Отфильтровываем:
 *  1. всё 169.254.* (APIPA) — не считаем;
 *  2. предпочитаем приватные диапазоны реальных сетей (192.168.*, 10.*);
 *  3. иначе — первый незаглушечный.
 */
function lanIp() {
  const all = lanIps();
  return all[0] || '127.0.0.1';
}

/**
 * Все живые IPv4-адреса машины (без internal и APIPA-заглушек).
 * Приоритет: сначала 192.168.* и 10.* (домашние сети и VPN-туннели реже),
 * потом остальные (172.16.* и т.п.). Нужен для выбора адреса в окне QR:
 * угадайка одного IP ломалась на нескольких адаптерах (кейс друга Аккера).
 */
function lanIps() {
  const ifs = os.networkInterfaces();
  const main = [];
  const rest = [];
  for (const name of Object.keys(ifs)) {
    for (const it of ifs[name] || []) {
      if (it.family !== 'IPv4' || it.internal) continue;
      const a = it.address;
      if (a.startsWith('169.254.')) continue; // заглушка — телефон туда не достучится
      if (main.includes(a) || rest.includes(a)) continue;
      if (a.startsWith('192.168.') || a.startsWith('10.')) main.push(a);
      else rest.push(a);
    }
  }
  return [...main, ...rest];
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

/**
 * Переместить файл в папку. rename — мгновенно, но не умеет между дисками
 * (TEMP на C:, а папка на D: — EXDEV). Тогда копируем и удаляем исходник.
 */
function moveFile(tmp, dest) {
  try {
    fs.renameSync(tmp, dest);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.copyFileSync(tmp, dest);
    fs.rmSync(tmp, { force: true });
  }
}

/** Создать одноразовую сессию для папки. */
function createSession(folder) {
  const token = crypto.randomBytes(12).toString('base64url');
  sessions.set(token, { folder, created: Date.now(), received: 0, files: [], msgs: [], share: [], shareSeq: 1 });
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

function uploadPage(token, folderName, lang) {
  const title = escapeHtml(folderName);
  const initLang = lang === 'en' ? 'en' : 'ru';
  const plan = isPro() ? 'planPro' : 'planFree'; // статус рендерим сразу — телефон не ходит в /api/license (localhost)
  const maxBytes = isPro() ? 10 * 1024 * 1024 * 1024 : 60 * 1024 * 1024; // предпроверка размера до заливки
  const limStr = isPro()
    ? (initLang === 'en' ? '10 GB' : '10 ГБ')
    : (initLang === 'en' ? '60 MB' : '60 МБ');
  return `<!DOCTYPE html>
<html lang="${initLang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>PixPort — ${title}</title>
<script>(function(){try{var t=localStorage.getItem('pixport-theme');if(t)document.documentElement.dataset.theme=t;}catch(e){}})();</script>
<script>window.__INIT_LANG='${initLang}';</script>
<style>
  :root {
    color-scheme:light;
    --bg:#f2f4fb; --card:#ffffff; --ink:#181b2e; --muted:#6d7394;
    --line:#e3e7f4; --brand:#3d52f0; --brand-ink:#fff; --soft:#edf0ff;
    --ok:#1d9e57; --err:#cf3a3a; --shadow:0 10px 30px rgba(35,45,110,.10);
  }
  [data-theme="dark"] {
    color-scheme:dark;
    --bg:#0d0d0f; --card:#161619; --ink:#f0f0f2; --muted:#8e8e96;
    --line:#2a2a2e; --brand:#4d5ff0; --brand-ink:#fff; --soft:#1f1f24;
    --ok:#6ee7a0; --err:#ff8f8f; --shadow:0 12px 40px rgba(0,0,0,.6);
  }
  * { margin:0; padding:0; box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  *, *::before, *::after { transition:background-color .3s ease, color .3s ease, border-color .3s ease, box-shadow .3s ease; }
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
  label.btn.file { background:transparent; color:var(--brand); border:2px dashed var(--brand); font-size:16px; padding:15px; }
  label.btn input { display:none; }
  .overlay {
    display:none; position:fixed; inset:0; background:rgba(15,18,40,.5);
    align-items:flex-end; justify-content:center; padding:0; z-index:10;
  }
  .overlay.open { display:flex; }
  .sheet {
    background:var(--card); color:var(--ink); border:1px solid var(--line);
    border-radius:20px 20px 0 0; box-shadow:var(--shadow); max-width:480px; width:100%;
    padding:16px 14px calc(env(safe-area-inset-bottom) + 12px); text-align:left;
    display:flex; flex-direction:column; height:min(82dvh,620px);
  }
  .sheet h3 { font-size:17px; margin:0; }
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
    <div style="display:flex;gap:8px">
      <button id="langBtn" onclick="toggleLang()" title="RU / EN" style="height:38px;min-width:52px;padding:0 12px;border-radius:19px;border:1px solid var(--line);background:var(--card);color:var(--ink);font-size:13px;font-weight:800;cursor:pointer;box-shadow:var(--shadow)">RU</button>
      <button id="themeBtn" onclick="toggleTheme()" title="Тёмная / светлая тема">🌙</button>
    </div>
  </div>
  <div class="card">
  <div class="folder">📁 ${title}</div>
  <div class="hint" data-i="upHint">Фото сразу попадут в папку на компьютере</div>
  <div id="planBadge" data-i="${plan}" style="font-size:12px;font-weight:700;padding:5px 12px;border-radius:999px;background:var(--soft);color:var(--muted);border:1px solid var(--line)">${plan === 'planPro' ? 'Pro · оригинал' : 'Бесплатно · 960px'}</div>

  <div class="btns">
    <label class="btn">
      <span data-i="btn_shoot">📷 Снять фото</span>
      <input type="file" accept="image/*" capture="environment" multiple onchange="sendFiles(this)">
    </label>
    <label class="btn alt">
      <span data-i="btn_gallery">🖼 Выбрать из галереи</span>
      <input type="file" accept="image/*" multiple onchange="sendFiles(this)">
    </label>
    ${isPro() ? `<label class="btn file">
      <span data-i="btn_file">📁 Файл / видео</span>
      <input type="file" multiple onchange="sendFiles(this)">
    </label>
    <div data-i="icloudHint" style="font-size:11px;color:var(--muted);max-width:320px;margin:-4px 0 8px"></div>` : ''}
  </div>

  <div id="status"></div>
  <button id="msgOpenBtn" onclick="openMsgs()" style="width:100%;max-width:420px;margin-top:10px;font-size:15px;font-weight:700;padding:13px;border-radius:14px;border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer;box-shadow:var(--shadow)"><span data-i="btn_chat">💬 Чат</span><span id="msgBadge" style="display:none;color:#fff;background:var(--err);border-radius:999px;font-size:10px;font-weight:800;padding:1px 7px;margin-left:6px;vertical-align:2px"></span></button>
  <div class="overlay" id="msgOverlay" onclick="if(event.target===this)closeMsgs()">
    <div class="sheet">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <h3 data-i="chatTitle">Чат сессии</h3>
        <button onclick="closeMsgs()" title="✕" style="width:32px;height:32px;border-radius:50%;border:1px solid var(--line);background:var(--soft);color:var(--ink);font-size:14px;cursor:pointer;line-height:1">✕</button>
      </div>
      <div id="msgList" style="flex:1;overflow:auto;display:flex;flex-direction:column;gap:8px;margin-bottom:10px"></div>
      <div id="chatEmpty" data-i="chatEmpty" style="font-size:13px;color:var(--muted);line-height:1.55;margin-bottom:10px;text-align:center">Пока тихо — напиши с телефона, упадёт сюда и запиской в папку</div>
      <div style="display:flex;gap:8px;margin-bottom:6px">
        <input id="msgIn" data-i-ph="chatPh" placeholder="Текст или ссылка с телефона…" onkeydown="if(event.key==='Enter')sendMsg()" style="flex:1;min-width:0;font-size:16px;padding:11px 14px;border-radius:999px;border:1px solid var(--line);background:var(--soft);color:var(--ink)">
        <button id="msgBtn" onclick="sendMsg()" data-i="chatSend" style="flex:0 0 auto;font-size:14px;font-weight:700;padding:11px 18px;border-radius:999px;border:0;background:var(--brand);color:var(--brand-ink);cursor:pointer">Отправить</button>
      </div>
      <div data-i="chatNote" style="font-size:11.5px;color:var(--muted);text-align:center">Живёт пока жив QR. Каждое сообщение — ещё и note-*.txt в папке.</div>
    </div>
  </div>
  <div style="width:100%;max-width:420px;margin-top:12px;font-size:14px;font-weight:800;text-align:center" data-i="dlTitle">📥 С компьютера</div>
  <div id="dlList" style="width:100%;max-width:420px;margin-top:6px;display:flex;flex-direction:column;gap:6px"></div>
  <div id="dlEmpty" data-i="dlEmpty" style="width:100%;max-width:420px;margin-top:2px;font-size:12px;color:var(--muted);text-align:center">Пока нечем делиться — кинь файлы в окно на ПК</div>
  <div id="upWrap" style="display:none;width:100%;max-width:320px;background:var(--soft);border:1px solid var(--line);border-radius:999px;overflow:hidden;height:10px"><div id="upBar" style="height:100%;width:0%;background:var(--brand);border-radius:999px"></div></div>
  <div id="upPct" style="display:none;font-size:12px;color:var(--muted)"></div>
  <details id="ulog" style="display:none;width:100%;max-width:420px;margin-top:10px;font-size:11px;color:var(--muted);text-align:left">
    <summary data-i="showLog" style="cursor:pointer">Лог отправки</summary>
    <pre id="ulogPre" style="white-space:pre-wrap;word-break:break-all;background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:8px 10px;margin-top:6px;max-height:150px;overflow:auto"></pre>
    <button id="copyLogBtn" onclick="copyLog()" style="margin-top:6px;font-size:12px;font-weight:700;padding:8px 14px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer">⧉ Скопировать лог</button>
  </details>
  </div>
  <div class="foot" data-i="foot">PixPort · без проводов и мессенджеров</div>

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
<script>${LANG_DICT_JS}</script>
<script>${LANG_JS}</script>
<script>applyLang(__LANG);</script>
<script>
let sending = false;
let total = 0;
// журнал отправки: что, когда и с каким итогом. При ошибке — главный источник диагноза
// (11 сборок гадания показали: без замеров чинить нельзя). Виден в раскрывашке под статусом.
const jlog = [];
function j(msg) {
  try {
    jlog.push(new Date().toISOString().slice(11, 19) + ' ' + msg);
    if (jlog.length > 40) jlog.shift();
    document.getElementById('ulog').style.display = '';
    document.getElementById('ulogPre').textContent = jlog.join('\\n');
  } catch (e) {}
}
function copyLog() {
  try {
    const txt = jlog.join('\\n');
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(() => j('лог скопирован'));
    else { const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); j('лог скопирован'); }
  } catch (e) { j('копирование не вышло: ' + e); }
}
async function pingServer() {
  const t0 = Date.now();
  try {
    const r = await fetch('/u?t=${token}&ping=1', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    j('пинг ' + (Date.now() - t0) + ' мс');
    return true;
  } catch (e) { j('пинг не прошёл: ' + (e.message || e)); return false; }
}
// детерминированный cid: тот же файл после перезагрузки страницы продолжает, а не начинает сначала.
// 32 hex-символа — проходит серверный regex /^[0-9a-f]{16,64}$/.
function makeCid(f) {
  const s = (f.name || '') + '|' + f.size + '|' + (f.lastModified || 0);
  let h1 = 5381, h2 = 52711;
  for (let k = 0; k < s.length; k++) { const c = s.charCodeAt(k); h1 = ((h1 << 5) + h1 + c) >>> 0; h2 = ((h2 << 5) + h2 + c * 31) >>> 0; }
  const x = (v, seed) => { let z = (v ^ seed) >>> 0; z = Math.imul(z ^ (z >>> 15), 2246822519); z = Math.imul(z ^ (z >>> 13), 3266489917); return (z ^ (z >>> 16)) >>> 0; };
  let out = '';
  for (let k = 0; k < 4; k++) out += x(h1 + k * 2654435761, h2 + k * 40503).toString(16).padStart(8, '0');
  return out;
}
// адаптивный размер куска: чистая сеть — крупнее (меньше RTT), душащая — мельче.
// Решение на файл, а не внутри файла: границы кусков фиксированы, докачка не ломается.
let adaptSz = 512 * 1024;
const ADAPT_MIN = 256 * 1024, ADAPT_MAX = 2 * 1024 * 1024;
function adaptOk(retries) { adaptSz = retries === 0 ? Math.min(ADAPT_MAX, adaptSz * 2) : retries > 2 ? Math.max(ADAPT_MIN, adaptSz / 2) : adaptSz; }
// чат сессии: текст/ссылки на ПК без интернета. Живёт пока жив QR, дублируется запиской note-*.txt в папке.
let msgSince = 0, msgBusy = false, msgAll = [];
function escHtmlChat(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function linkify(s) {
  return escHtmlChat(s).replace(/(https?:\\/\\/[^\\s<]+|www\\.[^\\s<]+)/g, function (u) {
    const href = u.indexOf('http') === 0 ? u : 'http://' + u;
    return '<a href="' + href + '" target="_blank" rel="noopener">' + u + '</a>';
  });
}
function msgBubble(m) {
  const mine = m.from === 'phone'; // свои — синие справа, с ПК — серые слева
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;justify-content:' + (mine ? 'flex-end' : 'flex-start');
  const b = document.createElement('div');
  b.style.cssText = 'max-width:85%;border-radius:14px;padding:8px 11px;font-size:13px;line-height:1.45;word-break:break-word;' +
    (mine ? 'background:var(--brand);color:#fff;border-bottom-right-radius:4px'
          : 'background:var(--soft);color:var(--ink);border:1px solid var(--line);border-bottom-left-radius:4px');
  const tx = document.createElement('div');
  tx.innerHTML = linkify(m.text || '');
  if (mine) tx.querySelectorAll('a').forEach(function (a) { a.style.color = '#fff'; });
  const meta = document.createElement('div');
  meta.style.cssText = 'text-align:right;font-size:10px;margin-top:3px;opacity:.75';
  try { meta.textContent = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (e) {}
  b.appendChild(tx); b.appendChild(meta);
  row.appendChild(b);
  return row;
}
let msgDrawn = 0; // сколько уже в DOM: новые дописываем снизу, старые уезжают вверх
function renderMsgs(list, boxId) {
  const box = document.getElementById(boxId);
  if (!box) return;
  const empty = document.getElementById('chatEmpty');
  if (empty) empty.style.display = list.length ? 'none' : '';
  if (list.length < msgDrawn) { box.innerHTML = ''; msgDrawn = 0; } // не бывает, но перестраховка
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  for (; msgDrawn < list.length; msgDrawn++) box.appendChild(msgBubble(list[msgDrawn]));
  if (nearBottom) box.scrollTop = box.scrollHeight;
}
async function sendMsg() {
  const inp = document.getElementById('msgIn');
  const text = (inp.value || '').trim();
  if (!text || msgBusy) return;
  msgBusy = true;
  try {
    const r = await fetch('/u?t=${token}&msg=1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text.slice(0, 2000) }) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    inp.value = '';
    j('сообщение ушло (' + text.length + ' симв.)');
    await pollMsgs();
  } catch (e) { j('сообщение не ушло: ' + (e.message || e)); }
  msgBusy = false;
}
async function pollMsgs() {
  // ответы с ПК забираем тихим опросом раз в 3с — локалка, дёшево
  try {
    const r = await fetch('/u?t=${token}&msgs=1&since=' + msgSince, { cache: 'no-store' });
    if (!r.ok) return;
    const d = await r.json();
    if (d && d.ok && d.msgs && d.msgs.length) {
      msgSince = d.n; msgAll = msgAll.concat(d.msgs); renderMsgs(msgAll, 'msgList');
      if (msgsOpen) msgSeenPc = msgAll.filter(function (m) { return m.from === 'pc'; }).length;
      paintMsgBadge();
    }
  } catch (e) {}
}
setInterval(pollMsgs, 3000);
let msgsOpen = false, msgSeenPc = 0;
function openMsgs() {
  document.getElementById('msgOverlay').classList.add('open');
  msgsOpen = true;
  msgSeenPc = msgAll.filter(function (m) { return m.from === 'pc'; }).length;
  paintMsgBadge();
  renderMsgs(msgAll, 'msgList');
  const box = document.getElementById('msgList');
  if (box) box.scrollTop = box.scrollHeight;
}
function closeMsgs() {
  document.getElementById('msgOverlay').classList.remove('open');
  msgsOpen = false;
}
function paintMsgBadge() {
  const b = document.getElementById('msgBadge');
  if (!b) return;
  const fresh = msgAll.filter(function (m) { return m.from === 'pc'; }).length - msgSeenPc;
  b.style.display = fresh > 0 ? '' : 'none';
  b.textContent = fresh > 0 ? t('chatNew') + ' ' + fresh : '';
}
// раздача с ПК: что выложили в окне — забираем по ссылке (скачивание нативное, браузером)
function fmtSize(n) {
  n = Number(n) || 0;
  if (n >= 1048576) return (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + ' МБ';
  if (n >= 1024) return Math.round(n / 1024) + ' КБ';
  return n + ' Б';
}
async function pollDl() {
  try {
    const r = await fetch('/u?t=${token}&share=1', { cache: 'no-store' });
    if (!r.ok) return;
    const d = await r.json();
    if (!d || !d.ok || !d.items) return;
    const box = document.getElementById('dlList');
    const empty = document.getElementById('dlEmpty');
    if (!box) return;
    if (empty) empty.style.display = d.items.length ? 'none' : '';
    const sig = d.items.map(function (e) { return e.id + ':' + e.size + ':' + e.name; }).join('|');
    if (box.dataset.sig === sig) return; // то же самое — не трогаем (иначе рвём тап)
    box.dataset.sig = sig;
    box.innerHTML = '';
    d.items.forEach(function (e) {
      const a = document.createElement('a');
      a.href = '/u?t=${token}&get=' + encodeURIComponent(e.id);
      a.setAttribute('download', e.name);
      a.target = '_blank';
      a.rel = 'noopener';
      a.style.cssText = 'display:block;font-size:13.5px;background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:9px 12px;word-break:break-all;color:var(--brand);text-decoration:none;font-weight:600';
      a.textContent = '⬇ ' + e.name + ' · ' + fmtSize(e.size);
      box.appendChild(a);
    });
  } catch (e) {}
}
setInterval(pollDl, 5000);
pollDl();
// любая молчаливая JS-ошибка на странице — красным в статус, а не тишина:
// иначе отладка превращается в гадание (кейс 12.10: выбор файла и ничего)
window.addEventListener('error', e => {
  try {
    const st = document.getElementById('status');
    st.className = 'show err';
    st.textContent = 'Ошибка: ' + (e.message || e.error || e);
  } catch (_) {}
});
// async-падения идут мимо 'error' — ловим и их, иначе снова немая тишина
window.addEventListener('unhandledrejection', e => {
  try {
    const st = document.getElementById('status');
    st.className = 'show err';
    st.textContent = 'Ошибка: ' + ((e.reason && e.reason.message) || e.reason || e);
  } catch (_) {}
});
const MAXSIZE = ${maxBytes}; // потолок тарифа — отказ сразу, а не после 10 минут заливки
const LIMSTR = ${JSON.stringify(limStr)};
const CHUNKSZ = 512 * 1024; // куски под лимиты памяти вкладки iOS (баг №1: 700 МБ одним XHR давили вкладку).
// История размеров: 8 МБ → 2 МБ → 1 МБ → 512 КБ. Логика выживания на душных роутерах:
// душилка бьёт по длинным соединениям — короткие куски проскакивают раньше, чем их успевают прибить,
// а сторож с докачкой подбирает остальное. Накладные расходы на LAN незаметны.
// А ГЛАВНОЕ (урок 12.10): одиночный POST летает везде, где куски встают.
// Поэтому куски — только для гигантов, всё обычное идёт одним запросом как в 1.0.0.
const CHUNK_THRESHOLD = 32 * 1024 * 1024; // меньше — одним запросом, больше — кусками.
// Куски едут тем же multipart, что фото (не octet): для middlebox неотличимо.

async function sendFiles(el) {
  const files = Array.from(el.files || []); // снимок СРАЗУ: дальше сбрасываем input, а сброс опустошает живой FileList
  el.value = ''; // сброс: повторный выбор того же файла снова сработает
  if (!files || !files.length || sending) return;
  sending = true;
  const st = document.getElementById('status');
  const wrap = document.getElementById('upWrap');
  const bar = document.getElementById('upBar');
  const pct = document.getElementById('upPct');
  st.className = 'show';
  const setPct = p => { bar.style.width = p + '%'; pct.textContent = p + '%'; };
  const fails = []; // один битый файл больше не убивает всю очередь
  await pingServer();
  for (const f of files) {
    if (f.size > MAXSIZE) {
      fails.push(f.name);
      j('SKIP ' + f.name + ' (' + f.size + ' Б > ' + LIMSTR + ')');
      continue;
    }
    if (f.size === 0) { // iCloud: байтов нет уже на клиенте — сервер можно не дёргать
      fails.push(f.name);
      st.className = 'show err';
      st.textContent = t('sendErr', { e: t('empty') });
      j('FAIL ' + f.name + ': empty (0 байт на клиенте)');
      continue;
    }
    j('SEND ' + f.name + ' ' + f.size + ' Б');
    st.className = 'show';
    st.textContent = t('sending', { f: f.name });
    wrap.style.display = ''; pct.style.display = ''; setPct(0);
    try {
      if (f.size > CHUNK_THRESHOLD) { j('большой — кусками'); await sendChunked(f, setPct); }
      else { j('обычный — одним запросом'); await sendSingle(f, setPct); }
      total++;
      j('DONE ' + f.name + ' (всего ' + total + ')');
    } catch (e) {
      fails.push(f.name);
      // сервер возвращает ключи ошибок ('empty' и др.) — переводим через словарь, иначе сырой ключ
      st.className = 'show err';
      st.textContent = t('sendErr', { e: e.message === 'empty' ? t('empty') : e.message });
      j('FAIL ' + f.name + ': ' + e.message + ' — иду дальше, остальное досылаю');
      wrap.style.display = 'none'; pct.style.display = 'none';
      continue;
    }
  }
  wrap.style.display = 'none'; pct.style.display = 'none';
  sending = false;
  st.className = fails.length ? 'show err' : 'show';
  st.innerHTML = '<div class="count">' + t('sent', { n: total }) + '</div>' +
    (fails.length ? '<div style="font-size:13px">не ушло (' + fails.length + '): ' + fails.slice(0, 3).join(', ') + (fails.length > 3 ? '…' : '') + '</div>' : '');
}

function sendSingle(f, setPct) {
  // fetch процентов загрузки не даёт — шлём через XHR ради прогресса.
  // Ретраим и одиночные: раньше одна судорога сети убивала весь файл.
  const post = () => new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('file', f, f.name);
    const x = new XMLHttpRequest();
    x.open('POST', '/u?t=${token}');
    x.timeout = 120000;
    x.upload.onprogress = e => { if (e.lengthComputable) setPct(Math.round(e.loaded / e.total * 100)); };
    x.onload = () => {
      if (x.status >= 200 && x.status < 300) return resolve();
      let msg = 'HTTP ' + x.status;
      try { const j = JSON.parse(x.responseText); if (j && j.error) msg = j.error; } catch (e2) {}
      reject(new Error(msg));
    };
    x.onerror = () => reject(new Error('net'));
    x.ontimeout = () => reject(new Error('timeout'));
    x.send(fd);
  });
  return (async () => {
    let lastErr = new Error('net');
    for (let a = 0; a < 3; a++) {
      try { await post(); return; }
      catch (e) { lastErr = e; if (e.message === 'empty') throw e; j('одиночный попытка ' + (a + 1) + ': ' + e.message); await new Promise(r => setTimeout(r, 900 * (a + 1))); }
    }
    throw lastErr;
  })();
}

async function sendChunked(f, setPct) {
  // большие файлы — кусками: вкладка не давится, прогресс честный,
  // обрыв докачиваем с места (сервер помнит, сколько кусков уже лежит).
  // cid детерминирован от файла: перезагрузка страницы продолжает, а не начинает сначала.
  const cid = makeCid(f);
  let sz = adaptSz;
  try {
    const saved = JSON.parse(localStorage.getItem('pixport-up-' + cid) || 'null');
    if (saved && saved.sz >= ADAPT_MIN && saved.sz <= ADAPT_MAX) sz = saved.sz;
  } catch (e) {}
  const n = Math.ceil(f.size / sz);
  j('кусков: ' + n + ' по ' + Math.round(sz / 1024) + ' КБ (cid ' + cid.slice(0, 8) + ')');
  const pctEl = document.getElementById('upPct');
  let curB = 0, curP = 0, lastB = 0, lastT = Date.now(); // байты для спидометра
  let curXhr = null, lastProg = Date.now(); // сторож простоя
  // нет прогресса 15 сек — текущий запрос мёртв: прибиваем, цикл ниже пошлёт кусок заново
  // (сервер помнит принятые куски — докачка с места, а не сначала)
  const dog = setInterval(() => {
    if (curXhr && Date.now() - lastProg > 15000) { j('сторож: 15с без прогресса, прибиваю и шлю заново'); try { curXhr.abort(); } catch (e) {} }
  }, 5000);
  const fmtSpd = bps => bps >= 1048576
    ? (bps / 1048576).toFixed(1) + ' МБ/с'
    : Math.round(bps / 1024) + ' КБ/с';
  // тикаем раз в секунду сами: если события прогресса встали — увидим честные 0 КБ/с,
  // а не застывшую цифру
  const spdTimer = setInterval(() => {
    const now = Date.now(), dt = (now - lastT) / 1000;
    const bps = dt > 0 ? (curB - lastB) / dt : 0;
    lastB = curB; lastT = now;
    pctEl.textContent = curP + '% · ' + fmtSpd(bps);
  }, 1000);
  const postOne = idx => new Promise((resolve, reject) => {
    // кусок — тем же multipart, что обычное фото: для middlebox неотличимо (урок 12.10).
    // Поля ПЕРЕД файлом: сервер решает режим (кусок/целое) до начала чтения тела.
    const t0 = Date.now();
    const fd = new FormData();
    fd.append('cid', cid);
    fd.append('i', String(idx));
    fd.append('n', String(n));
    fd.append('name', f.name);
    fd.append('file', f.slice(idx * sz, Math.min(f.size, (idx + 1) * sz)), 'chunk');
    const x = new XMLHttpRequest();
    x.open('POST', '/u?t=${token}');
    x.timeout = 120000; // кусок дольше 2 минут — не ждём вечно, а ретраим (иначе вечный 0%)
    curXhr = x; // сторож ниже может его прибить при простое
    x.upload.onprogress = e => { // прогресс ВНУТРИ куска, а не только между кусками
      if (!e.lengthComputable) return;
      curB = idx * sz + e.loaded;
      curP = Math.round(curB / f.size * 100);
      lastProg = Date.now();
      setPct(curP);
    };
    x.onload = () => {
      curXhr = null;
      let jj = null;
      try { jj = JSON.parse(x.responseText); } catch (e) {}
      if (x.status >= 200 && x.status < 300 && jj && jj.ok) { j('ч' + idx + ' ' + (Date.now() - t0) + ' мс'); return resolve(jj); }
      if (x.status === 409 && jj && typeof jj.wait === 'number') return resolve({ catchUp: jj.wait });
      let msg = 'HTTP ' + x.status;
      if (jj && jj.error) msg = jj.error;
      reject(new Error(msg));
    };
    x.onerror = () => { curXhr = null; reject(new Error('net')); };
    x.ontimeout = () => { curXhr = null; reject(new Error('timeout')); };
    x.onabort = () => { curXhr = null; reject(new Error('retry')); }; // прибил сторож — не ошибка, а повтор
    x.send(fd);
  });
  return (async () => {
    try {
    // спросим сервер, сколько уже лежит: страница могла перезагрузиться посреди файла
    let idx = 0, retries = 0;
    try {
      const r = await fetch('/u?t=${token}&state=1&cid=' + cid, { cache: 'no-store' });
      const st = await r.json();
      if (st && st.ok && st.got > 0 && st.n === n) { idx = st.got; curP = Math.round(idx / n * 100); setPct(curP); j('продолжаю с ' + idx + '/' + n); }
    } catch (e) {}
    while (idx < n) {
      let ok = false, lastErr = null;
      for (let a = 0; a < 6 && !ok; a++) {
        try {
          lastProg = Date.now(); // каждая попытка сама считается жизнью
          const r = await postOne(idx);
          if (r && typeof r.catchUp === 'number') { j('ч' + idx + ': сервер обогнал, догоняю с ' + r.catchUp); idx = r.catchUp; }
          else { idx++; j('ч' + (idx - 1) + ' ок (' + idx + '/' + n + ')'); }
          ok = true;
        } catch (e) { lastErr = e; retries++; if (e.message === 'empty') throw e; j('ч' + idx + ' попытка ' + (a + 1) + ': ' + e.message); await new Promise(r2 => setTimeout(r2, 800 * (a + 1))); }
      }
      if (!ok) { adaptOk(99); throw lastErr; }
      try { localStorage.setItem('pixport-up-' + cid, JSON.stringify({ sz, got: idx })); } catch (e) {}
      curP = Math.round(idx / n * 100);
      setPct(curP);
    }
    try { localStorage.removeItem('pixport-up-' + cid); } catch (e) {}
    adaptOk(retries);
    } finally { clearInterval(spdTimer); clearInterval(dog); }
  })();
}
// не даём экрану заснуть во время загрузки (перезапрос: iOS сбрасывает lock при сворачивании)
let __wl = null;
function keepAwake() { try { if ('wakeLock' in navigator) navigator.wakeLock.request('screen').then(l => { __wl = l; }).catch(() => {}); } catch (e) {} }
keepAwake();
document.addEventListener('visibilitychange', () => { if (!document.hidden && sending) keepAwake(); });
</script>
</body>
</html>`;
}

function qrPage(token, folder, net) {
  const netWarn = net && net.ok ? '' :
    `<div class="netwarn">⚠ Нет подключения к локальной сети — телефон не сможет загрузить фото. Проверь Wi-Fi на компьютере.</div>`;
  const netHint = net && net.ok ?
    `<div class="hint" id="netHint">Телефон подключается к ${escapeHtml(net.ip)} · оба должны быть в одном Wi-Fi</div>` : '';
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
    --bg:#0d0d0f; --card:#161619; --ink:#f0f0f2; --muted:#8e8e96;
    --line:#2a2a2e; --brand:#4d5ff0; --brand-ink:#fff; --soft:#1f1f24;
    --ok:#6ee7a0; --err:#ff8f8f; --shadow:0 12px 40px rgba(0,0,0,.6);
    --qr-glow:0 12px 50px rgba(0,0,0,.55);
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  *, *::before, *::after { transition:background-color .3s ease, color .3s ease, border-color .3s ease, box-shadow .3s ease; }
  body {
    min-height:100vh; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    background:var(--bg); color:var(--ink);
    display:flex; flex-direction:column; align-items:center; justify-content:center; gap:14px;
    padding:24px;
  }
  .top { width:100%; max-width:420px; display:flex; align-items:center; justify-content:space-between; }
  .logo { font-size:12px; letter-spacing:4px; text-transform:uppercase; color:var(--brand); font-weight:800; }
  #themeBtn, #settingsBtn {
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
    transition:transform .15s ease, filter .15s;
    position:relative; overflow:hidden;
  }
  .actions button:hover { filter:brightness(.97); transform:scale(1.05); }
  .actions button:active { transform:scale(.96); }
  .actions button:disabled { opacity:.6; cursor:default; }
  /* текстура каждой кнопки — своя переменная */
  #newQrBtn { --tex:url(/assets/qrtex-dark.png); }
  #openBtn { --tex:url(/assets/folder-dark.png); }
  #pickBtn { --tex:url(/assets/swap-dark.png); }
  [data-theme="dark"] #newQrBtn { --tex:url(/assets/qrtex-light.png); }
  [data-theme="dark"] #openBtn { --tex:url(/assets/folder-light.png); }
  [data-theme="dark"] #pickBtn { --tex:url(/assets/swap-light.png); }
  /* при наведении текстура проступает и едет за курсором */
  .actions button::after {
    content:''; position:absolute; inset:0; border-radius:inherit; pointer-events:none;
    background-image:var(--tex);
    background-repeat:no-repeat;
    background-size:200px 200px;
    background-position:var(--qx, 50%) var(--qy, 50%);
    opacity:0; transition:opacity .25s ease, background-position .35s ease-out;
  }
  .actions button:hover::after { opacity:.16; }
  .hint { font-size:12px; color:var(--muted); text-align:center; }
  .ipRow { display:flex; gap:6px; flex-wrap:wrap; justify-content:center; }
  .ipRow button {
    font-size:12px; font-weight:700; padding:6px 12px; border-radius:10px; cursor:pointer;
    border:1px solid var(--line); background:var(--soft); color:var(--muted);
  }
  .ipRow button.on { color:var(--brand-ink); background:var(--brand); border-color:var(--brand); }
  .netwarn {
    font-size:13px; color:var(--err); border:1px solid var(--err);
    border-radius:12px; padding:10px 14px; text-align:center; max-width:100%; line-height:1.5;
  }
  .helpLink {
    background:none; border:0; color:var(--muted); font-size:12.5px; cursor:pointer;
    text-decoration:underline; text-underline-offset:3px; padding:4px 8px;
  }
  .helpLink:hover { color:var(--brand); }
  .overlay {
    display:none; position:fixed; inset:0; background:rgba(15,18,40,.5);
    align-items:center; justify-content:center; padding:24px; z-index:10;
  }
  .overlay.open { display:flex; }
  .sheet {
    background:var(--card); color:var(--ink); border:1px solid var(--line);
    border-radius:20px; box-shadow:var(--shadow); max-width:400px; width:100%;
    padding:24px 22px; text-align:left;
    max-height:calc(100vh - 48px); overflow:auto; /* на крошечных экранах скроллится шторка, а не страница */
  }
  .sheet h3 { font-size:17px; margin-bottom:12px; }
  .sheet ol { margin:0 0 6px 20px; font-size:14px; line-height:1.65; color:var(--ink); }
  .sheet ol small { color:var(--muted); }
  .sheet .note { font-size:12.5px; color:var(--muted); line-height:1.6; margin-top:8px; }
  .sheet .closeRow { text-align:right; margin-top:14px; }
  .sheet .closeRow button {
    font-size:14px; font-weight:700; padding:9px 20px; border-radius:12px; cursor:pointer;
    border:0; background:var(--brand); color:var(--brand-ink);
  }
  #menuBtn {
    font-size:14px; font-weight:600; padding:10px 18px; border-radius:12px; cursor:pointer;
    border:1px solid var(--line); background:var(--soft); color:var(--ink);
  }
  #menuBtn:disabled { opacity:.6; cursor:default; }
  #planBadgeTop {
    position:absolute; left:100%; bottom:-3px; margin-left:7px;
    font-size:9px; font-weight:800; letter-spacing:1.5px; padding:2px 7px; border-radius:999px;
  }
  #planBadgeTop.free { background:var(--soft); color:var(--muted); border:1px solid var(--line); }
  #planBadgeTop.pro { background:var(--brand); color:var(--brand-ink); }
  #goProBtn {
    font-size:14px; font-weight:800; padding:11px 22px; border-radius:14px; cursor:pointer;
    border:0; background:var(--brand); color:var(--brand-ink); box-shadow:var(--shadow);
    /* ширина фиксирована: смена текста на короткое PRO не должна сужать кнопку,
       иначе ховер мигает и приходится целиться */
    min-width:210px; text-align:center;
    transition:transform .15s ease, background-color .25s ease, color .25s ease, box-shadow .25s ease;
  }
  /* при наведении: растёт сильнее обычных кнопок, золотится, текст — просто PRO */
  #goProBtn:hover { transform:scale(1.08); background-color:#ffb700; color:#2a1e00; box-shadow:0 6px 24px rgba(255,183,0,.45); }
  #goProBtn:active { transform:scale(.96); }
  /* Купить Pro в модалке: та же золотая анимация, но кнопка на всю ширину —
     scale чуть скромнее (1.05), иначе широкая кнопка перелетает за края */
  #proPayBtn {
    width:100%; font-size:16px; font-weight:800; padding:13px; border-radius:14px; cursor:pointer;
    border:0; background:var(--brand); color:var(--brand-ink);
    transition:transform .15s ease, background-color .25s ease, color .25s ease, box-shadow .25s ease;
  }
  #proPayBtn:hover { transform:scale(1.05); background-color:#ffb700; color:#2a1e00; box-shadow:0 6px 24px rgba(255,183,0,.45); }
  #proPayBtn:active { transform:scale(.98); }
</style>
</head>
<body>
  <div class="top">
    <div class="logo" style="position:relative">PixPort<span id="planBadgeTop" class="${isPro() ? 'pro' : 'free'}">${isPro() ? 'PRO' : 'FREE'}</span></div>
    <div style="display:flex;gap:8px">
      <button id="settingsBtn" style="display:none" onclick="openSettings()" title="Настройки">⚙</button>
      <button id="themeBtn" onclick="toggleTheme()" title="Тёмная / светлая тема">🌙</button>
    </div>
  </div>
  <div class="card">
  <div class="folder">📷 ${escapeHtml(folder)}</div>
  <div id="updBanner" onclick="updGo()" style="display:none;cursor:pointer;width:100%;background:var(--brand);color:#fff;font-size:14px;font-weight:700;padding:11px 16px;border-radius:12px;text-align:center"><span id="updBannerText"></span></div>
  ${netWarn}
  <div id="qr"><img id="qrimg" alt="QR"></div>
  <div class="status" id="status" data-i="status_wait">Ожидание телефона…</div>
  <div class="actions">
    <button id="newQrBtn" onclick="newQr()" data-i="btn_new" style="font-size:15.5px;padding:11px 24px">Новый QR</button>
    <button id="chatBtn" onclick="openChat()" style="font-size:15.5px;padding:11px 24px"><span data-i="btn_chat">💬 Чат</span><span id="chatBadge" style="display:none;color:#fff;background:var(--err);border-radius:999px;font-size:10px;font-weight:800;padding:1px 7px;margin-left:6px;vertical-align:2px"></span></button>
  </div>
  <div class="actions" style="margin-top:0">
    <button id="openBtn" onclick="openFolder()" data-i="btn_open">Открыть папку</button>
    <button id="pickBtn" onclick="pickFolder()" data-i="btn_pick">Сменить папку</button>
  </div>
  <div id="shareBox" style="display:none;width:100%;flex-direction:column;align-items:center;gap:8px;border-top:1px solid var(--line);padding-top:12px;margin-top:2px">
    <div style="font-size:14px;font-weight:800" data-i="shareTitle">📤 На телефон</div>
    <div id="shareList" style="display:flex;flex-direction:column;gap:6px;width:100%"></div>
    <div class="actions" style="margin-top:0">
      <button id="shareBtn" onclick="sharePick()" data-i="shareBtn">Выбрать файлы</button>
    </div>
    <input type="file" id="shareIn" multiple style="display:none">
    <div class="hint" data-i="shareHint">или перетащи файлы в это окно — телефон заберёт их по ссылке ниже</div>
  </div>
  <div class="hint" data-i="hint_scan">Сканируй камерой телефона · код живёт 30 минут</div>
  ${netHint}
  <div class="hint">PixPort v${APP_VERSION}</div>
  </div>
  <button id="goProBtn" onclick="openPro()" data-i="goPro"${isPro() ? ' style="display:none"' : ''}>Перейти на PRO</button>
  <button class="helpLink" onclick="openHelp()" data-i="helpLink">Как пользоваться</button>
  <div class="overlay" id="settingsOverlay" onclick="if(event.target===this)closeSettings()">
    <div class="sheet">
      <h3 data-i="setTitle">⚙ Настройки</h3>
      <div style="font-size:14px;font-weight:700;margin-bottom:8px" data-i="netTitle">Подключение телефона</div>
      <div style="font-size:13px;color:var(--muted);line-height:1.55;margin-bottom:10px" data-i="netDesc">Если сетей несколько и телефон не грузит — выбери другой адрес, QR перегенерируется.</div>
      <div class="ipRow" id="ipRow" style="margin-bottom:14px"></div>
      <div style="font-size:14px;font-weight:700;margin-bottom:8px" data-i="langTitle">Язык / Language</div>
      <div style="margin-bottom:14px">
        <button data-lang-btn="ru" onclick="setLang('ru')" style="font-size:14px;font-weight:700;padding:8px 18px;border-radius:10px;cursor:pointer;border:1px solid var(--line);background:var(--soft);color:var(--ink)">RU</button>
        <button data-lang-btn="en" onclick="setLang('en')" style="font-size:14px;font-weight:700;padding:8px 18px;border-radius:10px;cursor:pointer;border:1px solid var(--line);background:var(--soft);color:var(--ink)">EN</button>
      </div>
      <div style="font-size:14px;font-weight:700;margin-bottom:8px" data-i="subTitle">Подписка PixPort</div>
      <div style="font-size:13px;color:var(--muted);line-height:1.55;margin-bottom:10px" id="subDesc" data-i="subDescFree">Бесплатно: фото до 960 px со сжатием. С ключом Pro — оригинальное качество без ограничений.</div>
      <div style="display:flex;gap:8px;margin-bottom:8px" id="subRow">
        <input id="subKey" placeholder="PP-XXXXXX-XXXXXX-XXXXXX" style="flex:1;min-width:0;font-size:13px;padding:9px 12px;border-radius:10px;border:1px solid var(--line);background:var(--soft);color:var(--ink);font-family:ui-monospace,monospace">
        <button id="subBtn" onclick="subClick()" style="font-size:13px;padding:9px 16px" data-i="subBtn">Активировать</button>
      </div>
      <div id="subMsg" style="font-size:13px;min-height:18px;margin-bottom:6px"></div>
      <div id="subKeyShow" style="display:none;font-size:13px;margin-bottom:10px;background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:9px 12px">
        <div style="color:var(--muted);margin-bottom:6px" data-i="subKeySaved">Сохраните ключ — пригодится при переустановке:</div>
        <div style="display:flex;gap:8px;align-items:center">
          <code id="subKeyText" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:12px;color:var(--ink)"></code>
          <button id="subCopy" onclick="subCopyKey()" style="font-size:12px;padding:7px 12px;flex:0 0 auto" data-i="copyBtn">Копировать</button>
        </div>
      </div>
      <div style="font-size:12px;color:var(--muted);margin-bottom:10px"><span data-i="pcCodeHint">Код этого ПК для именного ключа — пришли его в поддержку вместе с оплатой:</span><br><code id="pcCode" style="font-size:12px;color:var(--ink)">…</code> <button id="pcCopy" onclick="pcCopyCode()" style="font-size:12px;padding:5px 10px" data-i="copyBtn">Копировать</button></div>
      <div style="font-size:14px;font-weight:700;margin-bottom:8px" data-i="updTitle">Обновления</div>
      <div style="font-size:13px;color:var(--muted);line-height:1.55;margin-bottom:10px" id="updStatus" data-i="updIdle">Нажми «Проверить» — сравним твою версию с GitHub.</div>
      <div style="display:flex;gap:8px;margin-bottom:14px">
        <button id="updBtn" onclick="updCheck()" style="font-size:13px;padding:9px 16px" data-i="updCheck">Проверить</button>
        <button id="updDl" onclick="updGo()" style="display:none;font-size:13px;padding:9px 16px" data-i="updDl">Скачать</button>
      </div>
      <label style="display:flex;align-items:center;gap:10px;font-size:14px;margin-bottom:14px;cursor:pointer">
        <input type="checkbox" id="autoChk" style="width:18px;height:18px;accent-color:var(--brand)">
        <span data-i="autoStart">Запускаться вместе с Windows</span>
      </label>
      <div style="font-size:14px;font-weight:700;margin-bottom:8px" data-i="menuTitle">Пункт в меню проводника</div>
      <div style="font-size:13px;color:var(--muted);line-height:1.55;margin-bottom:12px" data-i="menuDesc">Добавляет «Показать QR» в правый клик по папке. Трогать нужно один раз — дальше оно просто работает.</div>
      <button id="menuBtn" style="display:none" onclick="toggleMenu()" data-i="menuBtnAdd">В меню проводника</button>
      <div id="menuMsg" style="font-size:13px;color:var(--ok);min-height:18px;margin-top:8px"></div>
      <div class="closeRow"><button onclick="closeSettings()" data-i="btn_done">Готово</button></div>
    </div>
  </div>
  <div class="overlay" id="helpOverlay" onclick="if(event.target===this)closeHelp()">
    <div class="sheet">
      <h3 data-i="helpTitle">Как пользоваться PixPort</h3>
      <ol>
        <li data-i-html="help1"><b>Выбери папку</b> — кнопкой, перетаскиванием в окно, правым кликом в проводнике или <b>Ctrl+Alt+Q</b> в открытой папке.</li>
        <li data-i-html="help2"><b>Наведи камеру телефона</b> на QR-код.</li>
        <li data-i-html="help3"><b>Сними фото</b> или выбери из галереи — оно сразу окажется в папке на компьютере.</li>
      </ol>
      <div class="note" data-i="helpNote">Телефон и компьютер должны быть в одном Wi-Fi (нет роутера — раздай точку доступа с телефона, тоже сработает). QR-код живёт 30 минут. Закрытие окна сворачивает программу в трей — хоткей продолжает работать. Телефон не открывает страницу? Разреши PixPort в брандмауэре Windows (порт 8765).</div>
      <div class="closeRow"><button onclick="closeHelp()" data-i="btn_ok">Понятно</button></div>
    </div>
  </div>
  <div class="overlay" id="proOverlay" onclick="if(event.target===this)closePro()">
    <div class="sheet">
      <h3 data-i="proTitle">PixPort Pro</h3>
      <ol>
        <li data-i-html="proB1"><b>Оригинальное качество</b> фото — без потолка 960 px и сжатия.</li>
        <li data-i-html="proB2"><b>Файлы и видео</b> до 10 ГБ — как есть, без пережатия.</li>
      </ol>
      <div style="margin-top:14px">
        <button id="proPayBtn" onclick="proPay()" data-i="proPay">Купить Pro</button>
      </div>
      <div id="payMsg" style="font-size:13px;color:var(--muted);min-height:18px;margin-top:8px;text-align:center"></div>
      <div class="closeRow"><button onclick="closePro()" data-i="btn_ok" style="background:var(--soft);color:var(--ink);border:1px solid var(--line)">Понятно</button></div>
    </div>
  </div>
  <div class="overlay" id="chatOverlay" onclick="if(event.target===this)closeChat()">
    <div class="sheet" style="display:flex;flex-direction:column;height:min(600px,calc(100vh - 48px));padding:16px 14px 12px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <h3 data-i="chatTitle" style="margin:0">Чат сессии</h3>
        <button onclick="closeChat()" title="✕" style="width:32px;height:32px;border-radius:50%;border:1px solid var(--line);background:var(--soft);color:var(--ink);font-size:14px;cursor:pointer;line-height:1">✕</button>
      </div>
      <div id="chatList" style="flex:1;overflow:auto;display:flex;flex-direction:column;gap:8px;margin-bottom:10px"></div>
      <div id="chatEmpty" data-i="chatEmpty" style="font-size:13px;color:var(--muted);line-height:1.55;margin-bottom:10px">Пока тихо — напиши с телефона, упадёт сюда и запиской в папку</div>
      <div style="display:flex;gap:8px;margin-bottom:6px">
        <input id="chatIn" data-i-ph="chatPcPh" placeholder="Ответ с компьютера…" onkeydown="if(event.key==='Enter')sendChat()" style="flex:1;min-width:0;font-size:14px;padding:10px 12px;border-radius:999px;border:1px solid var(--line);background:var(--soft);color:var(--ink)">
        <button onclick="sendChat()" data-i="chatSend" style="flex:0 0 auto;font-size:14px;font-weight:700;padding:10px 18px;border-radius:999px;border:0;background:var(--brand);color:var(--brand-ink);cursor:pointer">Отправить</button>
      </div>
      <div class="note" data-i="chatNote" style="font-size:11.5px;color:var(--muted);text-align:center">Живёт пока жив QR. Каждое сообщение — ещё и note-*.txt в папке.</div>
      <button class="helpLink" onclick="cleanAsk(null)" data-i="cleanBtn" style="margin-top:6px">🧹 Удалить записки сессии</button>
    </div>
  </div>
  <div class="overlay" id="cleanOverlay">
    <div class="sheet" style="max-width:340px">
      <h3 data-i="cleanTitle">Записки сессии</h3>
      <div id="cleanQ" style="font-size:14px;line-height:1.6;color:var(--ink)"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;flex-wrap:wrap">
        <button onclick="cleanGo(true)" data-i="cleanYes" style="font-size:13.5px;font-weight:700;padding:9px 16px;border-radius:10px;border:0;background:var(--err);color:#fff;cursor:pointer">Удалить и продолжить</button>
        <button onclick="cleanGo(false)" data-i="cleanKeep" style="font-size:13.5px;font-weight:700;padding:9px 16px;border-radius:10px;border:1px solid var(--line);background:var(--soft);color:var(--ink);cursor:pointer">Оставить</button>
        <button onclick="cleanCancel()" data-i="cleanCancel" style="font-size:13.5px;padding:9px 16px;border-radius:10px;border:0;background:none;color:var(--muted);cursor:pointer">Отмена</button>
      </div>
    </div>
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
<script>${LANG_DICT_JS}</script>
<script>${LANG_JS}</script>
<script>applyLang(__LANG);</script>
<script>
const token = '${token}';
let dead = false;
const desktop = !!window.pixport;

if (desktop) {
  document.getElementById('settingsBtn').style.display = '';
}

// --- пункт в контекстном меню проводника (живёт в Настройках) ---
function openSettings() {
  document.getElementById('settingsOverlay').classList.add('open');
  if (desktop) {
    document.getElementById('menuBtn').style.display = '';
    refreshMenuBtn();
    autoSync();
  }
  loadIps();
  loadSub();
}

/* --- автозапуск --- */
async function autoSync() {
  const c = document.getElementById('autoChk');
  try { c.checked = !!(await window.pixport.autostartStatus()); } catch (e) {}
  c.onchange = async () => {
    const r = await window.pixport.autostartSet(c.checked).catch(() => null);
    if (!r || !r.ok) c.checked = !c.checked; // не вышло — вернуть как было
  };
}

/* --- подписка --- */
function showSavedKey(key) {
  const box = document.getElementById('subKeyShow');
  if (!box) return;
  if (key) {
    document.getElementById('subKeyText').textContent = key;
    box.style.display = '';
  } else {
    box.style.display = 'none';
  }
}
async function subCopyKey() {
  const key = document.getElementById('subKeyText').textContent || '';
  if (!key) return;
  try { await navigator.clipboard.writeText(key); }
  catch (e) {
    const ta = document.createElement('textarea');
    ta.value = key; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e2) {}
    ta.remove();
  }
  const b = document.getElementById('subCopy');
  const old = b.textContent;
  b.textContent = t('copied');
  setTimeout(() => { b.textContent = old; }, 1500);
}
async function pcCopyCode() {
  const code = document.getElementById('pcCode').textContent || '';
  if (!code || code === '…') return;
  try { await navigator.clipboard.writeText(code); }
  catch (e) {
    const ta = document.createElement('textarea');
    ta.value = code; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e2) {}
    ta.remove();
  }
  const b = document.getElementById('pcCopy');
  const old = b.textContent;
  b.textContent = t('copied');
  setTimeout(() => { b.textContent = old; }, 1500);
}
async function loadSub() {
  try {
    const st = await (await fetch('/api/license?t=' + token)).json();
    paintSub(!!st.pro, st.key || null);
    if (st.hwid) document.getElementById('pcCode').textContent = st.hwid;
  } catch (e) {}
}
function paintSub(pro, key) {
  const desc = document.getElementById('subDesc');
  const row = document.getElementById('subRow');
  const btn = document.getElementById('subBtn');
  desc.dataset.i = pro ? 'subDescPro' : 'subDescFree';
  desc.textContent = t(desc.dataset.i);
  btn.dataset.i = pro ? 'subBtnOff' : 'subBtn'; // data-i, а не голый текст — иначе смена языка сотрёт состояние
  btn.textContent = t(btn.dataset.i);
  if (pro) {
    row.style.display = 'none';
    btn.style.display = '';
  }
  showSavedKey(pro ? (key || null) : null);
  paintPlan(pro); // бейдж у логотипа + кнопка «Перейти на PRO»
}
// бейдж FREE/PRO у логотипа и видимость кнопки перехода (перерендера нет — правим руками)
function paintPlan(pro) {
  const badge = document.getElementById('planBadgeTop');
  if (badge) { badge.textContent = pro ? 'PRO' : 'FREE'; badge.className = pro ? 'pro' : 'free'; }
  const go = document.getElementById('goProBtn');
  if (go) go.style.display = pro ? 'none' : '';
}

/* --- модалка Pro --- */
const PAY_URL = '${PRO_PAY_URL}';
function openPro() { document.getElementById('proOverlay').classList.add('open'); }
function closePro() { document.getElementById('proOverlay').classList.remove('open'); }
function proPay() {
  if (!PAY_URL) {
    const m = document.getElementById('payMsg');
    m.textContent = t('proSoon');
    return;
  }
  if (window.pixport && window.pixport.openUrl) window.pixport.openUrl(PAY_URL);
  else location.href = PAY_URL;
}
async function subClick() {
  const msg = document.getElementById('subMsg');
  const btn = document.getElementById('subBtn');
  const st = await (await fetch('/api/license?t=' + token)).json();
  if (st.pro) {
    await fetch('/api/license/off?t=' + token, { method: 'POST' });
    msg.style.color = 'var(--muted)';
    msg.textContent = t('subOff');
    document.getElementById('subRow').style.display = 'flex';
    btn.textContent = t('subBtn');
    document.getElementById('subDesc').dataset.i = 'subDescFree';
    document.getElementById('subDesc').textContent = t('subDescFree');
    showSavedKey(null);
    paintPlan(false);
    return;
  }
  const key = document.getElementById('subKey').value.trim();
  btn.disabled = true;
  try {
    const r = await fetch('/api/license?t=' + token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key })
    });
    const s = await r.json();
    if (s.ok || s.pro) {
      msg.style.color = 'var(--ok)';
      msg.textContent = t('subOk');
      paintSub(true, s.key || key);
    } else {
      msg.style.color = 'var(--err)';
      msg.textContent = t('subBad');
    }
  } catch (e) {
    msg.style.color = 'var(--err)';
    msg.textContent = t('subBad');
  }
  btn.disabled = false;
}
function closeSettings() { document.getElementById('settingsOverlay').classList.remove('open'); }

/* --- обновления с GitHub --- */
let updUrl = '';
function paintUpdBanner(ver) {
  // заметная плашка прямо в окне (не только в настройках): тихо нашли — тихо показали
  const b = document.getElementById('updBanner');
  if (!b) return;
  if (ver) {
    document.getElementById('updBannerText').textContent = t('updBanner', { v: ver });
    b.style.display = '';
  } else {
    b.style.display = 'none';
  }
  if (window.__fitSoon) window.__fitSoon();
}
async function updCheck(silent) {
  const st = document.getElementById('updStatus');
  const dl = document.getElementById('updDl');
  const btn = document.getElementById('updBtn');
  if (!silent) { btn.disabled = true; st.textContent = t('wait'); }
  try {
    const r = await (await fetch('/api/update?t=' + token)).json();
    if (!r.ok) { if (!silent) st.textContent = t(r.error === 'empty' ? 'updEmpty' : 'updFail'); }
    else if (r.update) {
      st.textContent = t('updAvailable', { v: r.latest });
      updUrl = r.url || '';
      dl.style.display = '';
      paintUpdBanner(r.latest);
    } else {
      st.textContent = t('updLatest', { v: r.current });
      dl.style.display = 'none';
      paintUpdBanner(null);
    }
  } catch (e) { if (!silent) st.textContent = t('updFail'); }
  btn.disabled = false;
}
function updGo() {
  if (!updUrl) return;
  if (window.pixport && window.pixport.openUrl) window.pixport.openUrl(updUrl);
  else location.href = updUrl;
}
if (desktop) updCheck(true); // тихая проверка при открытии окна

async function refreshMenuBtn() {
  const b = document.getElementById('menuBtn');
  const on = await window.pixport.menuStatus();
  b.dataset.on = on ? '1' : '';
  b.textContent = on ? t('menuBtnDel') : t('menuBtnAdd');
  b.style.borderColor = on ? '#1d9e57' : '';
}

async function toggleMenu() {
  const b = document.getElementById('menuBtn');
  const removing = b.dataset.on === '1'; // состояние, а не текст — текст зависит от языка
  const msg = document.getElementById('menuMsg');
  b.disabled = true;
  b.textContent = t('wait');
  try {
    const r = await (removing ? window.pixport.menuRemove() : window.pixport.menuInstall());
    if (r && r.ok) {
      msg.style.color = 'var(--ok)';
      msg.innerHTML = removing ? t('menu_removed') : t('menu_added');
    } else {
      msg.style.color = 'var(--err)';
      msg.textContent = t('menu_fail') + ((r && r.error) || t('unknown'));
    }
  } catch (e) {
    msg.style.color = 'var(--err)';
    msg.textContent = t('err_prefix') + e.message;
  }
  b.disabled = false;
  await refreshMenuBtn();
}

async function refresh() {
  if (dead) return;
  try {
    const r = await fetch('/api/status?t=' + token);
    if (r.status === 404) { die(t('status_closed')); return; }
    const s = await r.json();
    const st = document.getElementById('status');
    if (s.received > 0) st.innerHTML = t('received', { n: s.received });
    if (s.msgs) {
      renderChatList(s.msgs);
      if (chatOpen) chatSeenPhone = lastMsgs.filter(function (m) { return m.from === 'phone'; }).length;
      paintChatBadge();
    }
    if (s.share) renderShare(s.share);
    if (typeof s.notes === 'number') notesN = s.notes;
  } catch (e) { /* сервер жив, просто мигнули */ }
}
setInterval(refresh, 1200);

function die(msg) { dead = true; document.getElementById('status').textContent = msg; }

function newQr() {
  // обновление убивает сессию — спросить про записки, если накопились
  if (notesN > 0) cleanAsk('new');
  else newQrGo();
}
function newQrGo() { location.href = '/api/new?t=' + token; }
// чистка записок сессии: ручная кнопка в чате + вопрос перед обновлением QR
let cleanNext = null, notesN = 0;
function cleanAsk(next) {
  cleanNext = next;
  const q = document.getElementById('cleanQ');
  if (q) q.textContent = t('cleanQ', { n: notesN });
  document.getElementById('cleanOverlay').classList.add('open');
}
async function cleanGo(del) {
  if (del) {
    try { await fetch('/api/cleannotes?t=' + token, { method: 'POST' }); } catch (e) {}
  }
  document.getElementById('cleanOverlay').classList.remove('open');
  const nx = cleanNext; cleanNext = null;
  if (nx === 'new') newQrGo();
  else refresh();
}
function cleanCancel() {
  document.getElementById('cleanOverlay').classList.remove('open');
  cleanNext = null;
}
function openHelp() { document.getElementById('helpOverlay').classList.add('open'); }
function closeHelp() { document.getElementById('helpOverlay').classList.remove('open'); }
function closeQr() {
  navigator.sendBeacon('/api/close?t=' + token);
  if (desktop) setTimeout(() => window.close(), 250);
  else die(t('closed_tab'));
}
// чат сессии: телефон шлёт текст/ссылки на ПК без интернета, дубли — записками note-*.txt в папке
let chatOpen = false, chatSeenPhone = 0, lastMsgs = [];
function escChat(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function linkifyChat(s) {
  return escChat(s).replace(/(https?:\\/\\/[^\\s<]+|www\\.[^\\s<]+)/g, function (u) {
    const href = u.indexOf('http') === 0 ? u : 'http://' + u;
    return '<a href="' + href + '" target="_blank" rel="noopener">' + u + '</a>';
  });
}
function copyChat(text, btn) {
  try {
    const done = () => { if (btn) { btn.textContent = '✓'; setTimeout(() => { btn.textContent = '⧉'; }, 1200); } };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(() => {});
    else { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); done(); }
  } catch (e) {}
}
function chatBubble(m) {
  const mine = m.from === 'pc'; // свои — синие справа, с телефона — серые слева
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;justify-content:' + (mine ? 'flex-end' : 'flex-start');
  const b = document.createElement('div');
  b.style.cssText = 'max-width:85%;border-radius:14px;padding:8px 11px;font-size:13.5px;line-height:1.45;word-break:break-word;box-shadow:var(--shadow);' +
    (mine ? 'background:var(--brand);color:#fff;border-bottom-right-radius:4px'
          : 'background:var(--soft);color:var(--ink);border:1px solid var(--line);border-bottom-left-radius:4px');
  const tx = document.createElement('div');
  tx.innerHTML = linkifyChat(m.text || '');
  if (mine) tx.querySelectorAll('a').forEach(function (a) { a.style.color = '#fff'; });
  const meta = document.createElement('div');
  meta.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;align-items:center;margin-top:3px;font-size:10px;opacity:.75';
  const tm = document.createElement('span');
  try { tm.textContent = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (e) { tm.textContent = ''; }
  const cp = document.createElement('button');
  cp.textContent = '⧉';
  cp.title = t('copyBtn');
  cp.style.cssText = 'font-size:10px;padding:0 4px;border:0;background:none;color:inherit;opacity:.8;cursor:pointer';
  cp.onclick = (function (txt, btn) { return function () { copyChat(txt, btn); }; })(m.text, cp);
  meta.appendChild(tm); meta.appendChild(cp);
  b.appendChild(tx); b.appendChild(meta);
  row.appendChild(b);
  return row;
}
let chatDrawn = []; // что уже в DOM: новые дописываем в конец, историю не трогаем
function renderChatList(msgs) {
  lastMsgs = msgs || [];
  const box = document.getElementById('chatList');
  const empty = document.getElementById('chatEmpty');
  if (!box) return;
  if (empty) empty.style.display = lastMsgs.length ? 'none' : '';
  const sameHead = chatDrawn.length <= lastMsgs.length && chatDrawn.every(function (m, i) {
    return lastMsgs[i] && lastMsgs[i].ts === m.ts && lastMsgs[i].text === m.text;
  });
  if (!sameHead) { box.innerHTML = ''; chatDrawn = []; } // история сдвинулась (чистка) — разовая перерисовка
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  for (let k = chatDrawn.length; k < lastMsgs.length; k++) box.appendChild(chatBubble(lastMsgs[k]));
  chatDrawn = lastMsgs.slice();
  if (nearBottom) box.scrollTop = box.scrollHeight; // читаешь историю выше — не дёргаем
}
function openChat() {
  document.getElementById('chatOverlay').classList.add('open');
  chatOpen = true;
  chatSeenPhone = lastMsgs.filter(function (m) { return m.from === 'phone'; }).length;
  paintChatBadge();
  renderChatList(lastMsgs);
  const box = document.getElementById('chatList'); // было скрыто — скролл мог не прилипнуть
  if (box) box.scrollTop = box.scrollHeight;
}
function closeChat() {
  document.getElementById('chatOverlay').classList.remove('open');
  chatOpen = false;
}
async function sendChat() {
  const inp = document.getElementById('chatIn');
  const text = (inp.value || '').trim();
  if (!text) return;
  inp.value = '';
  try {
    await fetch('/api/msg?t=' + token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text.slice(0, 2000) }) });
    refresh();
  } catch (e) {}
}
function paintChatBadge() {
  const b = document.getElementById('chatBadge');
  if (!b) return;
  const fresh = lastMsgs.filter(function (m) { return m.from === 'phone'; }).length - chatSeenPhone;
  b.style.display = fresh > 0 ? '' : 'none';
  b.textContent = fresh > 0 ? t('chatNew') + ' ' + fresh : '';
}
function openFolder() {
  if (desktop) window.pixport.openPath(location.search.split('folder=')[1] ? decodeURIComponent(location.search.split('folder=')[1]) : '');
  else fetch('/api/open?t=' + token);
}
async function pickFolder() {
  // в браузере нативного диалога нет — ведём на страницу выбора папки
  if (!window.pixport) { location.href = '/'; return; }
  const p = await window.pixport.pickFolder();
  if (p) location.href = '/?folder=' + encodeURIComponent(p);
}

// перетаскивание в окно: папки — как раньше (QR для неё), файлы — в раздачу на телефон
if (desktop) {
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault();
    const paths = [];
    for (const f of (e.dataTransfer.files || [])) {
      const p = window.pixport.pathForFile(f);
      if (p) paths.push(p);
    }
    if (paths.length) postShare(paths);
  });
  const sb = document.getElementById('shareBox');
  if (sb) sb.style.display = 'flex';
}
// раздача файлов на телефон: выбор кнопкой, список, снять с раздачи
function fmtSize(n) {
  n = Number(n) || 0;
  if (n >= 1048576) return (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + ' МБ';
  if (n >= 1024) return Math.round(n / 1024) + ' КБ';
  return n + ' Б';
}
function sharePick() {
  const inp = document.getElementById('shareIn');
  if (inp) inp.click();
}
async function postShare(paths) {
  try {
    const r = await fetch('/api/share?t=' + token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths }) });
    const d = await r.json();
    if (d && d.ok) {
      if (d.share) renderShare(d.share);
      if (d.folder) location.href = '/?folder=' + encodeURIComponent(d.folder);
      if (window.__fitSoon) window.__fitSoon();
    }
  } catch (e) {}
}
async function unshare(id) {
  try {
    const r = await fetch('/api/unshare?t=' + token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    const d = await r.json();
    if (d && d.ok && d.share) { renderShare(d.share); if (window.__fitSoon) window.__fitSoon(); }
  } catch (e) {}
}
function renderShare(list) {
  const box = document.getElementById('shareList');
  if (!box) return;
  box.innerHTML = '';
  (list || []).forEach(function (e) {
    const d = document.createElement('div');
    d.style.cssText = 'display:flex;gap:8px;align-items:center;font-size:13px;background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:7px 10px;word-break:break-all';
    const nm = document.createElement('span');
    nm.style.cssText = 'flex:1;min-width:0';
    nm.textContent = e.name + ' · ' + fmtSize(e.size);
    const x = document.createElement('button');
    x.textContent = '✕';
    x.style.cssText = 'flex:0 0 auto;font-size:11px;padding:3px 9px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--muted);cursor:pointer';
    x.onclick = (function (id) { return function () { unshare(id); }; })(e.id);
    d.appendChild(nm); d.appendChild(x); box.appendChild(d);
  });
}

// закрыли вкладку — токен умер
window.addEventListener('pagehide', () => navigator.sendBeacon('/api/close?t=' + token));

// QR-картинка + выбор адреса, если сетей несколько
let curIp = null;
function loadQr(ip) {
  const q = '/api/qr?t=' + token + (ip ? '&ip=' + encodeURIComponent(ip) : '') +
    '&lang=' + (__LANG === 'en' ? 'en' : 'ru');
  fetch(q)
    .then(r => r.ok ? r.json() : Promise.reject(r.status))
    .then(u => {
      document.getElementById('qrimg').src = u;
      if (ip) {
        curIp = ip;
        const h = document.getElementById('netHint');
        if (h) h.textContent = t('phone_via', { ip });
        document.querySelectorAll('#ipRow button').forEach(b =>
          b.classList.toggle('on', b.dataset.ip === ip));
      }
      refresh();
    })
    .catch(e => { document.getElementById('status').textContent = t('qr_fail') + e; });
}
function loadIps() {
  const row = document.getElementById('ipRow');
  if (!row || row.dataset.done) return;
  fetch('/api/ips?t=' + token)
    .then(r => r.ok ? r.json() : null)
    .then(s => {
      if (s && s.ips && s.ips.length > 1) {
        curIp = s.current;
        row.dataset.done = '1';
        s.ips.forEach(ip => {
          const b = document.createElement('button');
          b.textContent = ip;
          b.dataset.ip = ip;
          if (ip === s.current) b.classList.add('on');
          b.onclick = () => loadQr(ip);
          row.appendChild(b);
        });
      } else {
        row.style.display = 'none';
      }
    })
    .catch(() => {});
}
loadQr(null);
window.__fitSoon = () => setTimeout(fitWin, 50);
const shareIn = document.getElementById('shareIn');
if (shareIn) shareIn.addEventListener('change', function () {
  const paths = [];
  for (const f of (shareIn.files || [])) {
    try { const p = window.pixport.pathForFile(f); if (p) paths.push(p); } catch (e) {}
  }
  shareIn.value = '';
  if (paths.length) postShare(paths);
});
fitWin(); // окно ровно под контент, без скролла
setTimeout(fitWin, 1200); // добор после устаканивания шрифтов
// кнопка PRO: при наведении текст меняется на короткое «PRO» (смена языка вернёт полный — applyLang)
const goBtn = document.getElementById('goProBtn');
if (goBtn) {
  goBtn.addEventListener('mouseenter', () => { goBtn.textContent = 'PRO'; });
  goBtn.addEventListener('mouseleave', () => { goBtn.textContent = t('goPro'); });
}
// Купить Pro в модалке — та же анимация
const payBtn = document.getElementById('proPayBtn');
if (payBtn) {
  payBtn.addEventListener('mouseenter', () => { payBtn.textContent = 'PRO'; });
  payBtn.addEventListener('mouseleave', () => { payBtn.textContent = t('proPay'); });
}
// QR-текстура на кнопках едет за курсором (позиция — в CSS-переменных,
// transition на background-position даёт плавное отставание)
document.querySelectorAll('.actions button').forEach(b => {
  b.addEventListener('mousemove', e => {
    const r = b.getBoundingClientRect();
    b.style.setProperty('--qx', ((e.clientX - r.left) / r.width * 100).toFixed(1) + '%');
    b.style.setProperty('--qy', ((e.clientY - r.top) / r.height * 100).toFixed(1) + '%');
  });
});
</script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ------------------------------------------------------- язык (RU/EN) */

// Словари для клиента. Русский = дефолт, сервер рендерит его же inline.
// data-i="key" — подмена текста, data-i-html="key" — подмена с HTML внутри.
const LANG_DICT = {
ru: {
  status_wait: 'Ожидание телефона…',
  btn_new: 'Новый QR', btn_close: 'Закрыть', btn_open: 'Открыть папку',
  btn_pick: 'Сменить папку', btn_settings: '⚙ Настройки',
  hint_scan: 'Сканируй камерой телефона · код живёт 30 минут',
  phone_via: 'Телефон подключается к {ip} · оба должны быть в одном Wi-Fi',
  dropHint: '…или перетащи папку сюда',
  helpLink: 'Как пользоваться', helpTitle: 'Как пользоваться PixPort',
  help1: '<b>Выбери папку</b> — кнопкой, перетаскиванием в окно, правым кликом в проводнике или <b>Ctrl+Alt+Q</b> в открытой папке.',
  help2: '<b>Наведи камеру телефона</b> на QR-код.',
  help3: '<b>Сними фото</b> или выбери из галереи — оно сразу окажется в папке на компьютере.',
  helpNote: 'Телефон и компьютер должны быть в одном Wi-Fi (нет роутера — раздай точку доступа с телефона, тоже сработает). QR-код живёт 30 минут. Закрытие окна сворачивает программу в трей — хоткей продолжает работать. Телефон не открывает страницу? Разреши PixPort в брандмауэре Windows (порт 8765).',
  btn_ok: 'Понятно', setTitle: '⚙ Настройки',
  subTitle: 'Подписка PixPort',
  subDescFree: 'Бесплатно: фото до 960 px со сжатием. С ключом Pro — оригинальное качество без ограничений.',
  subDescPro: 'Pro активировано: оригинальное качество фото без ограничений.',
  subPlaceholder: 'PP-XXXXXX-XXXXXX-XXXXXX',
  subBtn: 'Активировать', subBtnOff: 'Отключить Pro',
  subOk: '✓ Pro активировано', subBad: 'Ключ не подходит', subOff: 'Возвращено в бесплатный режим',
  subKeySaved: 'Сохраните ключ — пригодится при переустановке:', copyBtn: 'Копировать', copied: 'Скопировано',
  pcCodeHint: 'Код этого ПК для именного ключа — пришли его в поддержку вместе с оплатой:',
  planFree: 'Бесплатно · 960px', planPro: 'Pro · оригинал',
  autoStart: 'Запускаться вместе с Windows',
  updTitle: 'Обновления',
  updIdle: 'Нажми «Проверить» — сравним твою версию с GitHub.',
  updCheck: 'Проверить', updDl: 'Скачать',
  updLatest: 'У тебя последняя версия ({v})',
  updAvailable: 'Вышла {v} — жми «Скачать»',
  updBanner: 'Доступна {v} — нажми, чтобы скачать',
  updFail: 'Не удалось проверить (нет сети?)',
  updEmpty: 'Релизов пока нет — загляни позже',
  goPro: 'Перейти на PRO',
  proTitle: 'PixPort Pro',
  proB1: '<b>Оригинальное качество</b> фото — без потолка 960 px и сжатия.',
  proB2: '<b>Файлы и видео</b> до 10 ГБ — как есть, без пережатия.',
  proPay: 'Купить Pro',
  proSoon: 'Продажи скоро откроются. А ключ уже можно ввести в ⚙ Настройках.',  netTitle: 'Подключение телефона',
  netDesc: 'Если сетей несколько и телефон не грузит — выбери другой адрес, QR перегенерируется.',
  langTitle: 'Язык / Language',
  menuTitle: 'Пункт в меню проводника',
  menuDesc: 'Добавляет «Показать QR» в правый клик по папке. Трогать нужно один раз — дальше оно просто работает.',
  menuBtnAdd: 'В меню проводника', menuBtnDel: 'Убрать из меню',
  menu_added: '✓ Готово: правый клик по папке → <b>Показать QR</b>',
  menu_removed: 'Пункт убран из контекстного меню',
  menu_fail: 'Не получилось: ',
  btn_done: 'Готово',
  whatsTitle: 'Что нового',
  status_closed: 'QR закрыт', received: 'Принято фото: <b>{n}</b>',
  qr_fail: 'Не удалось получить QR: ', err_prefix: 'Ошибка: ',
  wait: 'Секунду…', unknown: 'неизвестно',
  closed_tab: 'QR закрыт — можно закрывать вкладку',
  pickTitle: 'Выбери папку для фото',
  pickDesc: 'Нажми кнопку ниже или перетащи папку в это окно.<br>Потом наведи камеру телефона на QR-код.',
  btn_choose: '📁 Выбрать папку',
  menu_added_short: '✓ Готово: правый клик по любой папке → Показать QR',
  menu_removed_short: 'Пункт убран',
  nofolder: 'Запусти PixPort с папкой:<br><code>node server.js "C:\\папка"</code>',
  upHint: 'Фото сразу попадут в папку на компьютере. Встало на процентах — открой файл в галерее и дождись полной загрузки (кружок iCloud), потом отправь заново. Стоит подолгу — раздай точку доступа с телефона вместо роутера',
  btn_shoot: '📷 Снять фото', btn_gallery: '🖼 Выбрать из галереи',
  btn_file: '📁 Файл / видео',
  foot: 'PixPort · без проводов и мессенджеров',
  sending: 'Отправляю {f}…', sent: '✓ {n} — отправлено в папку',
  sendErr: 'Ошибка: {e}. Попробуй ещё раз.',
  showLog: 'Лог отправки',
  tooBig: 'Файл больше {lim} — выбери поменьше',
  empty: 'Файл пустой — вероятно, он не скачан с iCloud. Скачай его в «Файлах» (подожди завершения загрузки) и выбери снова',
  icloudHint: 'Файл с iCloud виден, но не скачан на телефон? Сначала полностью скачай его в «Файлах», потом выбирай здесь',
  btn_chat: '💬 Чат', chatTitle: 'Чат сессии',
  chatPh: 'Текст или ссылка с телефона…', chatSend: 'Отправить',
  chatPcPh: 'Ответ с компьютера…', chatEmpty: 'Пока тихо — напиши с телефона, упадёт сюда и запиской в папку',
  chatNote: 'Живёт пока жив QR. Каждое сообщение — ещё и note-*.txt в папке.',
  chatNew: 'новое',
  shareTitle: '📤 На телефон', shareBtn: 'Выбрать файлы',
  shareHint: 'или перетащи файлы в это окно — телефон заберёт их по ссылке ниже',
  dlTitle: '📥 С компьютера', dlEmpty: 'Пока нечем делиться — кинь файлы в окно на ПК',
  cleanTitle: 'Записки сессии', cleanQ: 'В папке {n} записок этой сессии. Удалить их?',
  cleanYes: 'Удалить и продолжить', cleanKeep: 'Оставить', cleanCancel: 'Отмена',
  cleanBtn: '🧹 Удалить записки сессии',
},
en: {
  status_wait: 'Waiting for phone…',
  btn_new: 'New QR', btn_close: 'Close', btn_open: 'Open folder',
  btn_pick: 'Change folder', btn_settings: '⚙ Settings',
  hint_scan: 'Scan with your phone camera · code lives 30 minutes',
  phone_via: 'Phone connects to {ip} · both must be on the same Wi-Fi',
  dropHint: '…or drag a folder here',
  helpLink: 'How to use', helpTitle: 'How to use PixPort',
  help1: '<b>Pick a folder</b> — with the button, by dragging into the window, right-clicking it in Explorer, or <b>Ctrl+Alt+Q</b> inside it.',
  help2: '<b>Point your phone camera</b> at the QR code.',
  help3: '<b>Take a photo</b> or pick from gallery — it lands straight in the PC folder.',
  helpNote: 'Phone and PC must be on the same Wi-Fi (no router around — tether from your phone, that works too). QR lives 30 minutes. Closing the window minimizes to tray — the hotkey keeps working. Phone won\'t open the page? Allow PixPort through the Windows firewall (port 8765).',
  btn_ok: 'Got it', setTitle: '⚙ Settings',
  subTitle: 'PixPort subscription',
  subDescFree: 'Free: photos up to 960 px, compressed. With a Pro key — original quality, no limits.',
  subDescPro: 'Pro is active: original photo quality, no limits.',
  subPlaceholder: 'PP-XXXXXX-XXXXXX-XXXXXX',
  subBtn: 'Activate', subBtnOff: 'Turn off Pro',
  subOk: '✓ Pro activated', subBad: 'Key not valid', subOff: 'Back to free mode',
  subKeySaved: 'Save your key — you’ll need it after reinstall:', copyBtn: 'Copy', copied: 'Copied',
  pcCodeHint: 'This PC’s code for a personal key — send it to support along with your payment:',
  planFree: 'Free · 960px', planPro: 'Pro · original',
  autoStart: 'Start with Windows',
  updTitle: 'Updates',
  updIdle: 'Hit “Check” — we compare your version with GitHub.',
  updCheck: 'Check', updDl: 'Download',
  updLatest: 'You are up to date ({v})',
  updAvailable: '{v} is out — hit “Download”',
  updBanner: '{v} is out — tap to download',
  updFail: 'Could not check (offline?)',
  updEmpty: 'No releases yet — check back later',
  goPro: 'Get PRO',
  proTitle: 'PixPort Pro',
  proB1: '<b>Original quality</b> photos — no 960 px cap, no extra compression.',
  proB2: '<b>Files & video</b> up to 10 GB — as is, no recompression.',
  proPay: 'Buy Pro',
  proSoon: 'Sales opening soon. You can already enter a key in ⚙ Settings.',
  netTitle: 'Phone connection',
  netDesc: 'Multiple networks and the phone won\'t load? Pick another address, the QR regenerates.',
  langTitle: 'Язык / Language',
  menuTitle: 'Explorer context menu item',
  menuDesc: 'Adds “Show QR” to folder right-click. Set once — then it just works.',
  menuBtnAdd: 'Add to menu', menuBtnDel: 'Remove from menu',
  menu_added: '✓ Done: right-click a folder → <b>Show QR</b>',
  menu_removed: 'Menu item removed',
  menu_fail: 'Failed: ',
  btn_done: 'Done',
  whatsTitle: "What's new",
  status_closed: 'QR closed', received: 'Photos received: <b>{n}</b>',
  qr_fail: 'Could not get QR: ', err_prefix: 'Error: ',
  wait: 'One sec…', unknown: 'unknown',
  closed_tab: 'QR closed — you can close the tab',
  pickTitle: 'Pick a folder for photos',
  pickDesc: 'Press the button below or drag a folder into this window.<br>Then point your phone camera at the QR code.',
  btn_choose: '📁 Pick a folder',
  menu_added_short: '✓ Done: right-click any folder → Show QR',
  menu_removed_short: 'Menu item removed',
  nofolder: 'Start PixPort with a folder:<br><code>node server.js "C:\\folder"</code>',
  upHint: 'Photos land straight in the PC folder. Stuck mid-way — open the file in gallery, wait for full download (iCloud circle), then retry. Stalls long — use phone hotspot instead of router',
  btn_shoot: '📷 Take a photo', btn_gallery: '🖼 Choose from gallery',
  btn_file: '📁 File / video',
  foot: 'PixPort · no cables, no messengers',
  sending: 'Sending {f}…', sent: '✓ {n} sent to folder',
  sendErr: 'Error: {e}. Try again.',
  showLog: 'Upload log',
  tooBig: 'File exceeds {lim} — pick a smaller one',
  empty: 'File is empty — likely not downloaded from iCloud. Download it in Files (wait for the iCloud ring) and pick again',
  icloudHint: 'iCloud file shows but is not on the phone? Download it fully in Files first, then pick it here',
  btn_chat: '💬 Chat', chatTitle: 'Session chat',
  chatPh: 'Text or link from phone…', chatSend: 'Send',
  chatPcPh: 'Reply from PC…', chatEmpty: 'Quiet so far — write from your phone, it lands here and as a note in the folder',
  chatNote: 'Lives while the QR lives. Every message is also a note-*.txt in the folder.',
  chatNew: 'new',
  shareTitle: '📤 To phone', shareBtn: 'Pick files',
  shareHint: 'or drag files into this window — the phone grabs them via the link below',
  dlTitle: '📥 From PC', dlEmpty: 'Nothing shared yet — drop files into the PC window',
  cleanTitle: 'Session notes', cleanQ: '{n} session notes in the folder. Delete them?',
  cleanYes: 'Delete & continue', cleanKeep: 'Keep', cleanCancel: 'Cancel',
  cleanBtn: '🧹 Delete session notes',
}};

// Общий клиентский код языка. Сервер вставляет window.__INIT_LANG до него.
const LANG_JS = `
var __LANG = window.__INIT_LANG || null;
try { __LANG = __LANG || localStorage.getItem('pixport-lang') || 'ru'; } catch (e) { __LANG = __LANG || 'ru'; }
if (!LANG_DICT[__LANG]) __LANG = 'ru';
function t(k, vars) {
  var s = (LANG_DICT[__LANG] && LANG_DICT[__LANG][k]) || LANG_DICT.ru[k] || k;
  if (vars) for (var key in vars) s = s.split('{' + key + '}').join(vars[key]);
  return s;
}
function applyLang(lang) {
  __LANG = LANG_DICT[lang] ? lang : 'ru';
  document.querySelectorAll('[data-i]').forEach(function (el) {
    el.textContent = t(el.dataset.i);
  });
  document.querySelectorAll('[data-i-html]').forEach(function (el) {
    el.innerHTML = t(el.dataset.iHtml);
  });
  document.querySelectorAll('[data-i-ph]').forEach(function (el) {
    el.placeholder = t(el.dataset.iPh);
  });
  document.querySelectorAll('[data-lang-btn]').forEach(function (b) {
    const on = b.dataset.langBtn === __LANG;
    b.style.fontWeight = on ? '800' : '400';
    b.style.opacity = on ? '1' : '.55';
  });
  const lb = document.getElementById('langBtn');
  if (lb) lb.textContent = __LANG.toUpperCase();
}
function setLang(lang) {
  try { localStorage.setItem('pixport-lang', lang); } catch (e) {}
  applyLang(lang);
  try { if (window.__fitSoon) window.__fitSoon(); } catch (e) {} // тексты другой длины — перепроверить высоту
}
/* Замер высоты контента без мигания: minima на vh врут при замере,
   поэтому на один синхронный reflow их снимаем (перерисовки между нет). */
function measureContentH() {
  const de = document.documentElement, b = document.body;
  const s1 = de.style.minHeight, s2 = b.style.minHeight;
  de.style.minHeight = '0'; b.style.minHeight = '0';
  const h = Math.max(de.scrollHeight, b.scrollHeight);
  de.style.minHeight = s1; b.style.minHeight = s2;
  return h;
}
function fitWin() {
  if (!window.pixport || !window.pixport.fitWindow) return;
  window.pixport.fitWindow(Math.ceil(measureContentH()) + 12);
}
function toggleLang() { setLang(__LANG === 'ru' ? 'en' : 'ru'); }
`;
const LANG_DICT_JS = 'var LANG_DICT = ' + JSON.stringify(LANG_DICT) + ';';

/* --- «Что нового»: текст пишет автор в whatsnew.ru.txt / whatsnew.en.txt,
 * окно показывает его один раз на версию (localStorage). Разметка:
 * **жирный**, строки с «- » — список, пустая строка — абзац. */
function whatsHtml(raw) {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const bold = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  const paras = String(raw || '').replace(/\r/g, '').split(/\n\s*\n/);
  const out = [];
  for (const p of paras) {
    const lines = p.split('\n').map(l => l.trim()).filter(l => l);
    if (!lines.length) continue;
    if (lines.every(l => /^[-•]\s+/.test(l)))
      out.push('<ul style="margin:0 0 6px 20px;padding:0">' +
        lines.map(l => '<li>' + bold(l.replace(/^[-•]\s+/, '')) + '</li>').join('') + '</ul>');
    else
      out.push('<p style="margin:0 0 8px">' + lines.map(bold).join('<br>') + '</p>');
  }
  return out.join('');
}

function whatsnew(lang) {
  const f = path.join(__dirname, lang === 'en' ? 'whatsnew.en.txt' : 'whatsnew.ru.txt');
  try { return whatsHtml(fs.readFileSync(f, 'utf8')); }
  catch (e) { return ''; }
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

function json(res, code, obj, extra) {
  const b = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, extra || {}));
  res.end(b);
}

/* --- чанковая загрузка больших файлов (баг №1: вкладка iOS давится,
 * когда 700 МБ летят одним XHR — FormData держит всё в памяти + копия).
 * Телефон режет файл на куски по 8 МБ: POST /u?t=..&cid=..&i=..&n=..&name=..
 * с телом application/octet-stream. Куски дописываются в tmp, последний
 * уходит в общий финал finishUpload — как обычный аплоад. */
const CHUNK_MAX = 32 * 1024 * 1024; // кусок больше — не кусок, а атака
const uploads = new Map(); // cid -> { tmp, name, n, got, size, ts, pro }

function sweepUploads() {
  const now = Date.now();
  for (const [cid, u] of uploads) {
    if (now - u.ts > 2 * 3600 * 1000) {
      try { fs.rmSync(u.tmp, { force: true }); } catch (e) {}
      uploads.delete(cid);
    }
  }
}

/* Общий финал заливки: tmp + исходное имя -> папка. Владеет tmp (удаляет,
 * кроме случая moveFile — там tmp уже переехал). Возвращает { saved } / { failed }. */
async function finishUpload(s, tmp, orig) {
  const pro = isPro();
  const ext = path.extname(orig || 'photo.jpg').toLowerCase();
  const drop = () => { try { fs.rmSync(tmp, { force: true }); } catch (e) {} };
  try {
    if (pro && !isImageExt(ext)) {
      // Pro и не картинка (видео, документ) — кладём как есть, без пережатия
      const fname = uniqueName(s.folder, ext || '.bin');
      moveFile(tmp, path.join(s.folder, fname));
      s.received++;
      s.files.push(fname);
      console.log(`[OK, файл] ${path.join(s.folder, fname)}`);
      return { saved: fname }; // tmp уже переехал — чистить нечего
    }
    // Картинка: поворачиваем по EXIF и кодируем в JPG.
    // Free — потолок 960px и quality 70 (на большом экране мылит —
    // за оригиналом в Pro); Pro — оригинал, quality 92.
    // Сжатие происходит здесь, на ПК, поэтому телефон и браузер
    // ничего обойти не могут.
    let img = sharp(tmp).rotate();
    if (!pro) {
      img = img.resize({ width: 960, height: 960, fit: 'inside', withoutEnlargement: true });
    }
    const fname = uniqueName(s.folder, '.jpg');
    await img.jpeg({ quality: pro ? 92 : 70, mozjpeg: true }).toFile(path.join(s.folder, fname));
    s.received++;
    s.files.push(fname);
    console.log(`[OK] ${path.join(s.folder, fname)}`);
    drop();
    return { saved: fname };
  } catch (e) {
    // Не картинка, хотя притворялась расширением:
    // Pro — кладём как есть, free — вежливый отказ (иначе видео пролезет бесплатно).
    if (pro) {
      try {
        const fname = uniqueName(s.folder, ext || '.bin');
        moveFile(tmp, path.join(s.folder, fname));
        s.received++;
        s.files.push(fname);
        console.log(`[OK, оригинал] ${fname} (${e.message})`);
        return { saved: fname };
      } catch (e2) { drop(); return { failed: e2.message }; }
    }
    drop();
    return { failed: 'В бесплатной версии — только фото' };
  }
}

async function ingestChunk(s, cidRaw, iRaw, nRaw, nameRaw, body) {
  // Общее ядро приёма куска: транспорт любой (octet из старых сборок или
  // multipart — неотличимый от обычного фото для middlebox). Возвращает
  // { code, body } — готовый ответ клиенту.
  const cid = cidRaw || '';
  const i = parseInt(iRaw, 10), n = parseInt(nRaw, 10);
  if (!/^[0-9a-f]{16,64}$/i.test(cid) || !(i >= 0) || !(n > 0) || i >= n || n > 2048)
    return { code: 400, body: { ok: false, error: 'Плохой кусок' } };
  const pro = isPro();
  const maxSize = pro ? 10 * 1024 * 1024 * 1024 : 60 * 1024 * 1024;
  sweepUploads();
  let u = uploads.get(cid);
  if (!u) {
    if (i !== 0) return { code: 400, body: { ok: false, error: 'Начни с нулевого куска' } };
    const name = (path.basename(nameRaw || 'photo.jpg').slice(0, 120) || 'photo.jpg');
    const tmp = path.join(os.tmpdir(), `pixport-c-${Date.now()}-${cid.slice(0, 12)}.part`);
    fs.writeFileSync(tmp, Buffer.alloc(0));
    u = { tmp, name, n, got: 0, size: 0, ts: Date.now(), pro };
    uploads.set(cid, u);
  }
  if (body.length === 0) { // iOS iCloud: нулевое тело — файл не скачан на телефон
    return { code: 500, body: { ok: false, error: 'empty' } };
  }
  if (i < u.got) return { code: 200, body: { ok: true, chunk: i } }; // дубль (ретрай после обрыва ответа) — уже лежит
  if (i !== u.got || n !== u.n) return { code: 409, body: { ok: false, error: 'Порядок кусков', wait: u.got } };
  u.ts = Date.now();
  fs.appendFileSync(u.tmp, body);
  u.got++; u.size += body.length;
  if (u.size > maxSize) {
    try { fs.rmSync(u.tmp, { force: true }); } catch (e) {}
    uploads.delete(cid);
    return { code: 500, body: { ok: false, error: u.pro ? 'Файл больше 10 ГБ' : 'Файл больше 60 МБ' } };
  }
  if (u.got < u.n) return { code: 200, body: { ok: true, chunk: i } };
  uploads.delete(cid);
  const r = await finishUpload(s, u.tmp, u.name);
  if (r.saved) return { code: 200, body: { ok: true, file: r.saved, total: s.received } };
  return { code: 500, body: { ok: false, error: r.failed } };
}

async function handleChunk(req, res, token, p) {
  // octet-путь (старые dev-сборки): тело — сырые байты, параметры — в query.
  // Новые шлют multipart через общий busboy ниже — для middlebox неотличимо от фото.
  const s = sessions.get(token);
  if (!s) return json(res, 404, { ok: false, error: 'QR устарел' });
  if (Date.now() - s.created > TOKEN_TTL) { sessions.delete(token); return json(res, 404, { ok: false, error: 'QR устарел' }); }
  let body;
  try { body = await readBody(req, CHUNK_MAX); }
  catch (e) { return json(res, 500, { ok: false, error: 'Кусок больше 32 МБ' }); }
  const r = await ingestChunk(s, p.get('cid'), p.get('i'), p.get('n'), p.get('name'), body);
  return json(res, r.code, r.body);
}

/* --- чат сессии: текст/ссылки с телефона на ПК (и обратно) без интернета.
 * Живёт пока жив QR (30 мин), каждое сообщение дублируется запиской note-*.txt в папку. */
const MSG_MAX = 2000; // символов в сообщении — ссылка влезет любая, роман — нет
const MSG_KEEP = 50; // столько храним в сессии, остальное уже лежит записками в папке

function pushMsg(s, from, text) {
  text = String(text === undefined || text === null ? '' : text).trim().slice(0, MSG_MAX);
  if (!text) return null;
  const m = { from: from === 'pc' ? 'pc' : 'phone', text, ts: Date.now() };
  s.msgs.push(m);
  if (s.msgs.length > MSG_KEEP) s.msgs.splice(0, s.msgs.length - MSG_KEEP);
  try {
    // uniqueName проверяет занятость без префикса — докручиваем счётчик уже с ним
    const base = uniqueName(s.folder, '.txt').replace(/\.txt$/, '');
    let fname = 'note-' + base + '.txt', k = 1;
    while (fs.existsSync(path.join(s.folder, fname))) fname = 'note-' + base + ' (' + (k++) + ').txt';
    fs.writeFileSync(path.join(s.folder, fname), text, 'utf8');
    s.files.push(fname);
  } catch (e) { /* записка не влезла — чат всё равно живёт */ }
  return m;
}

async function handleMsg(req, res, token, from) {
  const s = sessions.get(token);
  if (!s) return json(res, 404, { ok: false, error: 'QR устарел' });
  if (Date.now() - s.created > TOKEN_TTL) { sessions.delete(token); return json(res, 404, { ok: false, error: 'QR устарел' }); }
  let body;
  try { body = await readBody(req, 16 * 1024); }
  catch (e) { return json(res, 500, { ok: false, error: 'Слишком длинное' }); }
  let text = '';
  try { text = (JSON.parse(body.toString('utf8') || '{}').text) || ''; }
  catch (e) { text = body.toString('utf8'); }
  const m = pushMsg(s, from, text);
  if (!m) return json(res, 400, { ok: false, error: 'Пусто' });
  return json(res, 200, { ok: true, n: s.msgs.length });
}

/* --- обратная передача ПК → телефон (1.2.0): файлы из окна/папки забираются
 * телефоном по ссылке. Раздаём ТОЛЬКО зарегистрированное в s.share (индексная
 * выдача — проход по путям невозможен конструктивно). Мёртвое вместе с сессией. */
const SHARE_MAX_FILES = 50;

function shareAdd(s, filePath) {
  let st;
  try { st = fs.statSync(filePath); } catch (e) { return null; }
  if (!st.isFile()) return null;
  const pro = isPro();
  const maxSize = pro ? 10 * 1024 * 1024 * 1024 : 60 * 1024 * 1024;
  if (st.size > maxSize || s.share.length >= SHARE_MAX_FILES) return null;
  const abs = path.resolve(filePath);
  if (s.share.some(e => e.path === abs)) return null; // уже раздаём
  const e = { id: 's' + (s.shareSeq++), name: path.basename(abs).slice(0, 120) || 'file', path: abs, size: st.size };
  s.share.push(e);
  return e;
}

// мелкие типы для отдачи; остальное — octet-stream (телефон всё равно качает в «Файлы»)
function shareMime(name) {
  const ext = path.extname(name || '').toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.txt') return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

function shareVisible(s) {
  // free-тариф: картинки — всем, остальное только Pro (зеркало правил заливки)
  if (isPro()) return s.share;
  return s.share.filter(e => isImageExt(path.extname(e.name).toLowerCase()));
}

function sharePub(list) {
  return list.map(e => ({ id: e.id, name: e.name, size: e.size }));
}

async function handleGet(req, res, token, id) {
  const s = sessions.get(token);
  if (!s) return json(res, 404, { ok: false, error: 'QR устарел' });
  if (Date.now() - s.created > TOKEN_TTL) { sessions.delete(token); return json(res, 404, { ok: false, error: 'QR устарел' }); }
  const e = s.share.find(x => x.id === id);
  if (!e) return json(res, 404, { ok: false, error: 'Нет такого файла' });
  let st;
  try { st = fs.statSync(e.path); if (!st.isFile()) throw new Error('gone'); }
  catch (err) { return json(res, 404, { ok: false, error: 'Файл убран' }); }
  // Range не поддерживаем (v1: скачать в «Файлы», а не стримить) — честный 200 целиком
  res.writeHead(200, {
    'Content-Type': shareMime(e.name),
    'Content-Length': st.size,
    'Content-Disposition': 'attachment; filename="' + encodeURIComponent(e.name).replace(/'/g, '%27') + '"',
  });
  fs.createReadStream(e.path).on('error', () => { try { res.destroy(); } catch (err2) {} }).pipe(res);
}

async function handleUpload(req, res, token) {
  const s = sessions.get(token);
  if (!s) return json(res, 404, { ok: false, error: 'QR устарел' });
  if (Date.now() - s.created > TOKEN_TTL) { sessions.delete(token); return json(res, 404, { ok: false, error: 'QR устарел' }); }

  // чанки больших файлов — мимо multipart (см. handleChunk)
  try {
    const u = new URL(req.url, 'http://x');
    if (u.searchParams.get('cid')) return handleChunk(req, res, token, u.searchParams);
  } catch (e) {}

  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('multipart/form-data')) return json(res, 400, { ok: false, error: 'Нет файла' });

  // Лимиты: free — фото до 60 МБ, Pro — файлы/видео до 10 ГБ.
  // Пишем потоком во временный файл — большие видео не висят в памяти.
  // Большие файлы идут чанками (см. handleChunk) — вкладка телефона не давится.
  const pro = isPro();
  const maxSize = pro ? 10 * 1024 * 1024 * 1024 : 60 * 1024 * 1024;
  const bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: maxSize } });
  let saved = null;
  let failed = null;
  let chunkResp = null; // ответ кусока (ok+chunk / ok+file / ошибка) — уходит как есть, мимо логики одиночных файлов
  let pending = Promise.resolve(); // ждём завершения записи файла
  const fields = {}; // поля формы; клиент шлёт их ПЕРЕД файлом — к началу 'file' уже на месте
  bb.on('field', (fname, val) => {
    if (['cid', 'i', 'n', 'name'].includes(fname)) fields[fname] = String(val).slice(0, 160);
  });

  bb.on('file', (name, stream, info) => {
    if (fields.cid) {
      // кусок в multipart-упаковке: для middlebox неотличим от обычного фото (урок 12.10).
      // Куски мелкие — буферим в память, дальше общее ядро ingestChunk.
      const bufs = [];
      let len = 0, tooBig = false;
      stream.on('data', c => {
        if (tooBig) return; // дальше только осушаем поток
        len += c.length;
        if (len > CHUNK_MAX) { tooBig = true; bufs.length = 0; } else bufs.push(c);
      });
      pending = new Promise(resolve => stream.on('end', async () => {
        if (tooBig) { failed = 'Кусок больше 32 МБ'; return resolve(); }
        const r = await ingestChunk(s, fields.cid, fields.i, fields.n, fields.name, Buffer.concat(bufs));
        chunkResp = r; // весь ответ куска — клиенту без перетолмачивания
        if (r.body.ok && r.body.file) saved = r.body.file;
        else if (!r.body.ok && r.body.chunk === undefined) failed = r.body.error;
        resolve();
      }));
      stream.on('limit', () => { failed = 'Кусок больше 32 МБ'; });
      return;
    }
    const tmp = path.join(os.tmpdir(), `pixport-${Date.now()}-${Math.random().toString(16).slice(2)}.part`);
    const out = fs.createWriteStream(tmp);
    stream.on('limit', () => { failed = pro ? 'Файл больше 10 ГБ' : 'Файл больше 60 МБ'; });
    stream.pipe(out);
    pending = new Promise(resolve => out.on('finish', async () => {
      if (failed) { try { fs.rmSync(tmp, { force: true }); } catch (e) {} return resolve(); }
      if (fs.statSync(tmp).size === 0) { // iOS iCloud: файл виден в пикере, но байты не скачаны — грузить нечего
        try { fs.rmSync(tmp, { force: true }); } catch (e) {}
        failed = 'empty';
        return resolve();
      }
      const r = await finishUpload(s, tmp, info.filename || 'photo.jpg');
      if (r.saved) saved = r.saved; else failed = r.failed;
      resolve();
    }));
    out.on('error', () => { failed = 'Ошибка записи'; });
  });

  bb.on('error', () => { failed = 'Ошибка чтения'; });
  bb.on('close', async () => {
    await pending; // боди прочитано — ждём, пока файл доедет до папки
    if (chunkResp) return json(res, chunkResp.code, chunkResp.body);
    if (failed) json(res, 500, { ok: false, error: failed });
    else if (saved) json(res, 200, { ok: true, file: saved, total: s.received });
    else json(res, 400, { ok: false, error: 'Файл не получен' });
  });

  req.pipe(bb);
}

// Расширения, которые пробуем декодировать как картинки (остальное в Pro идёт как есть)
function isImageExt(ext) {
  return ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.bmp', '.tiff', '.tif', '.heic', '.heif'].includes(ext);
}

/** Проверить папку и вернуть абсолютный путь. */
function resolveFolder(p) {
  if (!p) return null;
  const abs = path.resolve(p);
  try { if (fs.statSync(abs).isDirectory()) return abs; } catch (e) {}
  return null;
}

/* ------------------------------------------------- проверка обновлений */

function updateApiUrl() {
  // PIXPORT_UPDATE_URL — только для тестов (подмена GitHub стабом)
  return process.env.PIXPORT_UPDATE_URL ||
    `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
}

// GET JSON с таймаутом. http(s) выбираем по схеме — стаб в тестах обычный http.
function fetchJson(u, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const lib = String(u).startsWith('https') ? https : http;
    const req = lib.get(u, {
      headers: { 'User-Agent': 'PixPort', 'Accept': 'application/vnd.github+json' },
      timeout: timeoutMs,
    }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        try { resolve({ code: r.statusCode, data: JSON.parse(d) }); }
        catch (e) { reject(new Error('bad json')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// Сравнение версий вида '0.1.5': 1 если a>b, -1 если a<b, 0 если равны
function cmpVer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

// Свежая версия на GitHub новее нашей? Без сети — { ok:false }, молча.
async function checkUpdate() {
  try {
    const { code, data } = await fetchJson(updateApiUrl());
    if (code === 404) return { ok: false, error: 'empty' }; // репозиторий есть, релизов ещё нет
    if (code !== 200 || !data || !data.tag_name) return { ok: false, error: 'net' };
    const latest = String(data.tag_name).replace(/^v/, '');
    if (cmpVer(latest, APP_VERSION) <= 0)
      return { ok: true, update: false, current: APP_VERSION, latest };
    const asset = (data.assets || []).find(a => /^PixPort-Setup-.*\.exe$/.test(a.name || ''));
    const dl = (asset && asset.browser_download_url) || data.html_url || '';
    return { ok: true, update: true, current: APP_VERSION, latest, url: dl };
  } catch (e) {
    return { ok: false, error: 'net' };
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://x');
  const q = url.searchParams.get('t') || '';
  const s = q ? sessions.get(q) : null;

  /* --- только с localhost: управление --- */
  if (url.pathname === '/favicon.ico' && req.method === 'GET') {
    // эмблема во вкладках браузера (и на телефоне тоже) — токен не нужен
    try {
      const ico = fs.readFileSync(path.join(__dirname, 'assets', 'icon.ico'));
      res.writeHead(200, { 'Content-Type': 'image/x-icon', 'Cache-Control': 'public, max-age=86400' });
      return res.end(ico);
    } catch (e) { return json(res, 404, { ok: false }); }
  }
  if (url.pathname.startsWith('/assets/') && req.method === 'GET') {
    // статика для страниц: только png/ico без подпапок (basename режет ../)
    const f = path.basename(url.pathname);
    if (!/^[a-z0-9-]+\.(png|ico)$/.test(f)) return json(res, 404, { ok: false });
    try {
      const buf = fs.readFileSync(path.join(__dirname, 'assets', f));
      res.writeHead(200, {
        'Content-Type': f.endsWith('.png') ? 'image/png' : 'image/x-icon',
        'Cache-Control': 'public, max-age=86400',
      });
      return res.end(buf);
    } catch (e) { return json(res, 404, { ok: false }); }
  }
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
      return json(res, 200, { ok: true, received: s.received, folder: s.folder, msgN: s.msgs.length, msgs: s.msgs.slice(-50), share: sharePub(s.share), notes: s.files.filter(f => f.startsWith('note-')).length });
    }
    if (url.pathname === '/api/share' && req.method === 'POST') {
      // окно QR: кнопка/перетаскивание. Папки — обратно в старое поведение (QR для неё), файлы — в раздачу.
      if (!s) return json(res, 404, { ok: false });
      let paths = [];
      try { paths = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}').paths || []; }
      catch (e) { paths = []; }
      let folder = null;
      const added = [];
      for (const p of (Array.isArray(paths) ? paths : []).slice(0, 20)) {
        const abs = String(p || '');
        let st = null;
        try { st = fs.statSync(abs); } catch (e) { continue; }
        if (st.isDirectory()) { if (!folder && resolveFolder(abs)) folder = resolveFolder(abs); continue; }
        const e2 = shareAdd(s, abs);
        if (e2) added.push({ id: e2.id, name: e2.name, size: e2.size });
      }
      return json(res, 200, { ok: true, added, folder, share: sharePub(s.share) });
    }
    if (url.pathname === '/api/cleannotes' && req.method === 'POST') {
      // чистка записок сессии с диска (только note-*.txt, созданные ей же — чужое не трогаем)
      if (!s) return json(res, 404, { ok: false });
      let removed = 0;
      const keep = [];
      for (const f of s.files) {
        if (f.startsWith('note-') && f.endsWith('.txt')) {
          try { fs.rmSync(path.join(s.folder, f), { force: true }); removed++; }
          catch (e) { keep.push(f); }
        } else keep.push(f);
      }
      s.files = keep;
      return json(res, 200, { ok: true, removed });
    }
    if (url.pathname === '/api/unshare' && req.method === 'POST') {      if (!s) return json(res, 404, { ok: false });
      let id = '';
      try { id = String(JSON.parse((await readBody(req, 4 * 1024)).toString('utf8') || '{}').id || ''); }
      catch (e) {}
      s.share = s.share.filter(e => e.id !== id);
      return json(res, 200, { ok: true, share: sharePub(s.share) });
    }
    if (url.pathname === '/api/msg' && req.method === 'POST') {
      // ПК → телефон: окно QR шлёт через localhost, телефон забирает опросом ?msgs
      return handleMsg(req, res, q, 'pc');
    }
    if (url.pathname === '/api/close') {
      if (s) sessions.delete(q);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/qr') {
      if (!s) return json(res, 404, { ok: false });
      // адрес можно выбрать в окне (несколько сетей); чужой IP не принимаем
      const want = url.searchParams.get('ip');
      const ip = lanIps().includes(want) ? want : lanIp();
      // язык окна едет в ссылку — телефон откроется сразу на нём
      const lang = url.searchParams.get('lang') === 'en' ? '&lang=en' : '';
      const link = `http://${ip}:${PORT}/u?t=${q}${lang}`;
      const data = await QRCode.toDataURL(link, { width: 560, margin: 1, errorCorrectionLevel: 'M' });
      return json(res, 200, data);
    }
    if (url.pathname === '/api/ips') {
      if (!s) return json(res, 404, { ok: false });
      return json(res, 200, { ips: lanIps(), current: lanIp() });
    }
    if (url.pathname === '/api/open') {
      if (s) openInBrowser(s.folder);
      return json(res, 200, { ok: true });
    }
    /* --- подписка: статус и активация ключа --- */
    if (url.pathname === '/api/license' && req.method === 'GET') {
      const st = licenseState();
      return json(res, 200, { ok: true, pro: st.pro, key: st.key || null, hwid: machineId() });
    }
    if (url.pathname === '/api/license' && req.method === 'POST') {
      const body = await readBody(req, 4 * 1024).catch(() => Buffer.alloc(0));
      let key = '';
      try { key = JSON.parse(body.toString('utf8') || '{}').key || ''; } catch (e) {}
      const r = activateKey(key);
      return json(res, r.ok || r.pro ? 200 : 400, r);
    }
    if (url.pathname === '/api/license/off' && req.method === 'POST') {
      return json(res, 200, clearLicense());
    }
    /* --- обновления: есть ли релиз новее на GitHub --- */
    if (url.pathname === '/api/update' && req.method === 'GET') {
      return json(res, 200, await checkUpdate());
    }
    if (url.pathname === '/') {
      // окно QR: принимает папку через query, иначе последняя сессия
      const folder = resolveFolder(url.searchParams.get('folder')) ||
                     (s ? s.folder : [...sessions.values()].at(-1)?.folder);
      if (!folder) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><script>(function(){try{var t=localStorage.getItem('pixport-theme');if(t)document.documentElement.dataset.theme=t;}catch(e){}})();</script><style>
:root{color-scheme:light;--bg:#f2f4fb;--card:#fff;--ink:#181b2e;--muted:#6d7394;--line:#e3e7f4;--brand:#3d52f0;--brand-ink:#fff;--soft:#edf0ff;--ok:#1d9e57;--err:#cf3a3a;--shadow:0 10px 30px rgba(35,45,110,.10)}
[data-theme="dark"]{color-scheme:dark;--bg:#0d0d0f;--card:#161619;--ink:#f0f0f2;--muted:#8e8e96;--line:#2a2a2e;--brand:#4d5ff0;--brand-ink:#fff;--soft:#1f1f24;--ok:#6ee7a0;--err:#ff8f8f;--shadow:0 12px 40px rgba(0,0,0,.6)}
*{margin:0;padding:0;box-sizing:border-box}
*,*::before,*::after{transition:background-color .3s ease,color .3s ease,border-color .3s ease,box-shadow .3s ease}
html,body{height:100%}
body{margin:0;font-family:system-ui;background:var(--bg);color:var(--ink);min-height:100vh;
display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:30px;text-align:center;overflow:hidden}
.top{width:100%;max-width:380px;display:flex;align-items:center;justify-content:space-between}
.logo{font-size:12px;letter-spacing:4px;text-transform:uppercase;color:var(--brand);font-weight:800}
#themeBtn{width:36px;height:36px;aspect-ratio:1/1;padding:0;flex:0 0 auto;border-radius:50%;border:1px solid var(--line);overflow:hidden;background:var(--card);font-size:16px;cursor:pointer;box-shadow:var(--shadow);display:inline-flex;align-items:center;justify-content:center;line-height:1}
#planBadgeTop{position:absolute;left:100%;bottom:-3px;margin-left:7px;font-size:9px;font-weight:800;letter-spacing:1.5px;padding:2px 7px;border-radius:999px}
#planBadgeTop.free{background:var(--soft);color:var(--muted);border:1px solid var(--line)}
#planBadgeTop.pro{background:var(--brand);color:var(--brand-ink)}
.card{background:var(--card);border:1px solid var(--line);border-radius:24px;padding:30px 28px;display:flex;flex-direction:column;align-items:center;gap:14px;box-shadow:var(--shadow);max-width:380px}
h2{font-size:20px;margin:0}p{color:var(--muted);font-size:14px;margin:0;max-width:340px;line-height:1.5}
button{font-size:16px;font-weight:700;padding:14px 26px;border-radius:14px;border:0;
background:var(--brand);color:var(--brand-ink);cursor:pointer}button:active{transform:scale(.97)}
</style></head><body>
<div class="top"><div class="logo" style="position:relative">PixPort<span id="planBadgeTop" class="${isPro() ? 'pro' : 'free'}">${isPro() ? 'PRO' : 'FREE'}</span></div><button id="themeBtn" title="Тёмная / светлая тема">🌙</button></div>
<div class="card">
<h2 data-i="pickTitle">Выбери папку для фото</h2>
<p data-i-html="pickDesc">Нажми кнопку ниже или перетащи папку в это окно.<br>Потом наведи камеру телефона на QR-код.</p>
<button id="b" data-i="btn_choose">📁 Выбрать папку</button>
<button id="sbtn" style="display:none;background:var(--soft);color:var(--ink);border:1px solid var(--line);font-size:14px;padding:10px 20px" data-i="btn_settings">⚙ Настройки</button>
<div style="font-size:11px;color:var(--muted)">PixPort v${APP_VERSION}</div>
</div>
<div id="setOverlay" style="display:none;position:fixed;inset:0;background:rgba(15,18,40,.5);align-items:center;justify-content:center;padding:24px;z-index:10">
<div style="background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:20px;box-shadow:var(--shadow);max-width:400px;width:100%;padding:24px 22px;text-align:left;max-height:calc(100vh - 48px);overflow:auto">
<div style="font-size:17px;font-weight:800;margin-bottom:12px" data-i="setTitle">⚙ Настройки</div>
<div style="font-size:14px;font-weight:700;margin-bottom:8px" data-i="langTitle">Язык / Language</div>
<div style="margin-bottom:14px">
<button data-lang-btn="ru" onclick="setLang('ru')" style="font-size:14px;font-weight:700;padding:8px 18px;border-radius:10px;cursor:pointer;border:1px solid var(--line);background:var(--soft);color:var(--ink)">RU</button>
<button data-lang-btn="en" onclick="setLang('en')" style="font-size:14px;font-weight:700;padding:8px 18px;border-radius:10px;cursor:pointer;border:1px solid var(--line);background:var(--soft);color:var(--ink)">EN</button>
</div>
<div style="font-size:14px;font-weight:700;margin-bottom:8px" data-i="subTitle">Подписка PixPort</div>
<div style="font-size:13px;color:var(--muted);line-height:1.55;margin-bottom:10px" id="subDesc" data-i="subDescFree">Бесплатно: фото до 960 px со сжатием. С ключом Pro — оригинальное качество без ограничений.</div>
<div style="display:flex;gap:8px;margin-bottom:8px" id="subRow">
<input id="subKey" placeholder="PP-XXXXXX-XXXXXX-XXXXXX" style="flex:1;min-width:0;font-size:13px;padding:9px 12px;border-radius:10px;border:1px solid var(--line);background:var(--soft);color:var(--ink);font-family:ui-monospace,monospace">
<button id="subBtn" style="font-size:13px;padding:9px 16px" data-i="subBtn">Активировать</button>
</div>
<div id="subMsg" style="font-size:13px;min-height:18px;margin-bottom:6px"></div>
<div id="subKeyShow" style="display:none;font-size:13px;margin-bottom:10px;background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:9px 12px">
<div style="color:var(--muted);margin-bottom:6px" data-i="subKeySaved">Сохраните ключ — пригодится при переустановке:</div>
<div style="display:flex;gap:8px;align-items:center">
<code id="subKeyText" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:12px;color:var(--ink)"></code>
<button id="subCopy" style="font-size:12px;padding:7px 12px;flex:0 0 auto" data-i="copyBtn">Копировать</button>
</div>
</div>
<div style="font-size:12px;color:var(--muted);margin-bottom:10px"><span data-i="pcCodeHint">Код этого ПК для именного ключа — пришли его в поддержку вместе с оплатой:</span><br><code id="pcCode" style="font-size:12px;color:var(--ink)">…</code> <button id="pcCopy" style="font-size:12px;padding:5px 10px" data-i="copyBtn">Копировать</button></div>
<div style="font-size:14px;font-weight:700;margin-bottom:8px" data-i="updTitle">Обновления</div>
<div style="font-size:13px;color:var(--muted);line-height:1.55;margin-bottom:10px" id="updStatus" data-i="updIdle">Нажми «Проверить» — сравним твою версию с GitHub.</div>
<div style="display:flex;gap:8px;margin-bottom:14px">
<button id="updBtn" style="font-size:13px;padding:9px 16px" data-i="updCheck">Проверить</button>
<button id="updDl" style="display:none;font-size:13px;padding:9px 16px" data-i="updDl">Скачать</button>
</div>
<label style="display:flex;align-items:center;gap:10px;font-size:14px;margin-bottom:14px;cursor:pointer">
<input type="checkbox" id="autoChk" style="width:18px;height:18px;accent-color:var(--brand)">
<span data-i="autoStart">Запускаться вместе с Windows</span>
</label>
<div style="font-size:14px;font-weight:700;margin-bottom:8px" data-i="menuTitle">Пункт в меню проводника</div>
<div style="font-size:13px;color:var(--muted);line-height:1.55;margin-bottom:12px" data-i="menuDesc">Добавляет «Показать QR» в правый клик по папке. Трогать нужно один раз — дальше оно просто работает.</div>
<button id="mb" style="display:none;background:var(--soft);color:var(--ink);border:1px solid var(--line);font-size:14px;padding:10px 20px" data-i="menuBtnAdd">В меню проводника</button>
<div id="ms" style="color:var(--ok);font-size:13px;min-height:18px;margin-top:8px"></div>
<div style="font-size:11px;color:var(--muted);margin-top:6px">PixPort v${APP_VERSION}</div>
<div style="text-align:right;margin-top:14px"><button id="setOk" style="font-size:14px" data-i="btn_done">Готово</button></div>
</div>
</div>
<button id="helpLink" style="background:none;border:0;color:var(--muted);font-size:12.5px;cursor:pointer;text-decoration:underline;text-underline-offset:3px;padding:4px 8px" data-i="helpLink">Как пользоваться</button>
<div id="helpOverlay" style="display:none;position:fixed;inset:0;background:rgba(15,18,40,.5);align-items:center;justify-content:center;padding:24px;z-index:10">
<div style="background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:20px;box-shadow:var(--shadow);max-width:400px;width:100%;padding:24px 22px;text-align:left;max-height:calc(100vh - 48px);overflow:auto">
<div style="font-size:17px;font-weight:800;margin-bottom:12px" data-i="helpTitle">Как пользоваться PixPort</div>
<ol style="margin:0 0 6px 20px;font-size:14px;line-height:1.65">
<li data-i-html="help1"><b>Выбери папку</b> — кнопкой, перетаскиванием в окно, правым кликом в проводнике или <b>Ctrl+Alt+Q</b> в открытой папке.</li>
<li data-i-html="help2"><b>Наведи камеру телефона</b> на QR-код.</li>
<li data-i-html="help3"><b>Сними фото</b> или выбери из галереи — оно сразу окажется в папке на компьютере.</li>
</ol>
<div style="font-size:12.5px;color:var(--muted);line-height:1.6;margin-top:8px" data-i="helpNote">Телефон и компьютер должны быть в одном Wi-Fi (нет роутера — раздай точку доступа с телефона, тоже сработает). QR-код живёт 30 минут. Закрытие окна сворачивает программу в трей — хоткей продолжает работать. Телефон не открывает страницу? Разреши PixPort в брандмауэре Windows (порт 8765).</div>
<div style="text-align:right;margin-top:14px"><button id="helpOk" style="font-size:14px" data-i="btn_ok">Понятно</button></div>
</div>
</div>
<div id="wnOverlay" style="display:none;position:fixed;inset:0;background:rgba(15,18,40,.5);align-items:center;justify-content:center;padding:24px;z-index:20">
<div style="background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:20px;box-shadow:var(--shadow);max-width:400px;width:100%;padding:24px 22px;text-align:left;max-height:calc(100vh - 48px);overflow:auto">
<div style="font-size:17px;font-weight:800;margin-bottom:12px"><span data-i="whatsTitle">Что нового</span> · v${APP_VERSION}</div>
<div id="wnBodyRu" style="font-size:14px;line-height:1.65">${whatsnew('ru')}</div>
<div id="wnBodyEn" style="display:none;font-size:14px;line-height:1.65">${whatsnew('en')}</div>
<div style="text-align:right;margin-top:14px"><button id="wnOk" style="font-size:14px" data-i="btn_ok">Понятно</button></div>
</div>
</div>
<script>
(function(){function s(){var d=document.documentElement.dataset.theme==='dark';document.getElementById('themeBtn').textContent=d?'☀️':'🌙';}
document.getElementById('themeBtn').onclick=function(){var d=document.documentElement.dataset.theme!=='dark';document.documentElement.dataset.theme=d?'dark':'light';try{localStorage.setItem('pixport-theme',d?'dark':'light');}catch(e){}s();};s();
var ov=document.getElementById('helpOverlay');
document.getElementById('helpLink').onclick=function(){ov.style.display='flex';};
document.getElementById('helpOk').onclick=function(){ov.style.display='none';};
ov.onclick=function(e){if(e.target===ov)ov.style.display='none';};
(function(){var k='pixport-wn-seen';var seen=null;try{seen=localStorage.getItem(k);}catch(e){}
var wov=document.getElementById('wnOverlay');
var ru=document.getElementById('wnBodyRu'),en=document.getElementById('wnBodyEn');
var isEn=(typeof __LANG!=='undefined'&&__LANG==='en');
if(ru&&en){ru.style.display=isEn?'none':'';en.style.display=isEn?'':'none';}
function whide(){wov.style.display='none';try{localStorage.setItem(k,'${APP_VERSION}');}catch(e){}}
document.getElementById('wnOk').onclick=whide;
wov.onclick=function(e){if(e.target===wov)whide();};
if(seen!=='${APP_VERSION}')wov.style.display='flex';})();})();
</script>
<script>${LANG_DICT_JS}</script>
<script>${LANG_JS}</script>
<script>applyLang(__LANG);</script>
<script>
if (window.pixport) {
  document.getElementById('b').onclick = async () => {
    const p = await window.pixport.pickFolder();
    if (p) location.href = '/?folder=' + encodeURIComponent(p);
  };

  // пункт контекстного меню — в Настройках, чтобы не жали случайно
  const sb = document.getElementById('sbtn');
  sb.style.display = '';
  const mb = document.getElementById('mb'), ms = document.getElementById('ms');
  const sov = document.getElementById('setOverlay');
  sb.onclick = async () => { sov.style.display = 'flex'; mb.style.display = ''; sync(); };
  document.getElementById('setOk').onclick = () => { sov.style.display = 'none'; };
  sov.onclick = e => { if (e.target === sov) sov.style.display = 'none'; };
  async function sync() {
    const on = await window.pixport.menuStatus();
    mb.dataset.on = on ? '1' : '';
    mb.textContent = on ? t('menuBtnDel') : t('menuBtnAdd');
  }
  mb.onclick = async () => {
    const removing = mb.dataset.on === '1'; // состояние, а не текст — текст зависит от языка
    mb.disabled = true; mb.textContent = t('wait');
    const r = removing ? await window.pixport.menuRemove() : await window.pixport.menuInstall();
    ms.textContent = r && r.ok
      ? (removing ? t('menu_removed_short') : t('menu_added_short'))
      : t('menu_fail') + ((r && r.error) || t('unknown'));
    ms.style.color = r && r.ok ? 'var(--ok)' : 'var(--err)';
    mb.disabled = false; sync();
  };

  // --- подписка ---
  const subBtn = document.getElementById('subBtn');
  const subMsg = document.getElementById('subMsg');
  function showSavedKey2(key) {
    const box = document.getElementById('subKeyShow');
    if (!box) return;
    if (key) {
      document.getElementById('subKeyText').textContent = key;
      box.style.display = '';
    } else {
      box.style.display = 'none';
    }
  }
  document.getElementById('subCopy').onclick = async () => {
    const key = document.getElementById('subKeyText').textContent || '';
    if (!key) return;
    try { await navigator.clipboard.writeText(key); }
    catch (e) {
      const ta = document.createElement('textarea');
      ta.value = key; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (e2) {}
      ta.remove();
    }
    const b = document.getElementById('subCopy');
    const old = b.textContent;
    b.textContent = t('copied');
    setTimeout(() => { b.textContent = old; }, 1500);
  };
  document.getElementById('pcCopy').onclick = async () => {
    const code = document.getElementById('pcCode').textContent || '';
    if (!code || code === '…') return;
    try { await navigator.clipboard.writeText(code); }
    catch (e) {
      const ta = document.createElement('textarea');
      ta.value = code; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (e2) {}
      ta.remove();
    }
    const b = document.getElementById('pcCopy');
    const old = b.textContent;
    b.textContent = t('copied');
    setTimeout(() => { b.textContent = old; }, 1500);
  };
  async function subSync() {
    try {
      const st = await (await fetch('/api/license')).json();
      paintSub(!!st.pro, st.key || null);
      if (st.hwid) document.getElementById('pcCode').textContent = st.hwid;
    } catch (e) {}
  }
  function paintSub(pro, key) {
    const desc = document.getElementById('subDesc');
    desc.dataset.i = pro ? 'subDescPro' : 'subDescFree';
    desc.textContent = t(desc.dataset.i);
    document.getElementById('subRow').style.display = pro ? 'none' : 'flex';
    subBtn.dataset.on = pro ? '1' : '';
    subBtn.dataset.i = pro ? 'subBtnOff' : 'subBtn'; // data-i, а не голый текст — иначе смена языка сотрёт состояние
    subBtn.textContent = t(subBtn.dataset.i);
    showSavedKey2(pro ? (key || null) : null);
    const pb = document.getElementById('planBadgeTop'); // бейдж у логотипа
    if (pb) { pb.textContent = pro ? 'PRO' : 'FREE'; pb.className = pro ? 'pro' : 'free'; }
  }
  subBtn.onclick = async () => {
    const pro = subBtn.dataset.on === '1';
    if (pro) {
      await fetch('/api/license/off', { method: 'POST' });
      subMsg.style.color = 'var(--muted)';
      subMsg.textContent = t('subOff');
      paintSub(false, null);
      return;
    }
    subBtn.disabled = true;
    try {
      const typed = document.getElementById('subKey').value.trim();
      const r = await fetch('/api/license', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: typed })
      });
      const s = await r.json();
      if (s.ok || s.pro) { subMsg.style.color = 'var(--ok)'; subMsg.textContent = t('subOk'); paintSub(true, s.key || typed); }
      else { subMsg.style.color = 'var(--err)'; subMsg.textContent = t('subBad'); }
    } catch (e) { subMsg.style.color = 'var(--err)'; subMsg.textContent = t('subBad'); }
    subBtn.disabled = false;
  };
  subSync();

  // --- обновления с GitHub ---
  const updBtn = document.getElementById('updBtn');
  const updDl = document.getElementById('updDl');
  const updStatus = document.getElementById('updStatus');
  let updUrl = '';
  async function updCheck(silent) {
    if (!silent) { updBtn.disabled = true; updStatus.textContent = t('wait'); }
    try {
      const r = await (await fetch('/api/update')).json();
      if (!r.ok) { if (!silent) updStatus.textContent = t(r.error === 'empty' ? 'updEmpty' : 'updFail'); }
      else if (r.update) {
        updStatus.textContent = t('updAvailable', { v: r.latest });
        updUrl = r.url || '';
        updDl.style.display = '';
      } else {
        updStatus.textContent = t('updLatest', { v: r.current });
        updDl.style.display = 'none';
      }
    } catch (e) { if (!silent) updStatus.textContent = t('updFail'); }
    updBtn.disabled = false;
  }
  updBtn.onclick = () => updCheck(false);
  updDl.onclick = () => {
    if (!updUrl) return;
    if (window.pixport && window.pixport.openUrl) window.pixport.openUrl(updUrl);
    else location.href = updUrl;
  };
  updCheck(true); // тихая проверка при открытии окна

  // --- автозапуск ---
  const autoChk = document.getElementById('autoChk');
  (async () => { try { autoChk.checked = !!(await window.pixport.autostartStatus()); } catch (e) {} })();
  autoChk.onchange = async () => {
    const r = await window.pixport.autostartSet(autoChk.checked).catch(() => null);
    if (!r || !r.ok) autoChk.checked = !autoChk.checked; // не вышло — вернуть как было
  };

  sync();

  window.__fitSoon = () => setTimeout(fitWin, 50);
  fitWin(); // окно ровно под контент, без скролла
  setTimeout(fitWin, 1200); // добор после устаканивания шрифтов

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
  document.querySelector('p').innerHTML = t('nofolder');
}
</script></body></html>`);
      }
      const token = createSession(folder);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      const ip = lanIp();
      return res.end(qrPage(token, folder, { ok: ip !== '127.0.0.1', ip }));
    }
  }

  /* --- для телефона --- */
  if (url.pathname === '/u') {
    if (!s) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<p style="font-family:sans-serif;padding:40px">Ссылка устарела. Покажи QR на компьютере ещё раз.</p>');
    }
    if (req.method === 'GET' && url.searchParams.has('ping')) return json(res, 200, { ok: true, ts: Date.now() });
    if (req.method === 'GET' && url.searchParams.has('state')) {
      const u = uploads.get(String(url.searchParams.get('cid') || ''));
      if (!u) return json(res, 200, { ok: false, got: 0 });
      return json(res, 200, { ok: true, got: u.got, n: u.n });
    }
    if (req.method === 'POST' && url.searchParams.has('msg')) return handleMsg(req, res, q, 'phone');
    if (req.method === 'GET' && url.searchParams.has('msgs')) {
      const since = Math.max(0, parseInt(url.searchParams.get('since') || '0', 10) || 0);
      return json(res, 200, { ok: true, msgs: s.msgs.slice(since), n: s.msgs.length });
    }
    if (req.method === 'GET' && url.searchParams.has('share')) {
      return json(res, 200, { ok: true, items: sharePub(shareVisible(s)) });
    }
    if (req.method === 'GET' && url.searchParams.has('get')) {
      return handleGet(req, res, q, String(url.searchParams.get('get') || ''));
    }
    if (req.method === 'POST') return handleUpload(req, res, q);
    // no-store: телефон не должен подсовывать закэшированную страницу старой версии
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    const lang = url.searchParams.get('lang') === 'en' ? 'en' : 'ru';
    return res.end(uploadPage(q, path.basename(s.folder), lang));
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

module.exports = { start, lanIp, lanIps, PORT, resolveFolder, APP_VERSION, UPDATE_REPO, PRO_PAY_URL };
