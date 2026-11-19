import {
  decodeSignedToolCallId,
  digestToolCallId,
} from "@/routes/proxy/utils/tool-call-ids";
import { withoutTrajectoryStamp } from "./trajectory-stamp";

/**
 * Policy code, the runtime and every record they keep name a tool call by an
 * id of at most this many bytes: the runtime refuses a longer identity, and
 * signed runtime proofs, the MCP gateway and child session ids hold less
 * still.
 */
const MAX_POLICY_CALL_ID_BYTES = 256;

/**
 * The id policy knows a tool call by, however the client sends it back. The
 * client and the provider keep the id the wire carries.
 *
 * A Gemini call is known by the id Gemini gave it: the Gemini translation
 * packs the call's thought signature around that id, which can run to
 * kilobytes, and the signature is transport, not identity. Any other id over
 * the limit is known by its digest. Both are read through a trajectory stamp.
 * An id within the limit stays as the wire carries it, and a policy id is its
 * own policy id.
 */
export function policyCallId(wireId: string): string {
  const providerId = withoutTrajectoryStamp(wireId);
  const callId = withoutSignature(providerId);
  if (Buffer.byteLength(callId, "utf8") > MAX_POLICY_CALL_ID_BYTES)
    return digestToolCallId(callId);
  return callId === providerId ? wireId : callId;
}

/**
 * The id the runtime's records and signed proofs name a call by: its policy
 * id, without a trajectory stamp.
 */
export function recordedCallId(wireId: string): string {
  return withoutTrajectoryStamp(policyCallId(wireId));
}

/**
 * Whether a record names this call: by its recorded id, or by the whole
 * provider id, as a release that knew no other recorded it.
 */
export function recordsCall(recordedId: string, wireId: string): boolean {
  return (
    recordedId === recordedCallId(wireId) ||
    recordedId === withoutTrajectoryStamp(wireId)
  );
}

function withoutSignature(providerId: string): string {
  const { id, thoughtSignature } = decodeSignedToolCallId(providerId);
  return thoughtSignature === undefined || !id
    ? providerId
    : withoutSignature(id);
}
