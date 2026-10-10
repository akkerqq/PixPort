/**
 * Тест hotkey.js: ставит НАСТОЯЩЕЕ окно проводника в фокус и проверяет,
 * что модуль возвращает именно его папку.
 *
 * Ключевой кейс — кириллица в пути («игра» на рабочем столе Аккера).
 * Окна открываем через PowerShell Start-Process: node spawn с
 * кириллическим путём окно не открывает (проверили — уезжает в Documents).
 */
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { currentExplorerFolder } = require('./hotkey.js');

const ok = [], bad = [];
const check = (name, cond, detail = '') =>
  (cond ? ok : bad).push(name + (detail ? ' -> ' + detail : ''));

function ps(script) {
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  return execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64],
    { encoding: 'utf8', stdio: 'pipe' }).trim();
}

/** Открыть папку в проводнике и вернуть hwnd её окна. */
function openWindow(dir) {
  ps(`if (-not (Test-Path '${dir.replace(/'/g, "''")}')) { New-Item -ItemType Directory -Force -Path '${dir.replace(/'/g, "''")}' | Out-Null }
      Start-Process explorer.exe -ArgumentList '${dir.replace(/'/g, "''")}'
      Start-Sleep -Milliseconds 1500`);
  // ищем hwnd окна с этим путём через COM
  return ps(`
$hwnd = 0
foreach ($w in (New-Object -ComObject Shell.Application).Windows()) {
  try {
    if ($w -and $w.Document.Folder.Self.Path -eq '${dir.replace(/'/g, "''")}') { $hwnd = $w.HWND }
  } catch {}
}
$hwnd
`);
}

const FOCUS = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class FG2 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern void keybd_event(byte v, byte s, uint f, UIntPtr e);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
'@
$h = [IntPtr]([int]$env:FG_HWND)
if ($h -eq [IntPtr]::Zero) { 'BADHWND'; exit 0 }

# Windows не даёт чужому процессу забрать фокус просто так.
# Обход: эмулируем нажатие ALT (это разрешает смену фокуса)
# и подцепляемся к потоку текущего фронтального окна.
[FG2]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[FG2]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)

$fgThread = [FG2]::GetWindowThreadProcessId([FG2]::GetForegroundWindow(), [IntPtr]::Zero)
$myThread = [FG2]::GetCurrentThreadId()
[void][FG2]::AttachThreadInput($myThread, $fgThread, $true)
[void][FG2]::ShowWindow($h, 9)
[void][FG2]::SetForegroundWindow($h)
[void][FG2]::AttachThreadInput($myThread, $fgThread, $false)
Start-Sleep -Milliseconds 500
if ([FG2]::GetForegroundWindow() -eq $h) { 'FOCUSED' } else { 'NOFOCUS' }
`;

function focus(hwnd) {
  return ps(`$env:FG_HWND='${hwnd}'\n` + FOCUS);
}

(async () => {
  // путь с кириллицей — как у Аккера («игра» лежит на рабочем столе)
  const cyrillicDir = path.join(path.dirname(__dirname), 'тест-кириллица');
  const asciiDir = path.join(path.dirname(__dirname), 'drag-test');

  // --- 1. обычная папка
  const h1 = openWindow(asciiDir);
  check('окно ascii открылось', Number(h1) > 0, `hwnd=${h1}`);
  if (Number(h1) > 0) {
    const f = focus(h1);
    check('фокус взят', f === 'FOCUSED', f);
    const got = await currentExplorerFolder();
    check('ascii-папка вернулась', got === asciiDir, JSON.stringify(got));
  }

  // --- 2. кириллица
  const h2 = openWindow(cyrillicDir);
  check('окно с кириллицей открылось', Number(h2) > 0, `hwnd=${h2}`);
  if (Number(h2) > 0) {
    focus(h2);
    const got2 = await currentExplorerFolder();
    check('кириллица вернулась целиком', got2 === cyrillicDir, JSON.stringify(got2));
  }

  // --- 3. негатив: в фокусе не проводник
  ps(`Start-Process notepad.exe; Start-Sleep -Milliseconds 1200`);
  const nh = ps(`(Get-Process notepad -ErrorAction SilentlyContinue | Select-Object -First 1).MainWindowHandle`);
  if (Number(nh) > 0) focus(nh);
  const got3 = await currentExplorerFolder();
  check('не-проводник -> null', got3 === null, JSON.stringify(got3));

  ps(`Get-Process notepad -ErrorAction SilentlyContinue | Stop-Process -Force`);

  console.log('ПРОЙДЕНО:'); ok.forEach(o => console.log('  OK   ' + o));
  if (bad.length) { console.log('ПРОВАЛЕНО:'); bad.forEach(b => console.log('  FAIL ' + b)); }
  console.log(`\nИтог: ${ok.length} ок, ${bad.length} провалено`);
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('ОШИБКА:', e.stack || e.message); process.exit(1); });
