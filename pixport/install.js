/**
 * PixPort — установка/удаление пункта в контекстном меню из консоли.
 *
 *   npm run menu          — добавить пункт
 *   npm run menu:off      — убрать пункт
 *
 * Логика в menu.js (общая с кнопкой в приложении).
 */

const path = require('path');
const fs = require('fs');
const menu = require('./menu.js');

const appDir = __dirname;
const devElectron = path.join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe');
const isDev = fs.existsSync(devElectron);

const opts = isDev
  ? { exe: devElectron, appDir }
  : { exe: process.execPath };

const mode = (process.argv[2] || 'install').toLowerCase();
const res = mode === 'uninstall' ? menu.uninstall() : menu.install(opts);

if (mode === 'uninstall') {
  console.log(res.ok ? '✓ Пункт «Показать QR» удалён.' : '✗ Не удалилось.');
} else {
  console.log(res.ok ? '✓ Пункт установлен:' : '✗ Не записалось:', res.command);
}

process.exit(res.ok ? 0 : 1);
