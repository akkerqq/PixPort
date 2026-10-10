/**
 * PixPort — установка/удаление пункта в контекстном меню проводника.
 *
 *   node install.js            — добавить пункт
 *   node install.js uninstall  — убрать пункт
 *
 * Пишем в HKCU (без прав админа). Пункты:
 *   - правый клик по ПАПКЕ        → «Показать QR (PixPort)»
 *   - правый клик по ФОНУ папки   → «Показать QR здесь (PixPort)»
 *
 * Кодировка: PowerShell вызывается через -EncodedCommand (UTF-16LE base64),
 * поэтому кириллица в путях и подписях не ломается.
 */

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const mode = (process.argv[2] || 'install').toLowerCase();
const appDir = __dirname;

// dev: electron.exe + папка приложения | packaged: сам exe приложения
const devElectron = path.join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe');
const isDev = fs.existsSync(devElectron);
const exe = isDev ? devElectron : process.execPath;
const cmd = isDev ? `"${exe}" "${appDir}" "%V"` : `"${exe}" "%V"`;

/** Запустить PowerShell-скрипт без проблем с кодировкой. */
function runPs(script) {
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64],
    { encoding: 'utf8', stdio: 'pipe' }
  );
}

if (mode === 'uninstall') {
  runPs(`
    foreach ($k in @(
      'HKCU:\\Software\\Classes\\Directory\\shell\\PixPort',
      'HKCU:\\Software\\Classes\\Directory\\Background\\shell\\PixPort'
    )) { if (Test-Path $k) { Remove-Item -Path $k -Recurse -Force } }
    'done'
  `);
  console.log('Пункт «Показать QR» удалён из контекстного меню.');
  process.exit(0);
}

/* ------------------------------------------------------------ установка */

runPs(`
$cmd = @'
${cmd}
'@.Trim()

$icon = '${exe.replace(/'/g, "''")}'

$targets = @(
  @{ Key = 'HKCU:\\Software\\Classes\\Directory\\shell\\PixPort';            Text = 'Показать QR (PixPort)' },
  @{ Key = 'HKCU:\\Software\\Classes\\Directory\\Background\\shell\\PixPort'; Text = 'Показать QR здесь (PixPort)' }
)

foreach ($t in $targets) {
  New-Item -Path $t.Key -Force | Out-Null
  Set-ItemProperty -Path $t.Key -Name '(default)' -Value $t.Text
  Set-ItemProperty -Path $t.Key -Name 'Icon'      -Value $icon
  New-Item -Path ($t.Key + '\\command') -Force | Out-Null
  Set-ItemProperty -Path ($t.Key + '\\command') -Name '(default)' -Value $cmd
}
'installed'
`);

/* --------------------------------------------------- проверка через reg */

const out = execFileSync('reg', ['query', 'HKCU\\Software\\Classes\\Directory\\shell\\PixPort'], { encoding: 'utf8' });
const ok = out.includes('PixPort');

console.log(ok ? '✓ Пункт в контекстном меню установлен:' : '✗ Не записалось:', cmd);
process.exit(ok ? 0 : 1);
