/**
 * OpenCode and Kilo Code, an OpenCode fork: one client family. Everything the
 * two share (the installer, the routing plugin, the launch check, the
 * Guardrails adapter, the session and log handling) is written once against
 * this descriptor. Only what genuinely differs is recorded here: names, the
 * binary, the config files, the state file prefix, the launch-check variable,
 * the session source in the LLM logs, the sign-in identity and the User-Agent.
 */

export type OpenCodeFamilyClientId = "opencode" | "kilo";

export interface OpenCodeFamilyDescriptor {
  id: OpenCodeFamilyClientId;
  /** Product name in the UI. */
  label: string;
  /** The CLI on the user's PATH. */
  binary: string;
  /** Config directory name under ~/.config. */
  dir: string;
  /** The config file setup writes (plain JSON, so a merge never loses comments). */
  configFile: string;
  /** The sibling config file the client also reads; it may hold comments. */
  commentedConfigFile: string;
  /** The file the client's own `mcp add` writes, when it is not `configFile`. */
  mcpAddConfigFile?: string;
  /** The config file the manual Connect steps tell the user to open. */
  manualConfigFile: string;
  /** Prefix of this client's files under ~/.archestra. */
  stateName: string;
  /** Environment variable that turns the launch check off. */
  guardEnvVar: string;
  /** `session_source` of this client's rows in the LLM logs. */
  sessionSource: "opencode_session" | "kilo_session";
  /** OAuth identity at sign-in: the CIMD document, or the DCR client name. */
  oauth: { clientId: string; clientNamePattern: string };
  /** Leading token of the User-Agent on provider requests. */
  userAgentToken: string;
  /** Icon in the LLM logs. */
  icon: string;
}

export const OPENCODE_FAMILY: Record<
  OpenCodeFamilyClientId,
  OpenCodeFamilyDescriptor
> = {
  opencode: {
    id: "opencode",
    label: "OpenCode",
    binary: "opencode",
    dir: "opencode",
    configFile: "opencode.json",
    commentedConfigFile: "opencode.jsonc",
    manualConfigFile: "opencode.json",
    stateName: "opencode",
    guardEnvVar: "ARCHESTRA_OPENCODE_GUARD",
    sessionSource: "opencode_session",
    // CIMD at opencode.ai (captured 2026-10-08), or DCR as "OpenCode" on a
    // configurable redirect port (sst/opencode, mcp/oauth-provider.ts).
    oauth: {
      clientId: "https://opencode.ai/oauth/opencode/client.json",
      clientNamePattern: "^OpenCode$",
    },
    // `opencode/<version>` on every provider; `originator: opencode` on the
    // OpenAI Responses wire.
    userAgentToken: "opencode",
    icon: "/icons/opencode.png",
  },
  kilo: {
    id: "kilo",
    label: "Kilo Code",
    binary: "kilo",
    dir: "kilo",
    configFile: "kilo.json",
    // `kilo mcp add` writes kilo.jsonc, so a hand-edited setup usually lives
    // there; Kilo reads and merges both files.
    commentedConfigFile: "kilo.jsonc",
    mcpAddConfigFile: "kilo.jsonc",
    manualConfigFile: "kilo.jsonc",
    stateName: "kilo",
    guardEnvVar: "ARCHESTRA_KILO_GUARD",
    sessionSource: "kilo_session",
    // Kilo's CLI keeps OpenCode's sign-in: CIMD at kilo.ai on its default
    // callback port, or DCR as "Kilo" on a configured one (kilo 7.8.8,
    // 2026-10-13).
    oauth: {
      clientId: "https://kilo.ai/docs/oauth/kilo/client.json",
      clientNamePattern: "^Kilo$",
    },
    // `kilo/<channel>/<version>/<surface>`, e.g. `kilo/latest/7.8.8/cli …`.
    // Its ChatGPT sign-in sends OpenCode's identity instead.
    userAgentToken: "kilo",
    icon: "/icons/kilo.png",
  },
};

export const OPENCODE_FAMILY_CLIENT_IDS = Object.keys(
  OPENCODE_FAMILY,
) as OpenCodeFamilyClientId[];

export const OPENCODE_FAMILY_CLIENTS = Object.values(OPENCODE_FAMILY);

export type OpenCodeFamilySessionSource =
  OpenCodeFamilyDescriptor["sessionSource"];

export const OPENCODE_FAMILY_SESSION_SOURCES = OPENCODE_FAMILY_CLIENTS.map(
  (client) => client.sessionSource,
);

export function isOpenCodeFamilyClient(
  id: string,
): id is OpenCodeFamilyClientId {
  return Object.hasOwn(OPENCODE_FAMILY, id);
}

export function isOpenCodeFamilySessionSource(
  sessionSource: string | null | undefined,
): sessionSource is OpenCodeFamilySessionSource {
  return (
    !!sessionSource &&
    (OPENCODE_FAMILY_SESSION_SOURCES as string[]).includes(sessionSource)
  );
}

/** One record per family member, built from its descriptor. */
export function openCodeFamilyRecord<T>(
  build: (client: OpenCodeFamilyDescriptor) => T,
): Record<OpenCodeFamilyClientId, T> {
  return Object.fromEntries(
    OPENCODE_FAMILY_CLIENTS.map((client) => [client.id, build(client)]),
  ) as Record<OpenCodeFamilyClientId, T>;
}

/** The family member a User-Agent's leading token names, if any. */
export function openCodeFamilyClientForUserAgent(
  userAgent: string | null | undefined,
): OpenCodeFamilyDescriptor | null {
  const token = userAgent?.split("/", 1)[0]?.trim().toLowerCase();
  if (!token) return null;
  return (
    OPENCODE_FAMILY_CLIENTS.find((client) => client.userAgentToken === token) ??
    null
  );
}
