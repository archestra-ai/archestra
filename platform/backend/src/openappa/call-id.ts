import { digestToolCallId } from "@/routes/proxy/utils/tool-call-ids";
import { withoutTrajectoryStamp } from "./trajectory-stamp";

/**
 * Policy code, the runtime and every record they keep name a tool call by an
 * id of at most this many bytes: the runtime refuses a longer identity, and
 * signed runtime proofs, the MCP gateway and child session ids hold less
 * still. A provider's id can run to kilobytes: the Gemini translation packs
 * the call's thought signature into it.
 */
const MAX_POLICY_CALL_ID_BYTES = 256;

/**
 * The id policy knows a tool call by: the wire's own, or the digest of a
 * provider's id too long to keep, read through a trajectory stamp so a call
 * has one policy id however the client sends it back. The client and the
 * provider keep the id the wire carries. A digest is its own policy id, so an
 * id may pass through here twice.
 */
export function policyCallId(wireId: string): string {
  const providerId = withoutTrajectoryStamp(wireId);
  return Buffer.byteLength(providerId, "utf8") <= MAX_POLICY_CALL_ID_BYTES
    ? wireId
    : digestToolCallId(providerId);
}

/**
 * The id the runtime's records and signed proofs name a call by: its policy
 * id, without a trajectory stamp.
 */
export function recordedCallId(wireId: string): string {
  return withoutTrajectoryStamp(policyCallId(wireId));
}
