import { z } from "zod";

export const unsafeContextBoundaryReasonValues = [
  "agent_configured_untrusted",
  "inherited_from_parent",
  "tool_result_marked_untrusted",
  "tool_result_blocked",
] as const;

export const UnsafeContextBoundaryReasonSchema = z.enum(
  unsafeContextBoundaryReasonValues,
);

export type UnsafeContextBoundaryReason = z.infer<
  typeof UnsafeContextBoundaryReasonSchema
>;

export const UNSAFE_CONTEXT_BOUNDARY_REASON = {
  agentConfiguredUntrusted: unsafeContextBoundaryReasonValues[0],
  inheritedFromParent: unsafeContextBoundaryReasonValues[1],
  toolResultMarkedUntrusted: unsafeContextBoundaryReasonValues[2],
  toolResultBlocked: unsafeContextBoundaryReasonValues[3],
} as const satisfies Record<string, UnsafeContextBoundaryReason>;

export const UnsafeContextBoundarySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("preexisting_untrusted"),
    reason: UnsafeContextBoundaryReasonSchema,
  }),
  z.object({
    kind: z.literal("tool_result"),
    reason: UnsafeContextBoundaryReasonSchema,
    toolCallId: z.string(),
    toolName: z.string(),
  }),
]);

export type UnsafeContextBoundary = z.infer<typeof UnsafeContextBoundarySchema>;

/**
 * Recorded when a guardrail refused this turn's tool calls, so a refused turn
 * is distinguishable from a healthy one without reading its content.
 *
 * A refusal otherwise persists as an ordinary assistant turn — normal finish
 * reason, no error — so an unattended run that died on one is indistinguishable
 * from a successful one at the row level. That is invisible precisely where it
 * matters: an agent whose correct output is sometimes nothing (a scheduled
 * check with no findings) looks identical whether it worked or was cut off.
 *
 * Deliberately metadata only. Tool NAMES are omitted: this codebase treats them
 * as content (they sit inside the encrypted `unsafeContextBoundary`), and
 * keeping them out is what lets this column stay outside the content-encryption
 * boundary and therefore be queryable and alertable directly. The names are
 * already carried by the blocked-tool spans and metrics for anyone who needs
 * them.
 */
export const ToolCallBlockSchema = z.object({
  /** The platform's own reason for the block, as shown to the caller. */
  reason: z.string(),
  /** How many tool calls the guardrail refused. */
  blockedToolCallCount: z.number().int().nonnegative(),
});

export type ToolCallBlock = z.infer<typeof ToolCallBlockSchema>;
