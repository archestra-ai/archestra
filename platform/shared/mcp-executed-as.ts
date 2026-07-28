import { z } from "zod";
import { SEEDED_APP_RENDER_META_KEY } from "./seeded-app-render";

/**
 * Platform-reserved `_meta` key naming the identity whose credential served a
 * tool call upstream. The gateway resolves that credential per call (the
 * caller's own connection, a team or organization connection, a pinned
 * service-account connection, or a per-caller identity-provider token), and
 * without this the chat card and the MCP log record only say *what* ran, never
 * *as whom*. Like `archestraError`, it is stripped from every upstream tool
 * result before the platform stamps its own value, so a hostile server cannot
 * forge an identity.
 */
export const MCP_EXECUTED_AS_META_KEY = "archestraExecutedAs";

/**
 * Platform-reserved metadata keys: `archestraError` (set only by the MCP
 * client's error results), the seeded-app-render marker (set only by
 * open-in-chat conversation seeding), and the executed-as identity. Renderers
 * and the trusted-data guardrail key off them to identify platform-authored
 * results, so upstream copies must never survive.
 */
export const RESERVED_PLATFORM_META_KEYS = [
  "archestraError",
  SEEDED_APP_RENDER_META_KEY,
  MCP_EXECUTED_AS_META_KEY,
] as const;

/**
 * Remove platform-reserved keys from metadata the platform did not author —
 * an upstream tool result, or a tool definition synced from an upstream
 * server's `tools/list`. Returns the same reference when nothing was stripped.
 */
export function stripReservedPlatformMeta(
  meta: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!meta || !RESERVED_PLATFORM_META_KEYS.some((key) => key in meta)) {
    return meta;
  }
  const rest = { ...meta };
  for (const key of RESERVED_PLATFORM_META_KEYS) {
    delete rest[key];
  }
  return rest;
}

/**
 * Which identity the upstream call ran as. One member per way the gateway can
 * resolve a credential; a call that never reached an upstream server (a
 * platform built-in, a blocked call, an app launch) carries no descriptor at
 * all rather than a catch-all member.
 */
export const McpExecutedAsSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("personal"),
      /**
       * Owner of the personal connection the call ran through — the caller
       * themselves, or another user whose connection an admin pinned as a
       * service account. Null once the owning user is deleted (the connection
       * row's owner is cleared).
       */
      ownerUserId: z.string().nullable(),
      ownerName: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("team"),
      teamId: z.string(),
      teamName: z.string().nullable(),
    })
    .strict(),
  z.object({ kind: z.literal("org") }).strict(),
  /** Enterprise-managed: a credential minted for this caller by an identity provider. */
  z.object({ kind: z.literal("idp_exchange") }).strict(),
  /** External IdP: the caller's own token forwarded verbatim upstream. */
  z.object({ kind: z.literal("idp_passthrough") }).strict(),
  /** The caller's request carried the upstream authorization header itself. */
  z.object({ kind: z.literal("caller_headers") }).strict(),
]);

export type McpExecutedAs = z.infer<typeof McpExecutedAsSchema>;
export type McpExecutedAsKind = McpExecutedAs["kind"];

/**
 * Read the executed-as descriptor off a tool result, a persisted tool-call log
 * row's result, or a bare `_meta` record. Returns null for calls that never
 * resolved a credential and for results persisted before the descriptor
 * existed, so every surface hides rather than guesses.
 */
export function extractMcpExecutedAs(input: unknown): McpExecutedAs | null {
  if (input == null || typeof input !== "object") {
    return null;
  }

  const record = input as {
    _meta?: { [MCP_EXECUTED_AS_META_KEY]?: unknown };
    [MCP_EXECUTED_AS_META_KEY]?: unknown;
  };
  const candidate =
    record._meta?.[MCP_EXECUTED_AS_META_KEY] ??
    record[MCP_EXECUTED_AS_META_KEY];

  const parsed = McpExecutedAsSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
