import { STARTUP_GUARD_INSTALL } from "./consts";

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
  const listed = new Set(params.exclude);
  const exclude = CONNECT_SETUP_PARTS.filter((part) => listed.has(part));
  const excludeParam = exclude.length ? `&exclude=${exclude.join(",")}` : "";
  return `Read ${params.origin}/connect.md?client=${encodeURIComponent(params.clientId)}${excludeParam} and connect ${params.label}.`;
}

/**
 * Apps with a setup installer: connect.md, disconnect.md and the installer
 * accept these. The Connect page features them, in this order.
 */
export const INSTALLER_CLIENT_IDS = [
  "claude-code",
  "cursor",
  "codex",
  "claude-desktop",
  "copilot-cli",
  "opencode",
] as const;

export type InstallerClientId = (typeof INSTALLER_CLIENT_IDS)[number];

export const INSTALLER_CLIENT_LABELS: Record<InstallerClientId, string> = {
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
  cursor: "Cursor",
  codex: "Codex",
  "copilot-cli": "Copilot CLI",
  opencode: "OpenCode",
};

export function isInstallerClientId(id: string): id is InstallerClientId {
  return (INSTALLER_CLIENT_IDS as readonly string[]).includes(id);
}

/**
 * The startup guard's file stem under ~/.archestra ("claude" for
 * claude-startup-guard.sh); undefined for apps without a guard (Cursor,
 * Claude Desktop).
 */
export function startupGuardStem(id: string): string | undefined {
  const guard = STARTUP_GUARD_INSTALL[id as keyof typeof STARTUP_GUARD_INSTALL];
  return guard?.scriptRelpath
    .replace(/^\.archestra\//, "")
    .replace(/-startup-guard\.sh$/, "");
}

/**
 * What a setup leaves on the user's machine, one short line each, as the
 * Connect page's disconnect dialogs list it. Kept in line with the
 * inventories in frontend/src/app/disconnect.md/route.ts.
 */
export const INSTALLER_CLIENT_FOOTPRINT: Record<InstallerClientId, string[]> = {
  "claude-code": [
    "MCP server entry (claude mcp add, user scope)",
    "Archestra plugin and skills",
    "~/.claude/settings.json (model routing)",
    "Startup check in your shell profile",
  ],
  cursor: ["~/.cursor/mcp.json", "~/.cursor/skills/"],
  codex: [
    "~/.codex/config.toml (gateway, model provider, skills marketplace)",
    "Plugins from the skills marketplace",
    "Startup check in your shell profile",
  ],
  "claude-desktop": ["A Claude Desktop profile for Archestra"],
  "copilot-cli": [
    "MCP server entry (copilot mcp add)",
    "~/.copilot/settings.json (skills marketplace)",
    "COPILOT_PROVIDER_* exports in your shell profile",
    "Startup check in your shell profile",
  ],
  opencode: [
    "opencode.json (gateway and model routing)",
    "Skills folder in ~/.config/opencode/skills/",
    "Routing plugin archestra-llm-proxy.js",
    "~/.archestra state file",
    "Startup check in your shell profile",
  ],
};

/**
 * The profile id the Claude Desktop installer writes:
 * uuid5(NAMESPACE_URL, "archestra-desktop:managed"). The installer computes it
 * itself; a backend test pins this value to that computation.
 */
export const CLAUDE_DESKTOP_PROFILE_ID = "aa157426-f6a9-5ac5-8471-3b30b42bbe8f";
