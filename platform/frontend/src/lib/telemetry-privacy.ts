export const REPLAY_BLOCK_SELECTOR = [
  "[data-session-replay-sensitive]",
  '[data-slot="sidebar"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="tooltip"]',
  "[data-radix-popper-content-wrapper]",
  "img",
  "video",
  "audio",
  "canvas",
  "iframe",
  "object",
  "embed",
].join(", ");

export function isSensitiveReplayPath(pathname: string | null): boolean {
  if (!pathname) return true;
  return SENSITIVE_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}

export function stripTelemetryUrlContent(url: string): string {
  return url.split(/[?#]/)[0];
}

// Block whole surfaces, including identifiers and URLs held in DOM attributes.
const SENSITIVE_PATHS = [
  "/chat",
  "/projects",
  "/consults",
  "/llm/logs",
  "/mcp/logs",
  "/settings",
  "/account",
  "/auth",
  "/oauth",
  "/oauth-callback",
  "/connection",
  "/connections",
  "/audit",
  "/agents",
  "/skills",
  "/plugins",
  "/knowledge",
  "/openappa",
  "/tools",
  "/apps",
  "/a",
  "/llm/proxy",
  "/llm/model-providers",
  "/mcp/registry",
  "/mcp/gateways",
];
