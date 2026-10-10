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
  ],
  appVersion: '0.1.0',
  win32metadata: {
    CompanyName: 'akkerqq',
    FileDescription: 'PixPort — фото с телефона сразу в папку',
    ProductName: 'PixPort',
  },
})
  .then(paths => {
    console.log('\n✓ Собрано:\n  ' + paths.join('\n  '));
  })
  .catch(err => {
    console.error('✗ Ошибка сборки:', err);
    process.exit(1);
  });
