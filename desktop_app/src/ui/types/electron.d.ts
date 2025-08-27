declare global {
  interface Window {
    electronAPI: {
      serverPort: number;
      websocketPort: number;
      ollamaPort: number;
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
