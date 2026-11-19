import { z } from "zod";

/**
 * Why the runtime did not see a tool call's outcome: the model made the call
 * while Guardrails enforcement was off (`made`), the call started a child
 * that ran or got a message while enforcement was off (`child`), or the
 * runtime denied it and the Break the glass settings let it through
 * (`waived`).
 */
const UnenforcedCallReasonSchema = z.enum(["made", "child", "waived"]);
export type UnenforcedCallReason = z.infer<typeof UnenforcedCallReasonSchema>;

/**
 * Why OpenAPPA leaves a session alone: it started while Guardrails enforcement
 * was off (`enforcement_off`), or a person approved a `superyell` in it
 * (`superyell`). A child of such a session carries the parent's reason.
 */
const UnenforcedSessionReasonSchema = z.enum(["enforcement_off", "superyell"]);
export type UnenforcedSessionReason = z.infer<
  typeof UnenforcedSessionReasonSchema
>;
