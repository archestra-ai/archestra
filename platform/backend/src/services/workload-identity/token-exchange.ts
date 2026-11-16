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
import {
  ALLOWED_ALGORITHMS,
  type FederationRequestContext,
  mismatchReason,
  pickConditionClaims,
  readUnverified,
  recordFederationAudit,
  toAudienceList,
  verifyIssuerToken,
} from "./federated-token";

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
  }) => recordFederationAudit({ account, request, ...entry });

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

  const verified = await verifyIssuerToken({
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

type ExchangeRequestContext = FederationRequestContext & {
  method: string;
  path: string;
  requestId: string;
};

type ExchangeResult =
  | { ok: true; body: WorkloadIdentityTokenResponse }
  | { ok: false; statusCode: 400; body: WorkloadIdentityTokenError };

/** Lifetime of the issued service account token. */
const ISSUED_TOKEN_LIFETIME_SECONDS = 60 * 60;

/** GCP's STS accepts both names for an OIDC ID token; so do we. */
const SUBJECT_TOKEN_TYPES = new Set([
  JWT_TOKEN_TYPE,
  "urn:ietf:params:oauth:token-type:id_token",
]);
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
