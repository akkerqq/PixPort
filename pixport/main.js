/**
 * PixPort — окно приложения (Electron).
 * Запускает сервер из server.js и открывает НАСТОЯЩЕЕ окно программы,
 * а не вкладку браузера. Выбор папки — через системный диалог,
 * перетаскиванием папки в окно или контекстное меню проводника.
 */

const { app, BrowserWindow, dialog, ipcMain, shell, globalShortcut, Tray, Menu, Notification, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { start, PORT, resolveFolder } = require('./server.js');
const menu = require('./menu.js');
const { currentExplorerFolder } = require('./hotkey.js');

// диагностика: пишем всё подозрительное в файл (в собранной версии консоли нет)
const LOG = path.join(os.tmpdir(), 'pixport-diag.log');
function diag(...a) {
  try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ` + a.join(' ') + '\n'); } catch (e) {}
}
diag('--- старт ---', 'argv =', JSON.stringify(process.argv), 'execPath =', process.execPath);

let win = null;
let tray = null;
let quitting = false; // true только когда выходим по-настоящему (трей -> Выйти)
let trayNotified = false;

const appDir = __dirname; // папка приложения (dev: pixport, packed: resources/app)

/** Иконка для трея и окна: assets/icon.png, рядом с main.js. */
function iconPath() {
  const p = path.join(appDir, 'assets', 'icon.png');
  return fs.existsSync(p) ? p : null;
}

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

/** Трей: иконка рядом с часами, окно можно закрыть — программа живёт. */
function createTray() {
  if (tray) return;
  try {
    const ip = iconPath();
    const img = ip ? nativeImage.createFromPath(ip) : nativeImage.createEmpty();
    tray = new Tray(img);
    tray.setToolTip('PixPort — Ctrl+Alt+Q для QR');
    const ctx = Menu.buildFromTemplate([
      { label: 'Показать PixPort', click: () => { if (!win) createWindow(); win.show(); win.focus(); } },
      { type: 'separator' },
      { label: 'Выйти', click: () => { quitting = true; app.quit(); } },
    ]);
    tray.setContextMenu(ctx);
    tray.on('click', () => { if (!win) createWindow(); win.show(); win.focus(); });
    diag('трей создан');
  } catch (e) {
    diag('трей НЕ создан:', e.stack || e.message);
  }
}

function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
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

  const ip = iconPath();
  if (ip) { try { win.setIcon(ip); } catch (e) {} }

  // закрыть окно = свернуть в трей, хоткей продолжает жить
  win.on('close', e => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    diag('окно скрыто в трей, хоткей жив');
    if (!trayNotified && Notification.isSupported()) {
      trayNotified = true;
      try { new Notification({ title: 'PixPort', body: 'Свёрнуто в трей. Ctrl+Alt+Q продолжает работать.' }).show(); } catch (err) {}
    }
  });
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
    showWindow();
    if (folder && win) win.loadURL(qrUrl(folder));
  });

  app.whenReady().then(async () => {
    diag('whenReady, начинаю сервер');
    const r = await start({ openBrowser: false });
    diag('старт сервера:', r);
    createTray();
    createWindow();
    diag('окно создано');

    registerHotkey();

    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  }).catch(e => diag('ОШИБКА старта:', e.stack || e.message));
}

/* --- горячая клавиша: Ctrl+Alt+Q ---
 * Быстрее любого ПКМ: одна комбинация вместо «правый клик → показать
 * доп. параметры → пункт». Папку берём у того окна проводника,
 * которое прямо сейчас в фокусе; если в фокусе не проводник —
 * просто показываем окно, папку не трогаем (не сбрасываем чужой выбор).
 */
const HOTKEY = 'CommandOrControl+Alt+Q';

function registerHotkey() {
  try {
    const ok = globalShortcut.register(HOTKEY, onHotkey);
    diag('хоткей', HOTKEY, ok ? 'зарегистрирован' : 'НЕ ЗАРЕГИСТРИРОВАН (занят?)');
    if (!ok) diag('возможно, комбинация занята другой программой');
  } catch (e) {
    diag('ошибка хоткея:', e.stack || e.message);
  }
}

async function onHotkey() {
  try {
    const d = await currentExplorerFolder(true);
    diag('хоткей: папка =', d.path || 'НЕ НАЙДЕНА',
         '| активное окно =', (d.proc || '?') + ' «' + (d.title || '') + '»',
         '| класс =', d.cls, '| hwnd =', d.hwnd,
         '| окон у Shell =', d.seen, '| err =', d.err || 'нет');
    showWindow();
    // папка не распознана — окно просто выходит вперёд, выбор сохраняем
    if (d.path && win) win.loadURL(qrUrl(d.path));
  } catch (e) {
    diag('ошибка хоткея при выполнении:', e.stack || e.message);
  }
}

app.on('will-quit', () => globalShortcut.unregisterAll());

app.on('before-quit', () => { quitting = true; });

// Все окна закрыты/скрыты — НЕ выходим: живём в трее ради хоткея.
// Выход только через трей -> Выйти.
app.on('window-all-closed', () => {
  diag('все окна скрыты — живу в трее, хоткей активен');
});

// почему приложение вообще завершилось
app.on('quit', (e, code) => diag('quit, код =', code));

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

/* --- контекстное меню проводника --- */

// куда ставить пункт: в dev — electron.exe + папка приложения, в сборке — сам exe
function menuTarget() {
  const devElectron = path.join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe');
  return fs.existsSync(devElectron) ? { exe: devElectron, appDir } : { exe: process.execPath };
}

ipcMain.handle('menu-status', () => menu.isInstalled());
ipcMain.handle('menu-install', () => { try { return menu.install(menuTarget()); } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('menu-remove', () => { try { return menu.uninstall(); } catch (e) { return { ok: false, error: e.message }; } });
