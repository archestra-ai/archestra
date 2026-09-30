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

export function buildConnectionPrompt(params: {
  origin: string;
  clientId: string;
  label: string;
}): string {
  return `Read ${params.origin}/connect.md?client=${encodeURIComponent(params.clientId)} and connect ${params.label}.`;
}
