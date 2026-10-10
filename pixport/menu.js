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
 * packed: "C:\...\PixPort.exe" "%V"
 * dev:    "C:\...\electron.exe" "C:\...\pixport" "%V"
 */
function commandFor({ exe, appDir }) {
  return appDir ? `"${exe}" "${appDir}" "%V"` : `"${exe}" "%V"`;
}

/** Поставить пункт. Возвращает { ok, command }. */
function install(opts) {
  const cmd = commandFor(opts);
  const exe = String(opts.exe).replace(/'/g, "''");

  runPs(`
$cmd = @'
${cmd}
'@.Trim()

$icon = '${exe}'

foreach ($t in @(
  @{ Key = '${KEYS[0]}'; Text = 'Показать QR (PixPort)' },
  @{ Key = '${KEYS[1]}'; Text = 'Показать QR здесь (PixPort)' }
)) {
  New-Item -Path $t.Key -Force | Out-Null
  Set-ItemProperty -Path $t.Key -Name '(default)' -Value $t.Text
  Set-ItemProperty -Path $t.Key -Name 'Icon'      -Value $icon
  New-Item -Path ($t.Key + '\\command') -Force | Out-Null
  Set-ItemProperty -Path ($t.Key + '\\command') -Name '(default)' -Value $cmd
}
'installed'
`);

  return { ok: isInstalled(), command: cmd };
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
