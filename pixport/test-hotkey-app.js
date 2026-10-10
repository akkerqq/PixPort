/**
 * Тест горячей клавиши PixPort вживую.
 *
 * Схема: открываем папку в проводнике, ставим её в фокус, запускаем
 * приложение, шлём ГЛОБАЛЬНО Ctrl+Alt+Q и проверяем, что окно PixPort
 * открылось именно с этой папкой (в URL).
 *
 * Работает и для dev, и для собранной версии:
 *   node test-hotkey-app.js --packed
 */
const { execFileSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const PACKED = process.argv.includes('--packed');
const ok = [], bad = [];
const check = (n, c, x = '') => (c ? ok : bad).push(n + (x ? ' -> ' + x : ''));

function ps(script) {
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  return execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64],
    { encoding: 'utf8', stdio: 'pipe' }).trim();
}

const FOCUS = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class FG3 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] public static extern void keybd_event(byte v, byte s, uint f, UIntPtr e);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
'@
$h = [IntPtr]([int]$env:FG_HWND)
[FG3]::keybd_event(0x12,0,0,[UIntPtr]::Zero); [FG3]::keybd_event(0x12,0,2,[UIntPtr]::Zero)
$fgT = [FG3]::GetWindowThreadProcessId([FG3]::GetForegroundWindow(), [IntPtr]::Zero)
$myT = [FG3]::GetCurrentThreadId()
[void][FG3]::AttachThreadInput($myT,$fgT,$true)
[void][FG3]::SetForegroundWindow($h)
[void][FG3]::AttachThreadInput($myT,$fgT,$false)
Start-Sleep -Milliseconds 400
if ([FG3]::GetForegroundWindow() -eq $h) { 'FOCUSED' } else { 'NOFOCUS' }
`;

/** Глобальная отправка Ctrl+Alt+Q.
 * SendInput не берём сознательно: размер структуры INPUT на x64 = 40 байт
 * (union обязан включать MOUSEINPUT), а его легко получить неверным —
 * SendInput молча вернёт 0. keybd_event того же результата проще.
 */
const SENDKEY = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class SK2 {
  [DllImport("user32.dll")] public static extern void keybd_event(byte v, byte s, uint f, UIntPtr e);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int v);
}
'@
$VK_CONTROL = 0x11; $VK_MENU = 0x12; $VK_Q = 0x51
# down: Ctrl, Alt, Q
[SK2]::keybd_event($VK_CONTROL,0,0,[UIntPtr]::Zero)
[SK2]::keybd_event($VK_MENU,0,0,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 50
[SK2]::keybd_event($VK_Q,0,0,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 60
$seen = ([SK2]::GetAsyncKeyState($VK_Q) -band 0x8000) -ne 0
# up: Q, Alt, Ctrl
[SK2]::keybd_event($VK_Q,0,2,[UIntPtr]::Zero)
[SK2]::keybd_event($VK_MENU,0,2,[UIntPtr]::Zero)
[SK2]::keybd_event($VK_CONTROL,0,2,[UIntPtr]::Zero)
if ($seen) { 'Q WAS DOWN' } else { 'Q NOT DOWN' }
`;

function openWindow(dir) {
  ps(`if (-not (Test-Path '${dir.replace(/'/g, "''")}')) { New-Item -ItemType Directory -Force -Path '${dir.replace(/'/g, "''")}' | Out-Null }
      Start-Process explorer.exe -ArgumentList '${dir.replace(/'/g, "''")}'
      Start-Sleep -Milliseconds 1500`);
  return ps(`
$hwnd = 0
foreach ($w in (New-Object -ComObject Shell.Application).Windows()) {
  try { if ($w -and $w.Document.Folder.Self.Path -eq '${dir.replace(/'/g, "''")}') { $hwnd = $w.HWND } } catch {}
}
$hwnd`);
}

function pageText(url) {
  return new Promise(res => {
    http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); })
      .on('error', () => res(''));
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const target = path.join(path.dirname(__dirname), 'hotkey-тест-папка');
  const diag = path.join(os.tmpdir(), 'pixport-diag.log');
  try { fs.unlinkSync(diag); } catch (e) {}

  // 1. папка в проводнике + фокус
  const hwnd = openWindow(target);
  check('окно проводника открылось', Number(hwnd) > 0, `hwnd=${hwnd}`);
  if (Number(hwnd) > 0) {
    const f = ps(`$env:FG_HWND='${hwnd}'\n` + FOCUS);
    check('проводник в фокусе', f === 'FOCUSED', f);
  }

  // 2. запуск приложения
  let exe, args;
  if (PACKED) {
    exe = path.join(__dirname, 'dist', 'PixPort-win32-x64', 'PixPort.exe');
    args = [];
  } else {
    exe = path.join(__dirname, 'node_modules', 'electron', 'dist', 'electron.exe');
    args = [__dirname];
  }
  check('exe существует', fs.existsSync(exe), exe);
  if (!fs.existsSync(exe)) { console.log('нет exe'); process.exit(1); }

  const child = spawn(exe, args, { detached: false, stdio: 'ignore' });
  await sleep(PACKED ? 9000 : 7000);

  // 3. ждём, пока проводник опять в фокусе (запуск exe мог украсть фокус)
  if (Number(hwnd) > 0) ps(`$env:FG_HWND='${hwnd}'\n` + FOCUS);

  // 4. ГЛОБАЛЬНО Ctrl+Alt+Q
  const sent = ps(SENDKEY);
  console.log('  отправка хоткея:', sent);
  await sleep(4500);

  // 5. проверяем страницу: есть ли папка в загрузке
  const html = await pageText('http://127.0.0.1:8765/');
  const wanted = encodeURIComponent(target);
  check('сервер отвечает', html.length > 0, `длина=${html.length}`);

  // страница внутри окна могла смениться — смотрим diag-лог на смену URL
  let logTxt = '';
  try { logTxt = fs.readFileSync(diag, 'utf8'); } catch (e) {}
  check('хоткей обработан (лог)', /хоткей/i.test(logTxt), logTxt.split('\n').filter(l => /хоткей/i.test(l)).join(' | '));
  check('папка подхвачена', logTxt.includes(encodeURIComponent(target)) || logTxt.includes(target),
        logTxt.split('\n').filter(l => l.includes('папка из проводника')).join(' | '));

  try { child.kill(); } catch (e) {}
  ps(`Get-Process explorer -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } |
      Where-Object { $_.MainWindowTitle -like '*hotkey*' } | ForEach-Object { $_.CloseMainWindow() | Out-Null }`);

  console.log('\nПРОЙДЕНО:'); ok.forEach(o => console.log('  OK   ' + o));
  if (bad.length) { console.log('ПРОВАЛЕНО:'); bad.forEach(b => console.log('  FAIL ' + b)); }
  console.log(`\nИтог: ${ok.length} ок, ${bad.length} провалено`);
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('ОШИБКА:', e.stack || e.message); process.exit(1); });
