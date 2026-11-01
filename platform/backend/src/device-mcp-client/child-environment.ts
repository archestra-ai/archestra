/** Only OS launch compatibility belongs here; relay/application secrets never do. */
export function deviceMcpChildEnvironment(
  platform: "darwin" | "win32",
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  if (platform !== "win32") return {};
  const windowsDirectory =
    environment.WINDIR ?? environment.SystemRoot ?? environment.SYSTEMROOT;
  return windowsDirectory ? { WINDIR: windowsDirectory } : {};
}
