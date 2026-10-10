/**
 * PixPort Pro — офлайн-проверка лицензионного ключа.
 *
 * Как это работает:
 *  - ключ вида PP-XXXXXX-XXXXXX-XXXXXX: 5 байт «тела» + 6 байт подписи HMAC;
 *  - подпись считается секретом из этого файла, проверяется при вводе —
 *    никакого сервера, интернета и регистрации не нужно, активация мгновенная;
 *  - активация сохраняется в %APPDATA%\PixPort\license.json и переживает
 *    переустановку (пока файл на месте — Pro остаётся).
 *
 * Честное ограничение (так и пишем в лог): собранное приложение — обычные
 * JS-файлы, значит секрет и проверка читаются. Это защита от «просто раздать
 * друзьям ключ из интернета», НЕ от правки кода. Кто полез — тот правит
 * server.js. Если продукт заживёт — переезжаем на серверную проверку.
 *
 * Генерация ключей: node genkey.js (файл в сборку не едет).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Секрет HMAC. Не путать с паролем — это «печать», а не хранение данных.
const SECRET = 'a7f31c9d4b8e2f6051d7c3a98b46e2f15c8d0b7392ae64f1d5c2a8e9b3f70416';

const PREFIX = 'PP';
// 32 символа, без I/O/0/1/U — чтобы ключ можно было продиктовать вслух
// и не перепутать похожие знаки. Основание ровно 32 → биты ложатся без потерь.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const BODY_BYTES = 5;   // 40 бит — уникальность ключа
const SIG_BYTES = 6;    // 48 бит подписи — подделать вслепую нереально

/* ----------------------------------------------------------- кодирование */

function b32encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) {
    val = (val << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(val >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(val << (5 - bits)) & 31];
  return out;
}

function b32decode(s) {
  let bits = 0, val = 0;
  const out = [];
  for (const c of s) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) return null;
    val = (val << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((val >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function sign(body) {
  return crypto.createHmac('sha256', SECRET).update(body).digest().subarray(0, SIG_BYTES);
}

function normalize(key) {
  return String(key || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function format(body, sig) {
  const raw = b32encode(body) + b32encode(sig); // 18 символов
  return `${PREFIX}-${raw.slice(0, 6)}-${raw.slice(6, 12)}-${raw.slice(12, 18)}`;
}

/* ------------------------------------------------------------- операции */

/** Создать новый ключ (нужен genkey.js / тестам). */
function mintKey() {
  const body = crypto.randomBytes(BODY_BYTES);
  return format(body, sign(body));
}

/**
 * Проверить ключ. true/false, без сообщений — что именно не так,
 * злоумышленнику знать не нужно.
 */
function validateKey(key) {
  const raw = normalize(key);
  if (!raw.startsWith(PREFIX)) return false;
  const payload = raw.slice(PREFIX.length);
  if (payload.length !== 18) return false;
  const decoded = b32decode(payload);
  if (!decoded) return false;
  const body = decoded.subarray(0, BODY_BYTES);
  const sig = decoded.subarray(BODY_BYTES, BODY_BYTES + SIG_BYTES);
  if (body.length !== BODY_BYTES || sig.length !== SIG_BYTES) return false;
  const expect = sign(body);
  return sig.length === expect.length && crypto.timingSafeEqual(sig, expect);
}

/* ----------------------------------------------------- хранение состояния */

function licenseFile() {
  if (process.env.PIXPORT_LICENSE_FILE) return process.env.PIXPORT_LICENSE_FILE;
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'PixPort', 'license.json');
}

/** Текущее состояние: { pro: bool, key: string|null } */
function licenseState() {
  try {
    const s = JSON.parse(fs.readFileSync(licenseFile(), 'utf8'));
    if (s && s.key && validateKey(s.key)) return { pro: true, key: s.key };
  } catch (e) { /* файла нет или битый — значит бесплатный режим */ }
  return { pro: false, key: null };
}

function isPro() {
  return licenseState().pro;
}

/** Активировать ключ. Валиден → сохраняем и включаем Pro. */
function activateKey(key) {
  if (!validateKey(key)) return { ok: false, ...licenseState() };
  const clean = PREFIX + '-' + normalize(key).slice(PREFIX.length).match(/.{1,6}/g).join('-');
  try {
    const file = licenseFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ key: clean, since: new Date().toISOString() }, null, 2));
  } catch (e) {
    return { ok: false, error: e.message, ...licenseState() };
  }
  return { ok: true, ...licenseState() };
}

/** Снять активацию (для тестов и кнопки «Отключить»). */
function clearLicense() {
  try { fs.rmSync(licenseFile(), { force: true }); } catch (e) {}
  return licenseState();
}

module.exports = { mintKey, validateKey, licenseState, isPro, activateKey, clearLicense };
