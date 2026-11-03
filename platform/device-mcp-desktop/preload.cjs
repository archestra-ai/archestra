const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('connector', {
  enableBrowserConnections: () => ipcRenderer.invoke('enable-browser-connections'),
  reconnect: () => ipcRenderer.invoke('reconnect'),
  disconnect: () => ipcRenderer.invoke('disconnect'),
  status: () => ipcRenderer.invoke('status'),
  onStatus: callback => { ipcRenderer.on('status', (_event, status) => callback(status)); },
});
