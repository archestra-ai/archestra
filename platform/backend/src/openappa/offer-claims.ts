import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { openappaActor } from "./actor";

const OFFER_CLAIMS_VERSION = 1;
const DEFAULT_KEY_ID = "default";

const ProtectedHeaderSchema = z.object({
  alg: z.literal("HS256"),
  kid: z.string().min(1).max(64),
  b64: z.literal(false),
  crit: z.tuple([z.literal("b64")]),
});

const OfferClaimsSchema = z.object({
  v: z.literal(OFFER_CLAIMS_VERSION),
  organization_id: z.string().min(1).max(512),
  root: z.string().min(1).max(128),
  session_id: z.string().min(1).max(1024),
  parent_id: z.string().min(1).max(1024).nullable(),
  caller_id: z.string().min(1).max(1024).nullable(),
  offer_id: z.string().min(1).max(128),
  tool: z.string().min(1).max(512).nullable(),
  spelling: z.string().min(1).max(1024).nullable(),
  /**
   * The client's spelling of the dispatch tool (`run_tool`) the blocked call
   * went through, so the remedy's retry goes back through it. Absent on
   * direct calls and on offers signed before it existed.
   */
  dispatch: z.string().min(1).max(1024).optional(),
});

/** Flattened JWS JSON Serialization (RFC 7515 §7.2.2) with RFC 7797 unencoded payload. */
export const OfferJwsSchema = z.object({
  protected: z.string().min(1).max(1024),
  payload: z.string().min(1).max(8192),
  signature: z.string().min(1).max(256),
});

export type OfferJws = z.infer<typeof OfferJwsSchema>;
type OfferClaims = z.infer<typeof OfferClaimsSchema>;

/**
 * Drops the flattened JWS members from remedy call arguments. The proxy is
 * their only writer: it stamps them beside the model's arguments, so they are
 * never part of what the model itself sent.
 */
export function withoutOfferJws(
  args: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).filter(([key]) => !OFFER_JWS_KEYS.has(key)),
  );
}

function sessionRoot(sessionId: string): string {
  return `archestra:${createHash("sha256").update(sessionId).digest("hex")}`;
}

export function signOfferClaims(claims: OfferClaims, secret: string): OfferJws {
  const encodedHeader = base64UrlEncode(
    JSON.stringify({
      alg: "HS256",
      kid: DEFAULT_KEY_ID,
      b64: false,
      crit: ["b64"],
    }),
  );
  const payload = canonicalClaims(claims);
  return {
    protected: encodedHeader,
    payload,
    signature: signHs256(encodedHeader, payload, secret),
  };
}

export function verifyOfferClaims(
  value: unknown,
  secret: string,
): OfferClaims | null {
  const parsed = OfferJwsSchema.safeParse(value);
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
  const claims = OfferClaimsSchema.safeParse(parseJson(parsed.data.payload));
  return claims.success ? claims.data : null;
}

export function unsignedOfferClaims(params: {
  organizationId: string;
  sessionId: string;
  parentId?: string;
  callerId?: string;
  offerId: string;
  tool?: string;
  spelling?: string;
  dispatch?: string;
}): OfferClaims {
  return {
    v: OFFER_CLAIMS_VERSION,
    organization_id: params.organizationId,
    root: openappaActor(params.sessionId),
    session_id: params.sessionId,
    parent_id: params.parentId ?? null,
    caller_id: params.callerId ?? null,
    offer_id: params.offerId,
    tool: params.tool ?? null,
    spelling: params.spelling ?? null,
    ...(params.dispatch !== undefined ? { dispatch: params.dispatch } : {}),
  };
}

export function offerIdFromJws(jws: OfferJws): string | undefined {
  const claims = OfferClaimsSchema.safeParse(parseJson(jws.payload));
  return claims.success ? claims.data.offer_id : undefined;
}

/** The caller-scoped session an offer's claims name. Unverified: routing only. */
export function offerSessionFromJws(jws: OfferJws): string | undefined {
  const claims = OfferClaimsSchema.safeParse(parseJson(jws.payload));
  return claims.success ? claims.data.session_id : undefined;
}

function signHs256(
  encodedHeader: string,
  payload: string,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(`${encodedHeader}.${payload}`)
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

function canonicalClaims(claims: OfferClaims): string {
  // Sorted by codepoint so the MAC input is independent of construction order.
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(claims).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
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

const OFFER_JWS_KEYS: ReadonlySet<string> = new Set(
  OfferJwsSchema.keyof().options,
);
