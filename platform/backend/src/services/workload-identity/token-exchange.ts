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
import ServiceAccountModel from "@/models/service-account";
import ServiceAccountFederatedCredentialModel from "@/models/service-account-federated-credential";
import type { AuditOutcome } from "@/types/audit-log";
import {
  ACCESS_TOKEN_TYPE,
  JWT_TOKEN_TYPE,
  type SelectServiceAccountFederatedCredential,
  TOKEN_EXCHANGE_GRANT_TYPE,
  type WorkloadIdentityTokenError,
  type WorkloadIdentityTokenErrorCode,
  type WorkloadIdentityTokenRequest,
  type WorkloadIdentityTokenResponse,
} from "@/types/service-account-federated-credential";
import { isUuid } from "@/utils/uuid";
import { OidcIssuerKeysError, oidcIssuerKeys } from "./oidc-issuer-keys";

/**
 * RFC 8693 token exchange: trade an OIDC token from a workload's own issuer
 * (GitHub Actions, GitLab CI, Kubernetes, Google) for a short-lived token that
 * acts as a service account, with that account's roles.
 *
 * The token must be signed (RS256 or ES256) by a key the issuer publishes, be
 * inside its validity window, live no longer than a day, and match one of the
 * account's federated credentials exactly: issuer, audience, subject and every
 * claim condition. Every outcome for a known account is audited; the token
 * itself never is.
 */
export async function exchangeWorkloadIdentityToken(params: {
  body: WorkloadIdentityTokenRequest;
  request: ExchangeRequestContext;
}): Promise<ExchangeResult> {
  const { body, request } = params;
  if (body.grant_type !== TOKEN_EXCHANGE_GRANT_TYPE)
    return refuse(
      400,
      "unsupported_grant_type",
      `grant_type must be ${TOKEN_EXCHANGE_GRANT_TYPE}`,
    );
  if (!body.subject_token)
    return refuse(400, "invalid_request", "subject_token is required");
  if (
    !body.subject_token_type ||
    !SUBJECT_TOKEN_TYPES.has(body.subject_token_type)
  )
    return refuse(
      400,
      "invalid_request",
      `subject_token_type must be ${JWT_TOKEN_TYPE}`,
    );
  if (
    body.requested_token_type !== undefined &&
    body.requested_token_type !== ACCESS_TOKEN_TYPE
  )
    return refuse(
      400,
      "invalid_request",
      `requested_token_type must be ${ACCESS_TOKEN_TYPE} when present`,
    );
  if (!body.service_account_id || !isUuid(body.service_account_id))
    return refuse(
      400,
      "invalid_request",
      "service_account_id must be the id of a service account",
    );

  // Read before verification only to pick the issuer whose keys to use; no
  // decision rests on these values until the signature checks out.
  const unverified = readUnverified(body.subject_token);
  if (!unverified)
    return refuse(400, "invalid_grant", "subject_token is not a signed JWT");

  const account = await ServiceAccountModel.findForTokenExchange(
    body.service_account_id,
  );
  if (!account) {
    logger.info(
      { serviceAccountId: body.service_account_id, issuer: unverified.issuer },
      "[workload-identity] Refused an exchange for an unknown service account",
    );
    return refuse(400, "invalid_grant", UNTRUSTED_MESSAGE);
  }

  const audit = (entry: {
    outcome: AuditOutcome;
    statusCode: number;
    details: Record<string, unknown>;
  }) => recordExchangeAudit({ account, request, ...entry });

  if (!ALLOWED_ALGORITHMS.includes(unverified.alg)) {
    await audit({
      outcome: "failure",
      statusCode: 400,
      details: {
        reason: "algorithm_not_allowed",
        algorithm: unverified.alg,
        issuer: unverified.issuer,
      },
    });
    return refuse(
      400,
      "invalid_grant",
      `subject_token must be signed with ${ALLOWED_ALGORITHMS.join(" or ")}`,
    );
  }

  if (account.disabled) {
    await audit({
      outcome: "denied",
      statusCode: 400,
      details: {
        reason: "service_account_disabled",
        issuer: unverified.issuer,
      },
    });
    return refuse(400, "invalid_grant", UNTRUSTED_MESSAGE);
  }

  // Only an issuer this account's trust policies name exactly is ever
  // contacted, so a token cannot steer the server to a URL of its choosing.
  const credentials =
    await ServiceAccountFederatedCredentialModel.findForIssuer({
      serviceAccountId: account.id,
      issuer: unverified.issuer,
    });
  if (credentials.length === 0) {
    await audit({
      outcome: "denied",
      statusCode: 400,
      details: { reason: "issuer_not_trusted", issuer: unverified.issuer },
    });
    return refuse(400, "invalid_grant", UNTRUSTED_MESSAGE);
  }

  const verified = await verifyToken({
    token: body.subject_token,
    issuer: unverified.issuer,
  });
  if (!verified.ok) {
    await audit({
      outcome: "failure",
      statusCode: 400,
      details: { reason: verified.reason, issuer: unverified.issuer },
    });
    return refuse(400, "invalid_grant", verified.message);
  }
  const claims = verified.claims;
  const audiences = toAudienceList(claims.aud);
  const evidence = {
    issuer: unverified.issuer,
    subject: claims.sub,
    audience: audiences,
    claims: pickConditionClaims(claims, credentials),
  };

  const mismatches: { federatedCredentialId: string; reason: string }[] = [];
  let matched: SelectServiceAccountFederatedCredential | null = null;
  for (const credential of credentials) {
    const reason = mismatchReason({ credential, claims, audiences });
    if (!reason) {
      matched = credential;
      break;
    }
    mismatches.push({ federatedCredentialId: credential.id, reason });
  }
  if (!matched) {
    await audit({
      outcome: "denied",
      statusCode: 400,
      details: { reason: "no_matching_credential", mismatches, ...evidence },
    });
    return refuse(400, "invalid_grant", UNTRUSTED_MESSAGE);
  }

  const expiresAt = new Date(Date.now() + ISSUED_TOKEN_LIFETIME_SECONDS * 1000);
  const issued = await ServiceAccountModel.createFederatedToken({
    serviceAccountId: account.id,
    federatedCredentialId: matched.id,
    name: `Federated: ${matched.name}`,
    expiresAt,
  });
  await ServiceAccountFederatedCredentialModel.markUsed(matched.id);
  await audit({
    outcome: "success",
    statusCode: 200,
    details: {
      federatedCredentialId: matched.id,
      federatedCredentialName: matched.name,
      ...evidence,
      tokenExpiresAt: expiresAt.toISOString(),
    },
  });
  logger.info(
    {
      organizationId: account.organizationId,
      serviceAccountId: account.id,
      federatedCredentialId: matched.id,
      issuer: unverified.issuer,
      subject: claims.sub,
    },
    "[workload-identity] Issued a service account token for an OIDC token",
  );

  return {
    ok: true,
    body: {
      access_token: issued.token,
      issued_token_type: ACCESS_TOKEN_TYPE,
      token_type: "Bearer",
      expires_in: ISSUED_TOKEN_LIFETIME_SECONDS,
    },
  };
}

