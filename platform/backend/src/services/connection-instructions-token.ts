import { createHmac, timingSafeEqual } from "node:crypto";

/** Read-only capability for one installation; setup-ticket expiry is unrelated. */
export function issueConnectionInstructionsToken(params: {
  setupId: string;
  secret: string;
}): string {
  if (!params.secret)
    throw new Error("Connection instructions signing key is missing");
  return `cmi1_${params.setupId}.${signature(params.setupId, params.secret).toString("base64url")}`;
}

export function verifyConnectionInstructionsToken(params: {
  token: string;
  secret: string;
}): string | null {
  if (!params.secret) return null;
  const match =
    /^cmi1_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/.exec(
      params.token,
    );
  if (!match) return null;
  const actual = Buffer.from(match[2], "base64url");
  const expected = signature(match[1], params.secret);
  return actual.length === expected.length && timingSafeEqual(actual, expected)
    ? match[1]
    : null;
}

function signature(setupId: string, secret: string): Buffer {
  return createHmac("sha256", secret)
    .update(`connection-managed-instructions-v1:${setupId}`)
    .digest();
}
