/**
 * PixPort — текущая папка проводника для горячей клавиши.
 *
 * Зачем: Ctrl+Alt+Q должен открыть QR для папки, в которой человек
 * прямо сейчас находится в проводнике. Иначе хоткей бессмыслен —
 * пришлось бы лезть за папкой руками.
 *
 * Как узнаём папку:
 *   1. GetForegroundWindow() — какое окно активно;
 *   2. класс окна Progman/WorkerW — это рабочий стол;
 *   3. иначе Shell.Application.Windows() ищем окно с тем же HWND
 *      и читаем Document.Folder.Self.Path.
 *
 * Кириллица в путях («игра»): PowerShell вызывается через -EncodedCommand,
 * а РЕЗУЛЬТАТ пишется в UTF-8-файл. Консоль PowerShell отдаёт байты
 * в кодовой странице — через файл этот геморрой обходится полностью.
 */

const { execFile, execFile: execFileCb } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Нативный хелпер (native/hotkey-helper.exe): тот же опрос проводника
 * через COM, но без холодного старта PowerShell (~0.03с против 1-2с).
 * Лежит рядом с кодом и в сборке (asar:false), запускается скрыто.
 * Нет exe — откатываемся на PowerShell ниже, хоткей всё равно работает.
 */
function helperPath() {
  const p = path.join(__dirname, 'native', 'hotkey-helper.exe');
  return fs.existsSync(p) ? p : null;
}

/** Опрос через нативный хелпер. null = хелпера нет или сбой (пробовать PS). */
function helperQuery() {
  return new Promise(resolve => {
    const exe = helperPath();
    if (!exe) { resolve(null); return; }
    const t = Date.now();
    execFileCb(exe, { timeout: 3000, windowsHide: true }, (err, stdout) => {
      if (err) { resolve(null); return; }
      try {
        const o = JSON.parse(String(stdout).trim());
        if (!o || typeof o !== 'object') { resolve(null); return; }
        resolve({
          path: o.path ? String(o.path).trim() || null : null,
          hwnd: o.hwnd || '', cls: o.cls || '', seen: Number(o.seen) || 0,
          err: o.err || '', title: o.title || '', proc: o.proc || '',
          ms: Date.now() - t, via: 'native',
        });
      } catch (e) { resolve(null); }
    }).on('error', () => resolve(null));
  });
}

const SCRIPT = `
$outFile = $env:PIXPORT_FOLDER_OUT
$ErrorActionPreference = 'SilentlyContinue'

function SaveObj([string]$path,[string]$hwnd,[string]$cls,[string]$seen,[string]$err,[string]$title,[string]$proc) {
  $o = @{ path=$path; hwnd=$hwnd; cls=$cls; seen=$seen; err=$err; title=$title; proc=$proc } |
       ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($outFile, $o, (New-Object System.Text.UTF8Encoding($false)))
}

$cls=''; $fh=''; $seen=0; $err=''; $title=''; $proc=''
try {
  Add-Type -Namespace W -Name K -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
'@
} catch { $err = 'Add-Type: ' + $_.Exception.Message }

try {
  $h = [W.K]::GetForegroundWindow()
  $fh = '0x' + $h.ToInt64().ToString('x')

  $sb = New-Object System.Text.StringBuilder 512
  [void][W.K]::GetClassName($h, $sb, 512)
  $cls = $sb.ToString()

  # заголовок + имя процесса — чтобы понять, было ли окно в фокусе
  # или это чужое окно (терминал, браузер). Без этого «класс = Chrome_WidgetWin_1»
  # ничего не говорит: Electron и PixPort, и терминал.
  $tb = New-Object System.Text.StringBuilder 512
  [void][W.K]::GetWindowText($h, $tb, 512)
  $title = $tb.ToString()

  $pid2 = [uint32]0
  [void][W.K]::GetWindowThreadProcessId($h, [ref]$pid2)
  if ($pid2 -gt 0) { try { $proc = (Get-Process -Id $pid2 -ErrorAction Stop).ProcessName } catch {} }

  # рабочий стол — отдельный класс, окон у Shell для него нет
  if ($cls -eq 'Progman' -or $cls -eq 'WorkerW') {
    SaveObj ([Environment]::GetFolderPath([Environment+SpecialFolder]::Desktop)) $fh $cls '0' $err $title $proc
    exit 0
  }

  $app = New-Object -ComObject Shell.Application
  foreach ($w in $app.Windows()) {
    try {
      if ($null -eq $w) { continue }
      $seen++
      if ([int64]$w.HWND -eq $h.ToInt64()) {
        $p = ''
        try { $p = $w.Document.Folder.Self.Path } catch {}
        if ($p) { SaveObj $p $fh $cls ([string]$seen) $err $title $proc; exit 0 }
      }
    } catch {}
  }
} catch { $err = $err + ' | ' + $_.Exception.Message }
SaveObj '' $fh $cls ([string]$seen) $err $title $proc
`;

let counter = 0;

/**
 * Папка активного окна проводника.
 * Резолвится в string (путь) либо null, если активное окно — не проводник.
 * Никогда не бросает: таймаут и ошибки превращаются в null.
 *
 * Сначала пробуем нативный хелпер (быстро), при сбое — PowerShell.
 *
 * raw=true — вернуть всю отладку {path, hwnd, cls, seen, err, ms, via},
 * чтобы лог показывал, ПОЧЕМУ папка не нашлась, а не просто «пусто».
 */
async function currentExplorerFolder(raw = false) {
  const fast = await helperQuery();
  if (fast) return raw ? fast : fast.path;

  // фолбэк: хелпера нет или сбой — старый путь через PowerShell
  const t = Date.now();
  return new Promise(resolve => {
    const outFile = path.join(os.tmpdir(), `pixport-fold-${process.pid}-${++counter}.txt`);
    const b64 = Buffer.from(SCRIPT, 'utf16le').toString('base64');

    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      try { fs.unlinkSync(outFile); } catch (e) {}
      resolve(value);
    };

    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', b64],
      { env: { ...process.env, PIXPORT_FOLDER_OUT: outFile }, timeout: 6000 },
      () => {
        const ms = Date.now() - t;
        let text = null;
        try { text = fs.readFileSync(outFile, 'utf8'); } catch (e) {}

        if (!text) {
          finish(raw ? { path: null, hwnd: '', cls: '', seen: 0, err: 'нет файла-ответа', title: '', proc: '', ms, via: 'ps' } : null);
          return;
        }

        let obj = null;
        try { obj = JSON.parse(text); } catch (e) {}
        if (!obj) {
          // старый формат (просто строка) — не роняем из-за этого
          const p = text.trim();
          finish(raw ? { path: p || null, hwnd: '', cls: '', seen: 0, err: 'не-JSON', title: '', proc: '', ms, via: 'ps' } : (p || null));
          return;
        }

        const folder = obj.path ? String(obj.path).trim() : '';
        finish(raw ? { ...obj, path: folder || null, ms, via: 'ps' } : (folder || null));
      }
    ).on('error', () => finish(raw
      ? { path: null, hwnd: '', cls: '', seen: 0, err: 'powershell не запустился', title: '', proc: '', ms: Date.now() - t, via: 'ps' }
      : null));
  });
}

module.exports = { currentExplorerFolder };
