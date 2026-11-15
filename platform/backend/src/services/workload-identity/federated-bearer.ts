// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
import { createHash } from "node:crypto";
import { LRUCacheManager } from "@/cache-manager";
import logger from "@/logging";
import ServiceAccountModel, {
  type VerifiedServiceAccountToken,
} from "@/models/service-account";
import ServiceAccountFederatedCredentialModel from "@/models/service-account-federated-credential";
import type { AuditOutcome } from "@/types/audit-log";
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
 * The service account a bearer token acts as: one of its own tokens, or a
 * workload's OIDC token one of its federated credentials trusts.
 */
export async function verifyServiceAccountBearer(params: {
  token: string;
  request?: FederationRequestContext;
}): Promise<VerifiedServiceAccountToken | null> {
  const own = await ServiceAccountModel.verifyToken(params.token);
  if (own) return own;
  return JWT_SHAPE.test(params.token)
    ? verifyFederatedBearerToken(params)
    : null;
}

// === Internal helpers

/**
 * A workload's own OIDC token, sent as a bearer token where a service account
 * token goes. Some runtimes never hand their workloads a token to trade: Agent
 * Substrate's egress gateway writes the actor's JWT into the request itself.
 *
 * The token passes the token exchange's checks, against the federated
 * credentials of every service account that trusts its issuer, and exactly one
 * account must match. Once verified it is stored as a federated token of that
 * account until it expires, five minutes at most, so later requests cost
 * one indexed lookup. Returns null for any token that does not act as an account,
 * including every JWT whose issuer no credential names.
 */
async function verifyFederatedBearerToken(params: {
  token: string;
  request?: FederationRequestContext;
}): Promise<VerifiedServiceAccountToken | null> {
  const { token } = params;
  const known = await ServiceAccountModel.verifyFederatedBearerToken(token);
  if (known) return known;

  // Read before verification only to find the credentials that name this
  // issuer; no decision rests on it until the signature checks out.
  const unverified = readUnverified(token);
  if (!unverified || !ALLOWED_ALGORITHMS.includes(unverified.alg)) return null;
  const candidates =
    await ServiceAccountFederatedCredentialModel.findForIssuerAcrossAccounts(
      unverified.issuer,
    );
  if (candidates.length === 0) return null;

  const accounts = new Map(
    candidates.map(({ account }) => [account.id, account]),
  );
  const tokenFingerprint = createHash("sha256").update(token).digest("hex");
  const auditEach = (
    ids: Iterable<string>,
    outcome: AuditOutcome,
    details: Record<string, unknown>,
  ) =>
    Promise.all(
      [...ids].map(async (id) => {
        const account = accounts.get(id);
        if (!account) return;
        // A refusal is audited once per account, token and reason a while:
        // anyone can get a correctly signed token from a shared issuer such
        // as GitHub Actions and send it again and again.
        const refusalKey =
          outcome === "success"
            ? null
            : [id, tokenFingerprint, String(details.reason)].join(":");
        if (refusalKey && recentRefusals.get(refusalKey)) return;
        const written = await recordFederationAudit({
          account,
          request: params.request ?? null,
          outcome,
          statusCode: outcome === "success" ? 200 : 401,
          details: { mode: "bearer", ...details },
        });
        if (refusalKey && written) recentRefusals.set(refusalKey, true);
      }),
    );

  const verified = await verifyIssuerToken({
    token,
    issuer: unverified.issuer,
  });
  if (!verified.ok) {
    // Only a token the issuer really signed is audited: anyone can forge one
    // that names a trusted issuer, and each audit is a write.
    if (SIGNED_TOKEN_FAILURES.has(verified.reason)) {
      await auditEach(accounts.keys(), "failure", {
        reason: verified.reason,
        issuer: unverified.issuer,
      });
    } else {
      logger.info(
        { issuer: unverified.issuer, reason: verified.reason },
        "[workload-identity] Refused a bearer token that failed verification",
      );
    }
    return null;
  }
  const claims = verified.claims;
  const audiences = toAudienceList(claims.aud);
  const evidence = {
    issuer: unverified.issuer,
    subject: claims.sub,
    audience: audiences,
    claims: pickConditionClaims(
      claims,
      candidates.map(({ credential }) => credential),
    ),
  };

  const mismatches: { federatedCredentialId: string; reason: string }[] = [];
  const matches: typeof candidates = [];
  for (const candidate of candidates) {
    const reason = mismatchReason({
      credential: candidate.credential,
      claims,
      audiences,
    });
    if (reason) {
      mismatches.push({
        federatedCredentialId: candidate.credential.id,
        reason,
      });
    } else {
      matches.push(candidate);
    }
  }
  const matchedAccountIds = new Set(matches.map(({ account }) => account.id));
  if (matchedAccountIds.size === 0) {
    await auditEach(accounts.keys(), "denied", {
      reason: "no_matching_credential",
      mismatches,
      ...evidence,
    });
    return null;
  }
  // A bearer token names no account; one that several trust is refused
  // rather than resolved to whichever happens to come first.
  if (matchedAccountIds.size > 1) {
    await auditEach(matchedAccountIds, "denied", {
      reason: "matches_several_service_accounts",
      ...evidence,
    });
    return null;
  }

  const [{ credential, account }] = matches;
  if (account.disabled) {
    await auditEach([account.id], "denied", {
      reason: "service_account_disabled",
      issuer: unverified.issuer,
    });
    return null;
  }

  const expiresAt = new Date(
    Math.min(claims.exp * 1000, Date.now() + MAX_STORED_LIFETIME_MS),
  );
  await ServiceAccountModel.createFederatedToken({
    serviceAccountId: account.id,
    federatedCredentialId: credential.id,
    name: `Federated: ${credential.name}`,
    expiresAt,
    bearerToken: token,
  });
  await ServiceAccountFederatedCredentialModel.markUsed(credential.id);
  await auditEach([account.id], "success", {
    federatedCredentialId: credential.id,
    federatedCredentialName: credential.name,
    ...evidence,
    tokenExpiresAt: expiresAt.toISOString(),
  });
  logger.info(
    {
      organizationId: account.organizationId,
      serviceAccountId: account.id,
      federatedCredentialId: credential.id,
      issuer: unverified.issuer,
      subject: claims.sub,
    },
    "[workload-identity] Accepted an OIDC token as a service account bearer token",
  );
  return ServiceAccountModel.verifyFederatedBearerToken(token);
}

/**
 * How long a verified bearer token is remembered, at most. A changed or
 * deleted credential revokes it at once; a credential added on another
 * account, which makes the token ambiguous, takes effect within this time.
 */
const MAX_STORED_LIFETIME_MS = 5 * 60 * 1000;

/**
 * Failures that only a correctly signed token reaches: jose checks the
 * signature before the claims, and the rest are checked after it.
 */
const SIGNED_TOKEN_FAILURES = new Set([
  "ERR_JWT_EXPIRED",
  "ERR_JWT_CLAIM_VALIDATION_FAILED",
  "claims_malformed",
  "issued_in_the_future",
  "lifetime_too_long",
]);

/** Three base64url segments: a JWS in compact form. */
const JWT_SHAPE = /^[\w-]+\.[\w-]+\.[\w-]+$/;

/** Refusals audited recently, so a repeated token adds no audit rows. */
const recentRefusals = new LRUCacheManager<true>({
  maxSize: 10_000,
  defaultTtl: 10 * 60 * 1000,
});
