const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,

  selectOutputFolder: () => ipcRenderer.invoke('select-output-folder'),
  openOutputFolder: () => ipcRenderer.invoke('open-output-folder'),
  openExternalLink: (url) => ipcRenderer.invoke('open-external-link', url),
  showNotification: (title, body) => ipcRenderer.invoke('show-notification', title, body),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  restartBackend: () => ipcRenderer.invoke('restart-backend'),
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  openSettings: () => ipcRenderer.invoke('open-settings'),

  onBackendReady: (callback) => {
    ipcRenderer.on('backend-ready', (_event) => callback());
  },

  onJobsFinished: (callback) => {
    ipcRenderer.on('jobs-finished', (_event, data) => callback(data));
  },
});
