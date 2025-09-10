// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
import { IpcRendererEvent, contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  appVersion: () => ipcRenderer.invoke('get-app-version'),
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),

  // Generic provider browser auth
  providerBrowserAuth: (provider: string) => ipcRenderer.invoke('provider-browser-auth', provider),

  onOAuthCallback: (callback: (params: any) => void) => {
    ipcRenderer.on('oauth-callback', (_event: IpcRendererEvent, params: any) => {
      callback(params);
    });
  },
  removeOAuthCallbackListener: () => {
    ipcRenderer.removeAllListeners('oauth-callback');
  },
});
