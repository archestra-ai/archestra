import { z } from "zod";

/**
 * Why a runtime launch started no run. The proxy writes the text the model
 * reads from this reason, so no text of the gateway's result crosses.
 */
const RuntimeLaunchFailureReasonSchema = z.enum([
  "agent_not_found",
  "credentials_needed",
  "credentials_misconfigured",
  "refused",
  "failed",
]);

/** The run states the model may learn from a launch. */
export const RuntimeLaunchStateSchema = z.enum([
  "submitted",
  "working",
  "input-required",
  "completed",
  "failed",
  "canceled",
]);

/**
 * What the gateway did with a released runtime launch, as it recorded it
 * before it answered the client.
 */
export const RuntimeLaunchOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("launched"),
    session_id: z.string().uuid(),
    state: RuntimeLaunchStateSchema.optional(),
    reports_to_thread: z.literal(true).optional(),
  }),
  z.object({
    kind: z.literal("failed"),
    reason: RuntimeLaunchFailureReasonSchema,
    /** Where the user adds the credentials a `credentials_needed` launch lacks. */
    setup_url: z.string().url().optional(),
  }),
]);
export type RuntimeLaunchOutcome = z.infer<typeof RuntimeLaunchOutcomeSchema>;
export type RuntimeLaunchFailureReason = z.infer<
  typeof RuntimeLaunchFailureReasonSchema
>;
