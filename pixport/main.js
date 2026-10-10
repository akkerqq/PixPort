/**
 * PixPort — окно приложения (Electron).
 * Запускает сервер из server.js и открывает НАСТОЯЩЕЕ окно программы,
 * а не вкладку браузера. Выбор папки — через системный диалог,
 * перетаскиванием папки в окно или контекстное меню проводника.
 */

const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { start, PORT, resolveFolder } = require('./server.js');

// диагностика: пишем всё подозрительное в файл (в собранной версии консоли нет)
const LOG = path.join(os.tmpdir(), 'pixport-diag.log');
function diag(...a) {
  try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ` + a.join(' ') + '\n'); } catch (e) {}
}
diag('--- старт ---', 'argv =', JSON.stringify(process.argv), 'execPath =', process.execPath);

let win = null;

const appDir = __dirname; // папка приложения (dev: pixport, packed: resources/app)

/**
 * Достать путь к папке из аргументов запуска.
 * dev:    electron.exe <папка-приложения> <папка>
 * packed: PixPort.exe <папка>
 */
function folderFromArgv(argv) {
  const appAbs = path.resolve(appDir);
  for (let i = argv.length - 1; i >= 0; i--) {
    const a = argv[i];
    if (a.startsWith('-') || a.startsWith('--')) continue;
    const abs = resolveFolder(a);
    if (abs && abs !== appAbs) return abs; // саму папку приложения не считаем
  }
  return null;
}

/** Ссылка на окно QR для конкретной папки. */
function qrUrl(folder) {
  const abs = resolveFolder(folder);
  return abs ? `http://127.0.0.1:${PORT}/?folder=${encodeURIComponent(abs)}`
             : `http://127.0.0.1:${PORT}/`;
}

function createWindow() {
  win = new BrowserWindow({
    width: 520,
    height: 760,
    minWidth: 420,
    minHeight: 560,
    backgroundColor: '#0b1026',
    title: 'PixPort',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadURL(qrUrl(folderFromArgv(process.argv)));
  win.on('closed', () => { win = null; });

  // что реально происходит с загрузкой страницы
  win.webContents.on('did-fail-load', (e, code, desc, url) =>
    diag('FAIL LOAD', code, desc, url));
  win.webContents.on('did-finish-load', () =>
    diag('OK LOAD', win.webContents.getURL()));
  win.webContents.on('console-message', (e, lvl, msg) =>
    diag('CONSOLE', lvl, msg));
  process.on('uncaughtException', e => diag('UNCAUGHT', e.stack || e.message));
  process.on('unhandledRejection', e => diag('UNHANDLED', String(e && e.stack || e)));
}

// --- однокомандная блокировка: второй запуск открывает папку в первом окне
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (ev, argv) => {
    // приложение уже запущено — просто подсвети окно и открыть папку
    const folder = folderFromArgv(argv);
    if (win) {
      win.show();
      win.focus();
      if (folder) win.loadURL(qrUrl(folder));
    }
  });

  app.whenReady().then(async () => {
    diag('whenReady, начинаю сервер');
    const r = await start({ openBrowser: false });
    diag('старт сервера:', r);
    createWindow();
    diag('окно создано');

    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  }).catch(e => diag('ОШИБКА старта:', e.stack || e.message));
}

app.on('window-all-closed', () => { app.quit(); });

/* --- мост из окна в систему --- */

// системный диалог выбора папки
ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Выбери папку для фото',
    properties: ['openDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});

// «Открыть папку в проводнике»
ipcMain.handle('open-path', (e, p) => {
  const abs = resolveFolder(p);
  if (abs) shell.openPath(abs);
  return !!abs;
});

// путь к папке, перетащенной в окно (drag&drop)
ipcMain.handle('path-from-drop', (e, filePath) => {
  const abs = resolveFolder(filePath);
  if (abs && win) win.loadURL(qrUrl(abs));
  return abs;
});
