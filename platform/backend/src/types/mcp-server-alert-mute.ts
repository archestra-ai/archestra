import {
  MCP_SERVER_DISMISSIBLE_ALERT_KINDS,
  type McpServerDismissibleAlertKind,
} from "@archestra/shared";
import { z } from "zod";

/** Every terminal/actionable registry alert may be dismissed per viewer. */
export const McpServerDismissibleAlertKindSchema = z.enum(
  MCP_SERVER_DISMISSIBLE_ALERT_KINDS,
);

export type { McpServerDismissibleAlertKind };

/**
 * A per-viewer dismissal. Catalog-level alerts have no `mcpServerId`; the
 * fingerprint pins the dismissal to one failure episode.
 */
export const McpServerAlertMuteSchema = z.object({
  catalogId: z.string(),
  mcpServerId: z.string().nullable(),
  issueKind: McpServerDismissibleAlertKindSchema,
  issueFingerprint: z.string(),
  reason: z.string(),
  /** When the mute was last (re-)taken, not when it was first created. */
  mutedAt: z.coerce.date(),
});

export type McpServerAlertMute = z.infer<typeof McpServerAlertMuteSchema>;

/** A dismissal identifies the exact failure episode; its note is optional. */
export const MuteMcpServerAlertBodySchema = z.object({
  mcpServerId: z.string().uuid().nullable().optional(),
  issueFingerprint: z.string().trim().min(1).max(500),
  reason: z.string().trim().max(500).optional().default(""),
});

export const UnmuteMcpServerAlertQuerySchema = z.object({
  issueFingerprint: z.string().trim().min(1).max(500),
});
