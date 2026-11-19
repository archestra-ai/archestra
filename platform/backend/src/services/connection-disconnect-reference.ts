import { createHmac, timingSafeEqual } from "node:crypto";
import { CONNECTION_SETUP_WINDOW_MS } from "@archestra/shared/connection-setup";

/**
 * The disconnect reference: the counterpart of the setup reference a connect
 * installer prints (see connection-proxy-setup-context.ts).
 *
 * Disconnecting removes the gateway and the Guardrails helpers from a client,
 * so a conversation that does it cannot depend on either: a blocked step's
 * remedy tools are the first thing the cleanup deletes. The Connect page
 * therefore gives the signed-in person a reference with the cleanup prompt,
 * and the first conversation of theirs that presents it runs ungoverned until
 * the reference expires.
 *
 * The reference is derived from the organization, the person and its expiry
 * with the server secret, so nothing on a client yields one and no record is
 * kept of it. It names no client: it exempts one conversation of the person
 * it was issued to, for as long as a connection setup's own window.
 */

const PREFIX = "cdr1_";
const DOMAIN = "archestra-connection-disconnect-reference-v1:";
// 132 bits of the HMAC: enough that no other text matches by chance.
const MAC_LENGTH = 22;
const REFERENCE = /cdr1_([0-9a-z]{6,9})_([A-Za-z0-9_-]{22})(?![A-Za-z0-9_-])/g;
/** A reference further apart in a request than this is not looked for. */
const MAX_VISITED_VALUES = 200_000;

interface DisconnectReference {
  reference: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
}

type Scope = {
  organizationId: string;
  userId: string;
  secret: string | undefined;
};

export function issueDisconnectReference(
  params: Scope & { now?: number },
): DisconnectReference {
  if (!params.secret) {
    throw new Error("Connection disconnect signing key is missing");
  }
  if (!params.organizationId || !params.userId) {
    throw new Error("Connection disconnect scope is incomplete");
  }
  const expirySeconds = Math.ceil(
    ((params.now ?? Date.now()) + CONNECTION_SETUP_WINDOW_MS) / 1000,
  );
  return {
    reference: `${PREFIX}${expirySeconds.toString(36)}_${mac({ ...params, expirySeconds })}`,
    expiresAt: expirySeconds * 1000,
  };
}

/**
 * The live reference of this person that the text holds, if any. A reference
 * issued to another person or organization, an expired one, and one that
 * claims a longer life than a reference gets are not this person's.
 */
export function disconnectReferenceInText(
  params: Scope & { text: string; now?: number },
): DisconnectReference | undefined {
  if (!params.secret || !params.text.includes(PREFIX)) return undefined;
  const now = params.now ?? Date.now();
  for (const match of params.text.matchAll(REFERENCE)) {
    const expirySeconds = Number.parseInt(match[1], 36);
    if (!Number.isSafeInteger(expirySeconds)) continue;
    const expiresAt = expirySeconds * 1000;
    if (expiresAt <= now) continue;
    if (expiresAt - now > CONNECTION_SETUP_WINDOW_MS + 1000) continue;
    const expected = Buffer.from(mac({ ...params, expirySeconds }));
    const given = Buffer.from(match[2]);
    if (expected.length !== given.length) continue;
    if (!timingSafeEqual(expected, given)) continue;
    return { reference: match[0], expiresAt };
  }
  return undefined;
}

/**
 * The same, for a parsed request body: every string in it is looked at, so
 * the check does not depend on a provider's message shape.
 */
export function disconnectReferenceInBody(
  params: Scope & { body: unknown; now?: number },
): DisconnectReference | undefined {
  if (!params.secret) return undefined;
  const pending: unknown[] = [params.body];
  let visited = 0;
  while (pending.length > 0 && visited < MAX_VISITED_VALUES) {
    const value = pending.pop();
    visited += 1;
    if (typeof value === "string") {
      const found = disconnectReferenceInText({ ...params, text: value });
      if (found) return found;
    } else if (Array.isArray(value)) {
      for (const item of value) pending.push(item);
    } else if (value !== null && typeof value === "object") {
      for (const item of Object.values(value)) pending.push(item);
    }
  }
  return undefined;
}

function mac(params: Scope & { expirySeconds: number }): string {
  return createHmac("sha256", params.secret ?? "")
    .update(DOMAIN)
    .update(
      JSON.stringify([
        params.organizationId,
        params.userId,
        params.expirySeconds,
      ]),
    )
    .digest("base64url")
    .slice(0, MAC_LENGTH);
}
