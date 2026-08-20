import { z } from "zod";

/**
 * The alert kinds a viewer is allowed to mute. Only "needs-reauth" qualifies:
 * it is the one alert whose fix belongs to a single person (re-connect the
 * credential), so hiding it from everyone else's view costs nothing. A
 * reinstall requirement or a runtime fault is a state of the deployment that
 * every viewer needs to keep seeing, so neither is mutable.
 */
export const McpServerMutableAlertKindSchema = z.enum(["needs-reauth"], {
  error: 'Only "needs-reauth" alerts can be muted.',
});

export type McpServerMutableAlertKind = z.infer<
  typeof McpServerMutableAlertKindSchema
>;

/**
 * A mute as the viewer who owns it sees it. The alert it silences is identified
 * by `(mcpServerId, issueKind)`; the viewer is implicit, because a listing only
 * ever carries the caller's own mutes.
 *
 * Mutes reaching the API have already been checked for applicability against
 * the server's current `oauthRefreshFailedAt`, so the failure timestamp the
 * mute was taken against is not part of the read shape.
 */
export const McpServerAlertMuteSchema = z.object({
  mcpServerId: z.string(),
  issueKind: McpServerMutableAlertKindSchema,
  reason: z.string(),
  /** When the mute was last (re-)taken, not when it was first created. */
  mutedAt: z.coerce.date(),
});

export type McpServerAlertMute = z.infer<typeof McpServerAlertMuteSchema>;

/** A mute must say why; the cap keeps a free-text field out of blob territory. */
export const MuteMcpServerAlertBodySchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, "A reason is required to mute an alert.")
    .max(500),
});
