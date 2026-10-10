/**
 * PixPort — окно приложения (Electron).
 * Запускает сервер из server.js и открывает НАСТОЯЩЕЕ окно программы,
 * а не вкладку браузера. Выбор папки — через системный диалог,
 * перетаскиванием папки в окно или контекстное меню проводника.
 */

const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const { start, PORT, resolveFolder } = require('./server.js');

let win = null;

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
    await start({ openBrowser: false });
    createWindow();

    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
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
