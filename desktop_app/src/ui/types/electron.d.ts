declare global {
  interface Window {
    electronAPI: {
      serverPort: number;
      websocketPort: number;
      ollamaPort: number;
      openExternal: (url: string) => Promise<void>;

      // Generic provider browser auth
      providerBrowserAuth: (provider: string) => Promise<Record<string, string>>;
    };
  }
}

export {};
