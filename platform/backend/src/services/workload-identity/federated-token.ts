// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
import {
  createLocalJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  type JWTPayload,
  errors as joseErrors,
  jwtVerify,
} from "jose";
import logger from "@/logging";
import AuditLogModel from "@/models/audit-log";
import type { AuditOutcome } from "@/types/audit-log";
import type { SelectServiceAccountFederatedCredential } from "@/types/service-account-federated-credential";
import { OidcIssuerKeysError, oidcIssuerKeys } from "./oidc-issuer-keys";

/*
 * The checks every workload OIDC token passes before it acts as a service
 * account, whether it is traded at the token exchange or sent as a bearer
 * token: signature, lifetime, and a federated credential that matches it.
 */

/** Where an audited federation attempt came from; null fields are unknown. */
export type FederationRequestContext = {
  method: string | null;
  path: string | null;
  route: string | null;
  requestId: string | null;
  sourceIp: string | null;
  userAgent: string | null;
};

export type VerifiedClaims = JWTPayload & {
  sub: string;
  exp: number;
  iat: number;
};

export const ALLOWED_ALGORITHMS = ["RS256", "ES256"];

/** The token's algorithm and issuer, read before any verification. */
export function readUnverified(
  token: string,
): { alg: string; issuer: string } | null {
  try {
    const header = decodeProtectedHeader(token);
    const payload = decodeJwt(token);
    if (typeof header.alg !== "string" || typeof payload.iss !== "string")
      return null;
    return { alg: header.alg, issuer: payload.iss };
  } catch {
    return null;
  }
}

export async function verifyIssuerToken(params: {
  token: string;
  issuer: string;
}): Promise<
  | { ok: true; claims: VerifiedClaims }
  | { ok: false; reason: string; message: string }
> {
  const attempt = async (refresh: boolean) => {
    const keys = await oidcIssuerKeys.getKeySet(params.issuer, { refresh });
    return jwtVerify(params.token, createLocalJWKSet(keys), {
      algorithms: ALLOWED_ALGORITHMS,
      issuer: params.issuer,
      clockTolerance: CLOCK_SKEW_SECONDS,
      requiredClaims: ["exp", "iat", "sub", "aud"],
    });
  };

  let payload: JWTPayload;
  try {
    try {
      ({ payload } = await attempt(false));
    } catch (error) {
      // A key we have not seen: the issuer may have rotated since we cached.
      if (!(error instanceof joseErrors.JWKSNoMatchingKey)) throw error;
      ({ payload } = await attempt(true));
    }
  } catch (error) {
    if (error instanceof OidcIssuerKeysError)
      return {
        ok: false,
        reason: `issuer_keys_unavailable: ${error.reason}`,
        message: "The issuer's signing keys could not be read. Try again.",
      };
    if (error instanceof joseErrors.JOSEError)
      return {
        ok: false,
        reason: error.code,
        message:
          error instanceof joseErrors.JWTExpired
            ? "subject_token has expired. Request a new one."
            : "subject_token failed verification.",
      };
    throw error;
  }

  const now = Math.floor(Date.now() / 1000);
  const { exp, iat, sub } = payload;
  if (
    typeof exp !== "number" ||
    typeof iat !== "number" ||
    typeof sub !== "string"
  )
    return {
      ok: false,
      reason: "claims_malformed",
      message: "subject_token failed verification.",
    };
  if (iat > now + CLOCK_SKEW_SECONDS)
    return {
      ok: false,
      reason: "issued_in_the_future",
      message: "subject_token is issued in the future.",
    };
  if (exp - iat > MAX_TOKEN_LIFETIME_SECONDS)
    return {
      ok: false,
      reason: "lifetime_too_long",
      message: `subject_token is valid for more than ${MAX_TOKEN_LIFETIME_SECONDS / 3600} hours. Use a short-lived token.`,
    };
  return { ok: true, claims: { ...payload, exp, iat, sub } };
}

export function toAudienceList(aud: JWTPayload["aud"]): string[] {
  if (typeof aud === "string") return [aud];
  if (Array.isArray(aud)) return aud.filter((v) => typeof v === "string");
  return [];
}

export function mismatchReason(params: {
  credential: SelectServiceAccountFederatedCredential;
  claims: VerifiedClaims;
  audiences: string[];
}): string | null {
  const { credential, claims, audiences } = params;
  if (!audiences.includes(credential.audience)) return "audience_mismatch";
  if (claims.sub !== credential.subject) return "subject_mismatch";
  for (const [claim, expected] of Object.entries(credential.claimConditions)) {
    const actual = claims[claim];
    if (!isScalar(actual) || String(actual) !== expected)
      return `claim_mismatch:${claim}`;
  }
  return null;
}

/** The token's values for the claims any of the credentials constrain. */
export function pickConditionClaims(
  claims: JWTPayload,
  credentials: SelectServiceAccountFederatedCredential[],
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const credential of credentials) {
    for (const claim of Object.keys(credential.claimConditions)) {
      const value = claims[claim];
      if (isScalar(value)) picked[claim] = value;
    }
  }
  return picked;
}

export async function recordFederationAudit(params: {
  account: { id: string; name: string; organizationId: string };
  request: FederationRequestContext | null;
  outcome: AuditOutcome;
  statusCode: number;
  details: Record<string, unknown>;
}): Promise<boolean> {
  const { account } = params;
  const request = params.request ?? NO_REQUEST;
  try {
    await AuditLogModel.create({
      organizationId: account.organizationId,
      actorId: null,
      actorType: "service_account",
      actorName: account.name,
      actorEmail: null,
      action: "serviceAccount.token_exchanged",
      outcome: params.outcome,
      resourceType: "serviceAccount",
      resourceId: account.id,
      resourceName: account.name,
      before: null,
      after: params.details,
      httpMethod: request.method,
      httpPath: request.path,
      httpRoute: request.route,
      httpStatus: params.statusCode,
      requestId: request.requestId,
      sourceIp: request.sourceIp,
      userAgent: request.userAgent,
      occurredAt: new Date(),
    });
    return true;
  } catch (err) {
    // A failed audit write must not decide the exchange; it is logged so it
    // can be noticed.
    logger.error(
      { err, serviceAccountId: account.id, outcome: params.outcome },
      "[workload-identity] Failed to write the token exchange audit row",
    );
    return false;
  }
}

// === Internal helpers

/** Clock skew allowed on exp, nbf and iat. */
const CLOCK_SKEW_SECONDS = 30;
/**
 * A token valid for longer than this is refused outright, whatever its
 * remaining time: a long-lived OIDC token is a standing credential, the thing
 * federation exists to remove. GCP's STS draws the same line.
 */
const MAX_TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;
function isScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

const NO_REQUEST: FederationRequestContext = {
  method: null,
  path: null,
  route: null,
  requestId: null,
  sourceIp: null,
  userAgent: null,
};
