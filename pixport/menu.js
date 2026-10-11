/**
 * PixPort — установка/удаление пункта в контекстном меню проводника.
 * Общий модуль: используется и install.js (dev), и приложением (кнопка в окне).
 *
 * Пишем в HKCU — без прав админа. Пункты:
 *   - правый клик по ПАПКЕ      → «Показать QR (PixPort)»
 *   - правый клик по ФОНУ папки → «Показать QR здесь (PixPort)»
 *
 * Кириллица в путях: PowerShell вызывается через -EncodedCommand
 * (UTF-16LE base64), иначе «игра» в пути ломает консоль.
 */

const { execFileSync } = require('child_process');

const KEYS = [
  'HKCU:\\Software\\Classes\\Directory\\shell\\PixPort',
  'HKCU:\\Software\\Classes\\Directory\\Background\\shell\\PixPort',
];

const REG_KEYS = [
  'HKCU\\Software\\Classes\\Directory\\shell\\PixPort',
  'HKCU\\Software\\Classes\\Directory\\Background\\shell\\PixPort',
];

function runPs(script) {
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64],
    { encoding: 'utf8', stdio: 'pipe' }
  );
}

/**
 * Команда для реестра.
 * По документации: глагол ПО папке (Directory) получает путь через %1,
 * глагол по ФОНУ (Background) — через %V. Общий "%V" везде — неверно:
 * в Directory-контексте он может не раскрыться (кейс Аккера 11.10.2026:
 * клик по папке при запущенном приложении → диалог «нет приложения»).
 * packed: "C:\...\PixPort.exe" "%1"  /  dev: "C:\...\electron.exe" "C:\...\pixport" "%1"
 */
function commandFor({ exe, appDir }, place) {
  const tail = place === 'background' ? '"%V"' : '"%1"';
  return appDir ? `"${exe}" "${appDir}" ${tail}` : `"${exe}" ${tail}`;
}

/** Поставить пункт. Возвращает { ok, command }. */
function install(opts) {
  const cmdDir = commandFor(opts, 'directory'); // клик ПО папке → %1
  const cmdBg = commandFor(opts, 'background'); // клик по ФОНУ → %V
  const exe = String(opts.exe).replace(/'/g, "''");

  runPs(`
$cmdDir = @'
${cmdDir}
'@.Trim()
$cmdBg = @'
${cmdBg}
'@.Trim()

$icon = '${exe}'

foreach ($t in @(
  @{ Key = '${KEYS[0]}'; Text = 'Показать QR (PixPort)'; Cmd = $cmdDir },
  @{ Key = '${KEYS[1]}'; Text = 'Показать QR здесь (PixPort)'; Cmd = $cmdBg }
)) {
  New-Item -Path $t.Key -Force | Out-Null
  Set-ItemProperty -Path $t.Key -Name '(default)' -Value $t.Text
  Set-ItemProperty -Path $t.Key -Name 'Icon'      -Value $icon
  New-Item -Path ($t.Key + '\\command') -Force | Out-Null
  Set-ItemProperty -Path ($t.Key + '\\command') -Name '(default)' -Value $t.Cmd
}
'installed'
`);

  return { ok: isInstalled(), command: cmdDir };
}

/** Убрать пункт. */
function uninstall() {
  runPs(`
foreach ($k in @(${KEYS.map(k => `'${k}'`).join(',')})) {
  if (Test-Path $k) { Remove-Item -Path $k -Recurse -Force }
}
'done'
`);
  return { ok: !isInstalled() };
}

/** Пункт уже стоит? */
function isInstalled() {
  try {
    const out = execFileSync('reg', ['query', REG_KEYS[0]], { encoding: 'utf8', stdio: 'pipe' });
    return out.includes('PixPort');
  } catch (e) {
    return false;
  }
}

module.exports = { install, uninstall, isInstalled, commandFor };
