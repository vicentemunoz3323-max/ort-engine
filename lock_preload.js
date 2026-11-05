const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lock', {
  info: () => ipcRenderer.invoke('lock:info'),
  desbloquear: (pass) => ipcRenderer.invoke('lock:desbloquear', pass)
});
