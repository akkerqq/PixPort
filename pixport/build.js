/**
 * Сборка PixPort в отдельное приложение для Windows.
 *   npm run build
 * Результат: dist/PixPort-win32-x64/PixPort.exe
 */
const { packager } = require('@electron/packager');

packager({
  dir: __dirname,
  out: require('path').join(__dirname, 'dist'),
  name: 'PixPort',
  platform: 'win32',
  arch: 'x64',
  overwrite: true,
  // sharp — нативный модуль (.node), он НЕ грузится изнутри asar.
  // Без asar приложение стартует стабильно на любом ПК.
  asar: false,
  ignore: [
    /^\/dist($|\/)/,
    /^\/node_modules\/\.bin($|\/)/,
    /^\/\.git($|\/)/,
    /^\/test\.js$/,
    /^\/test-.*\.js$/,
    /^\/.*\.log$/,
    // native: исходники и эксперименты не едут к людям, только готовый exe
    /^\/native\/.*\.(cpp|ps1)$/,
    /^\/native\/PixMenu\.dll$/,
    /^\/native\/test-.*$/,
    /^\/installer\.iss$/,
    /^\/make-ico\.js$/,
    // генератор эмблемы и её исходник — людям едут только png+ico
    /^\/make-icon\.js$/,
    /^\/assets\/icon\.svg$/,
    // генератор ключей подписки — только для нас
    /^\/genkey\.js$/,
    // батник-обёртка генератора ключей — только для нас
    /^\/KEY\.bat$/,
    // оптимизация веса: локали Chromium кроме русской (~48 МБ),
    // текст лицензий Chromium (~20 МБ) — GPL-текст хранится рядом, не внутри exe
    /^\/locales\/(?!ru\.pak$).*/,
    /^\/LICENSES\.chromium\.html$/,
    // sharp: исходники C++ и скрипты установки не нужны в собранной версии,
    // работает только prebuilt .node
    /^\/node_modules\/sharp\/(src|install|vendor|include)(\/|$)/,
    /^\/node_modules\/.*\/(test|tests|docs|example|examples)(\/|$)/,
  ],
  appVersion: require('./package.json').version, // одна версия в package.json — не держим вторую руками
  // Иконка самого PixPort.exe (без расширения — packager добавит .ico).
  // Без неё exe получал стандартную иконку Electron.
  icon: require('path').join(__dirname, 'assets', 'icon'),
  win32metadata: {
    CompanyName: 'akkerqq',
    FileDescription: 'PixPort — фото с телефона сразу в папку',
    ProductName: 'PixPort',
  },
})
  .then(paths => {
    // Locales и LICENSES.chromium.html приезжают из дистрибутива Electron,
    // а не из нашей папки — ignore их не видит, вычищаем после упаковки.
    for (const out of paths) {
      const loc = require('path').join(out, 'locales');
      const fs2 = require('fs');
      if (fs2.existsSync(loc)) {
        for (const f of fs2.readdirSync(loc)) {
          if (f !== 'ru.pak') fs2.rmSync(require('path').join(loc, f), { force: true });
        }
      }
      const lic = require('path').join(out, 'LICENSES.chromium.html');
      if (fs2.existsSync(lic)) fs2.rmSync(lic, { force: true });
      // Компилятор шейдеров DirectX (~26 МБ): наше приложение — обычный HTML,
      // без WebGL. Проверено на собранной версии: окно, трей, хоткей — всё живо.
      for (const f of ['dxcompiler.dll', 'dxil.dll']) {
        const p = require('path').join(out, f);
        if (fs2.existsSync(p)) fs2.rmSync(p, { force: true });
      }
    }
    console.log('\n✓ Собрано:\n  ' + paths.join('\n  '));
  })
  .catch(err => {
    console.error('✗ Ошибка сборки:', err);
    process.exit(1);
  });
