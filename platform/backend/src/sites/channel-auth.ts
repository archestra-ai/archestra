import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import config from "@/config";

/**
 * Site tokens: how one site proves to another that a channel request comes
 * from a site sharing the same database and auth secret.
 *
 * `v1.<payload>.<signature>`, where the payload is base64url JSON
 * `{ iss, aud, exp, bh }` (sending site, receiving site, expiry in epoch
 * seconds, SHA-256 of the request body) and the signature is HMAC-SHA256 over
 * `v1.<payload>` with a key derived from the session auth secret. Binding the
 * body hash and the receiving site keeps a captured token from being reused
 * for another request or another site; the short expiry bounds replay.
 */
export const SITE_TOKEN_HEADER = "x-archestra-site-token";
const SITE_TOKEN_TTL_SECONDS = 60;
/** Accepted difference between the two sites' clocks. */
const CLOCK_SKEW_SECONDS = 30;

interface SiteTokenPayload {
  iss: string;
  aud: string;
  exp: number;
  bh: string;
}

export function signSiteToken(params: {
  to: string;
  body: string;
  now?: number;
  from?: string;
}): string {
  const payload: SiteTokenPayload = {
    iss: params.from ?? config.site.name,
    aud: params.to,
    exp: Math.floor((params.now ?? Date.now()) / 1000) + SITE_TOKEN_TTL_SECONDS,
    bh: bodyHash(params.body),
  };
  const head = `v1.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  return `${head}.${sign(head)}`;
}

/** The sending site's name, or why the token is refused. */
export function verifySiteToken(params: {
  token: string | undefined;
  body: string;
  now?: number;
}): { ok: true; from: string } | { ok: false; reason: string } {
  const parts = params.token?.split(".");
  if (!parts || parts.length !== 3 || parts[0] !== "v1")
    return { ok: false, reason: "missing or malformed site token" };
  const head = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(sign(head));
  const actual = Buffer.from(parts[2]);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    return {
      ok: false,
      reason:
        "site token signature does not match; do both sites share the same auth secret?",
    };
  let payload: SiteTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed site token payload" };
  }
  const nowSeconds = Math.floor((params.now ?? Date.now()) / 1000);
  if (
    typeof payload.exp !== "number" ||
    payload.exp + CLOCK_SKEW_SECONDS < nowSeconds
  )
    return { ok: false, reason: "site token expired" };
  if (payload.aud !== config.site.name)
    return {
      ok: false,
      reason: `site token is for site "${payload.aud}", this is "${config.site.name}"`,
    };
  if (payload.bh !== bodyHash(params.body))
    return { ok: false, reason: "site token does not match the request body" };
  if (typeof payload.iss !== "string" || !payload.iss)
    return { ok: false, reason: "site token names no sending site" };
  return { ok: true, from: payload.iss };
}

// === Internal helpers ===

function sign(head: string): string {
  return createHmac("sha256", channelKey()).update(head).digest("base64url");
}

function bodyHash(body: string): string {
  return createHash("sha256").update(body).digest("base64url");
}

let cachedKey: { secret: string; key: Buffer } | undefined;

/** Derived, so the channel never signs with the session secret itself. */
function channelKey(): Buffer {
  const secret = config.auth.secret ?? "";
  if (!secret)
    throw new Error("The site channel needs ARCHESTRA_AUTH_SECRET to be set");
  if (cachedKey?.secret !== secret) {
    cachedKey = {
      secret,
      key: createHmac("sha256", secret)
        .update("archestra-site-channel-v1")
        .digest(),
    };
  }
  return cachedKey.key;
}
