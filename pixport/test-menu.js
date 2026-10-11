// Тест пункта контекстного меню: packed-версия должна ссылаться на PixPort.exe
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const appDir = path.join(__dirname, 'dist', 'PixPort-win32-x64', 'resources', 'app');
const menu = require(path.join(appDir, 'menu.js'));
const exe = path.join(__dirname, 'dist', 'PixPort-win32-x64', 'PixPort.exe');

const ok = [], bad = [];
const check = (n, c, x = '') => (c ? ok : bad).push(n + (x ? ' → ' + x : ''));

check('exe существует', fs.existsSync(exe), exe);
check('menu.js собран', fs.existsSync(path.join(appDir, 'menu.js')));

// packed-логика: appDir не передаём, ставим сам exe
const r = menu.install({ exe });
check('install вернул ok', r.ok === true);
check('команда ведёт на PixPort.exe', r.command.startsWith(`"${exe}"`), r.command);
check('команда без appDir', !r.command.includes('resources'), r.command);

// реестр реально записан и указывает на exe
const out = execFileSync('reg', ['query', 'HKCU\\Software\\Classes\\Directory\\shell\\PixPort\\command'], { encoding: 'utf8' });
check('в реестре PixPort.exe', out.includes('PixPort.exe'));
check('в реестре нет electron', !out.includes('electron.exe'));
check('клик по папке — через %1', out.includes('"%1"'), out.trim());

// второй пункт (фон папки) тоже есть
const out2 = execFileSync('reg', ['query', 'HKCU\\Software\\Classes\\Directory\\Background\\shell\\PixPort\\command'], { encoding: 'utf8' });
check('фон папки тоже установлен', out2.includes('PixPort.exe'));
check('клик по фону — через %V', out2.includes('"%V"'), out2.trim());

// снятие
const u = menu.uninstall();
check('uninstall снял', u.ok === true && !menu.isInstalled());

// и dev-путь ещё работает
const devElectron = path.join(__dirname, 'node_modules', 'electron', 'dist', 'electron.exe');
if (fs.existsSync(devElectron)) {
  const rd = menu.install({ exe: devElectron, appDir: __dirname });
  check('dev-установка ok', rd.ok === true);
  check('dev-команда по папке: electron + appDir + %1', rd.command.includes('electron.exe') && rd.command.includes('"%1"'), rd.command);
  check('dev-команда по фону: %V', menu.commandFor({ exe: devElectron, appDir: __dirname }, 'background').includes('"%V"'));
  menu.uninstall();
}

console.log('ПРОЙДЕНО:'); ok.forEach(o => console.log('  ✓ ' + o));
if (bad.length) { console.log('ПРОВАЛЕНО:'); bad.forEach(b => console.log('  ✗ ' + b)); }
console.log(`\nИтог: ${ok.length} ок, ${bad.length} провалено`);
process.exit(bad.length ? 1 : 0);
