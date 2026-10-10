// Мост: даёт странице QR безопасный доступ к возможностям Electron.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('pixport', {
  /** Открыть системный диалог выбора папки. Возвращает путь или null. */
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  /** Открыть папку в проводнике. */
  openPath: p => ipcRenderer.invoke('open-path', p),
  /** Перетащили папку в окно — откроем QR для неё. */
  dropPath: p => ipcRenderer.invoke('path-from-drop', p),
  /** Реальный путь файла из события drag&drop. */
  pathForFile: f => { try { return webUtils.getPathForFile(f); } catch { return null; } },
  /** Контекстное меню проводника. */
  menuStatus: () => ipcRenderer.invoke('menu-status'),
  menuInstall: () => ipcRenderer.invoke('menu-install'),
  menuRemove: () => ipcRenderer.invoke('menu-remove'),
  isDesktop: true,
});
