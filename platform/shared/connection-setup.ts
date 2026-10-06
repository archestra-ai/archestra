/** Clients whose proxy requests carry a native conversation identity. */
export const NATIVE_SESSION_CLIENT_LABELS = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
} as const;

export type NativeSessionClientId = keyof typeof NATIVE_SESSION_CLIENT_LABELS;

export const CONNECTION_SETUP_WINDOW_MS = 10 * 60 * 1000;

export function hasNativeSetupSession(
  clientId: string,
): clientId is NativeSessionClientId {
  return Object.hasOwn(NATIVE_SESSION_CLIENT_LABELS, clientId);
}

/** Parts of a setup the user can leave out on the connect page's review step. */
export const CONNECT_SETUP_PARTS = [
  "tools",
  "skills",
  "proxy",
  "plugins",
] as const;

export type ConnectSetupPart = (typeof CONNECT_SETUP_PARTS)[number];

/** Reads a comma-separated `exclude` value, dropping anything unknown. */
export function parseConnectExclude(
  value: string | null | undefined,
): ConnectSetupPart[] {
  const listed = new Set((value ?? "").split(","));
  return CONNECT_SETUP_PARTS.filter((part) => listed.has(part));
}

export function buildConnectionPrompt(params: {
  origin: string;
  clientId: string;
  label: string;
  /** Parts the user turned off; the link carries them to connect.md. */
  exclude?: readonly ConnectSetupPart[];
}): string {
  const exclude = parseConnectExclude(params.exclude?.join(","));
  const excludeParam = exclude.length ? `&exclude=${exclude.join(",")}` : "";
  return `Read ${params.origin}/connect.md?client=${encodeURIComponent(params.clientId)}${excludeParam} and connect ${params.label}.`;
}
