declare global {
  interface Window {
    electronAPI: {
      appVersion: () => Promise<string>;
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
    };
  }
}

export {};
