import { z } from "zod";

export const UnsafeContextBoundaryReasonSchema = z.enum([
  "agent_configured_untrusted",
  "inherited_from_parent",
  "tool_result_marked_untrusted",
  "tool_result_blocked",
]);

export type UnsafeContextBoundaryReason = z.infer<
  typeof UnsafeContextBoundaryReasonSchema
>;

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
