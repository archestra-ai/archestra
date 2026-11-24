import { z } from "zod";

/**
 * Why the runtime did not see a tool call's outcome: the model made the call
 * while Guardrails enforcement was off (`made`), the call started a child
 * that ran or got a message while enforcement was off (`child`), or, in an
 * earlier release, the runtime denied it and the Break the glass settings
 * let it through (`waived`: stored, never written or read).
 */
const UnenforcedCallReasonSchema = z.enum(["made", "child", "waived"]);
export type UnenforcedCallReason = z.infer<typeof UnenforcedCallReasonSchema>;
/** The reasons that still leave a call alone. */
export type ExemptCallReason = Exclude<UnenforcedCallReason, "waived">;

/**
 * Why OpenAPPA leaves a session alone: it started while Guardrails enforcement
 * was off (`enforcement_off`). A child of such a session carries the parent's
 * reason. Rows an earlier release wrote for a superyelled session
 * (`superyell`) are stored, never read, and replaced by an observation.
 */
const UnenforcedSessionReasonSchema = z.enum(["enforcement_off", "superyell"]);
export type UnenforcedSessionReason = z.infer<
  typeof UnenforcedSessionReasonSchema
>;