// === Internal helpers

type ExchangeRequestContext = {
  method: string;
  path: string;
  route: string | null;
  requestId: string;
  sourceIp: string | null;
  userAgent: string | null;
};

type ExchangeResult =
  | { ok: true; body: WorkloadIdentityTokenResponse }
  | { ok: false; statusCode: 400; body: WorkloadIdentityTokenError };

/** Lifetime of the issued service account token. */
const ISSUED_TOKEN_LIFETIME_SECONDS = 60 * 60;

type VerifiedClaims = JWTPayload & { sub: string; exp: number; iat: number };

const ALLOWED_ALGORITHMS = ["RS256", "ES256"];
/** GCP's STS accepts both names for an OIDC ID token; so do we. */
const SUBJECT_TOKEN_TYPES = new Set([
  JWT_TOKEN_TYPE,
  "urn:ietf:params:oauth:token-type:id_token",
]);
/** Clock skew allowed on exp, nbf and iat. */
const CLOCK_SKEW_SECONDS = 30;
/**
 * A token valid for longer than this is refused outright, whatever its
 * remaining time: a long-lived OIDC token is a standing credential, the thing
 * federation exists to remove. GCP's STS draws the same line.
 */
const MAX_TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;
/**
 * The one refusal for a token that is valid but not trusted, so a caller
 * holding some valid token cannot map out which policies an account has. The
 * audit log records the actual reason.
 */
const UNTRUSTED_MESSAGE =
  "The token is not trusted for this service account. Check the account's federated credentials.";

function refuse(
  statusCode: 400,
  error: WorkloadIdentityTokenErrorCode,
  description: string,
): ExchangeResult {
  return {
    ok: false,
    statusCode,
    body: { error, error_description: description },
  };
}

function readUnverified(token: string): { alg: string; issuer: string } | null {
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

async function verifyToken(params: {
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

function toAudienceList(aud: JWTPayload["aud"]): string[] {
  if (typeof aud === "string") return [aud];
  if (Array.isArray(aud)) return aud.filter((v) => typeof v === "string");
  return [];
}

function mismatchReason(params: {
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
function pickConditionClaims(
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

function isScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

async function recordExchangeAudit(params: {
  account: { id: string; name: string; organizationId: string };
  request: ExchangeRequestContext;
  outcome: AuditOutcome;
  statusCode: number;
  details: Record<string, unknown>;
}): Promise<void> {
  const { account, request } = params;
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
  } catch (err) {
    // A failed audit write must not decide the exchange; it is logged so it
    // can be noticed.
    logger.error(
      { err, serviceAccountId: account.id, outcome: params.outcome },
      "[workload-identity] Failed to write the token exchange audit row",
    );
  }
}
