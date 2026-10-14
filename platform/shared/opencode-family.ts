/**
 * OpenCode and Kilo Code, an OpenCode fork: one client family. Everything the
 * two share (the installer, the routing plugin, the launch check, the
 * Guardrails adapter, the session and log handling) is written once against
 * this descriptor. Only what genuinely differs is recorded here: names, the
 * binary, the config files, the state file prefix, the launch-check variable,
 * the session source in the LLM logs, the sign-in identity, the User-Agent and
 * the mark.
 */

import type { ClientMark } from "./client-mark";

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
  /** Leading tokens (lower case) of the User-Agents the client sends. */
  userAgentTokens: readonly string[];
  /** The mark on the Connect tile and in the LLM logs. */
  mark: ClientMark;
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
    userAgentTokens: ["opencode"],
    // OpenCode's 240×300 mark scaled into the 24×24 box: the dark frame (its
    // inner cut-out wound the other way so it stays empty) and the lighter
    // lower block.
    mark: {
      viewBox: "0 0 24 24",
      path: "M16.8 4.8H7.2v14.4h9.6ZM21.6 24H2.4V0h19.2Z",
      accent: { path: "M16.8 19.2H7.2V9.6h9.6Z", color: "#CFCECD" },
      color: "#211E1E",
      background: "#f7f7f6",
    },
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
    // `Kilo-Code/<version> ai-sdk/…` on provider requests and
    // `kilo/<channel>/<version>/<surface>` on its own calls (kilo 7.8.8).
    // Its ChatGPT sign-in sends OpenCode's identity instead.
    userAgentTokens: ["kilo-code", "kilo"],
    // Kilo Code's favicon (kilo.ai) in its 32×32 box: the frame around
    // "Ki/lo", filled even-odd so the frame and the "o" stay open, on the
    // brand yellow.
    mark: {
      viewBox: "0 0 32 32",
      path: "M0 0v32h32V0ZM29 29H3V3h26ZM9 12h3v3h3v-3l-3-3H9V6H6v9h3ZM12 6h3v3h-3ZM26 12h-3V9l-3-3h-3v3h3v3h-3v3h9ZM12 17h3v3h-3ZM15 26v-3H9v-6H6v6.1875L8.8125 26ZM23 26v-2h3v-5l-2-2h-4v2h-3v5l2 2ZM20 20h3v3h-3Z",
      fillRule: "evenodd",
      color: "#000000",
      background: "#FFDD00",
    },
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
    OPENCODE_FAMILY_CLIENTS.find((client) =>
      client.userAgentTokens.includes(token),
    ) ?? null
  );
}
