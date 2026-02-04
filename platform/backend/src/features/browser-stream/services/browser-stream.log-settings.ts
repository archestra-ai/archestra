type BrowserStreamLogEnv = NodeJS.ProcessEnv & {
  ARCHESTRA_BROWSER_STREAM_LOG_SCREENSHOTS?: string;
  ARCHESTRA_BROWSER_STREAM_LOG_TAB_SYNC?: string;
};

export type BrowserStreamLogSettings = {
  logScreenshots: boolean;
  logTabSync: boolean;
};

const parseEnvFlag = (value: string | undefined): boolean => value === "true";

export const parseBrowserStreamLogSettings = (
  env: BrowserStreamLogEnv,
): BrowserStreamLogSettings => ({
  logScreenshots: parseEnvFlag(env.ARCHESTRA_BROWSER_STREAM_LOG_SCREENSHOTS),
  logTabSync: parseEnvFlag(env.ARCHESTRA_BROWSER_STREAM_LOG_TAB_SYNC),
});

const defaultLogSettings = parseBrowserStreamLogSettings(process.env);

export const shouldLogBrowserStreamScreenshots = (): boolean =>
  defaultLogSettings.logScreenshots;

export const shouldLogBrowserStreamTabSync = (): boolean =>
  defaultLogSettings.logTabSync;
