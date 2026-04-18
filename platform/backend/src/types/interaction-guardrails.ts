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
