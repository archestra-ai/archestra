import { randomBytes, timingSafeEqual } from "node:crypto";

const INTERNAL_CALL_HEADER = "x-archestra-internal-call";
const secret = randomBytes(32);

/** Proves a proxy call was made by this process itself. */
export function internalCallHeader(): Record<string, string> {
  return { [INTERNAL_CALL_HEADER]: secret.toString("base64url") };
}

/** Whether the headers carry a valid proof. Leaves the headers untouched. */
export function hasInternalCall(
  headers: Record<string, string | string[] | undefined>,
): boolean {
  const presented = headers[INTERNAL_CALL_HEADER];
  if (typeof presented !== "string") return false;
  const bytes = Buffer.from(presented, "base64url");
  return bytes.length === secret.length && timingSafeEqual(bytes, secret);
}

/** Removes the proof from the headers and reports whether it was valid. */
export function takeInternalCall(
  headers: Record<string, string | string[] | undefined>,
): boolean {
  const valid = hasInternalCall(headers);
  delete headers[INTERNAL_CALL_HEADER];
  return valid;
}

/** Header name the proof travels under; kept out of logs and traces. */
export const INTERNAL_CALL_HEADER_NAME = INTERNAL_CALL_HEADER;
