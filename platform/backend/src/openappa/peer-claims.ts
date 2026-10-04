import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * Proxy-stamped proof that a list/read call belongs to the authenticated
 * OpenAPPA session. The model never chooses the session. The MAC domain is
 * not the remedy JWS domain, so a remedy signature cannot authorize a read.
 */
const PEER_PROOF_VERSION = 1;
const PEER_PROOF_DOMAIN = "archestra.appa.peer-proof.v1";
const DEFAULT_KEY_ID = "default";

export const PEER_PROOF_ARGUMENT = "peer_proof";

export const PeerProofActionSchema = z.enum([
  "list_peer_messages",
  "read_peer_message",
]);

export type PeerProofAction = z.infer<typeof PeerProofActionSchema>;

const PeerProofClaimsSchema = z.object({
  v: z.literal(PEER_PROOF_VERSION),
  organization_id: z.string().min(1).max(512),
  caller_id: z.string().min(1).max(1024).nullable(),
  session_id: z.string().min(1).max(1024),
  parent_id: z.string().min(1).max(1024).nullable(),
  call_id: z.string().min(1).max(256),
  action: PeerProofActionSchema,
  message_id: z.string().min(1).max(128).nullable(),
});

type PeerProofClaims = z.infer<typeof PeerProofClaimsSchema>;

const ProtectedHeaderSchema = z.object({
  alg: z.literal("HS256"),
  kid: z.string().min(1).max(64),
  b64: z.literal(false),
  crit: z.tuple([z.literal("b64")]),
});

export const PeerProofJwsSchema = z.object({
  protected: z.string().min(1).max(1024),
  payload: z.string().min(1).max(8192),
  signature: z.string().min(1).max(256),
});

export type PeerProofJws = z.infer<typeof PeerProofJwsSchema>;

export function signPeerProof(
  claims: PeerProofClaims,
  secret: string,
): PeerProofJws | undefined {
  const parsed = PeerProofClaimsSchema.safeParse(claims);
  if (!parsed.success || secret.length === 0) return undefined;
  const encodedHeader = base64UrlEncode(
    JSON.stringify({
      alg: "HS256",
      kid: DEFAULT_KEY_ID,
      b64: false,
      crit: ["b64"],
    }),
  );
  const payload = canonicalClaims(parsed.data);
  return {
    protected: encodedHeader,
    payload,
    signature: signHs256(encodedHeader, payload, secret),
  };
}

export function verifyPeerProof(
  value: unknown,
  secret: string,
): PeerProofClaims | null {
  const parsed = PeerProofJwsSchema.safeParse(value);
  if (!parsed.success || secret.length === 0) return null;
  const header = decodeProtectedHeader(parsed.data.protected);
  if (!header) return null;
  const expected = signHs256(
    parsed.data.protected,
    parsed.data.payload,
    secret,
  );
  const actual = Buffer.from(parsed.data.signature, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) {
    return null;
  }
  const claims = PeerProofClaimsSchema.safeParse(
    parseJson(parsed.data.payload),
  );
  return claims.success ? claims.data : null;
}

/**
 * The proof names this caller, organization, and action. A read also names
 * the message id. Another member of the same organization does not match.
 */
export function peerProofAuthorizes(params: {
  proof: PeerProofClaims;
  organizationId: string;
  callerId: string | undefined;
  action: PeerProofAction;
  messageId?: string;
}): boolean {
  if (params.proof.organization_id !== params.organizationId) return false;
  if (params.proof.caller_id !== (params.callerId ?? null)) return false;
  if (params.proof.action !== params.action) return false;
  if (params.action === "read_peer_message") {
    return (
      params.messageId !== undefined &&
      params.proof.message_id === params.messageId
    );
  }
  return params.proof.message_id === null;
}

function signHs256(
  encodedHeader: string,
  payload: string,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(`${PEER_PROOF_DOMAIN}.${encodedHeader}.${payload}`)
    .digest("base64url");
}

function decodeProtectedHeader(encoded: string) {
  try {
    return ProtectedHeaderSchema.parse(
      JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
    );
  } catch {
    return null;
  }
}

function canonicalClaims(claims: PeerProofClaims): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(claims).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    ),
  );
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
