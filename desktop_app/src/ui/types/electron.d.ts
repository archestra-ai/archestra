declare global {
  interface Window {
    electronAPI: {
      getAppInfo: () => Promise<{
        version: string;
        isPackaged: boolean;
      }>;
      getSystemInfo: () => Promise<{
        platform: string;
        arch: string;
        osVersion: string;
        nodeVersion: string;
        electronVersion: string;
        cpu: string;
        totalMemory: string;
        freeMemory: string;
        totalDisk: string;
        freeDisk: string;
      }>;

      openExternal: (url: string) => Promise<void>;

      // Generic provider browser auth
      providerBrowserAuth: (provider: string) => Promise<Record<string, string>>;

      // OAuth callback methods
      onOAuthCallback: (callback: (params: any) => void) => void;
      removeOAuthCallbackListener: () => void;

      // dialog
      showOpenDialog: (options: {
        properties: Array<'openDirectory' | 'openFile' | 'multiSelections'>;
      }) => Promise<{ canceled: boolean; filePaths: string[] }>;
    };
  }
}

export {};
