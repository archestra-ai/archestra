// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
import { enterpriseTier } from "@/enterprise-tier";
import logger from "@/logging";
import ManagedOauthClientModel from "@/models/managed-oauth-client";
import OauthClientFederatedCredentialModel from "@/models/oauth-client-federated-credential";
import type { AuditOutcome } from "@/types/audit-log";
import {
  JWT_BEARER_CLIENT_ASSERTION_TYPE,
  type SelectOauthClientFederatedCredential,
} from "@/types/oauth-client-federated-credential";
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
 * Authenticate a managed OAuth client with a workload's own OIDC token in
 * place of its secret: the `client_assertion` of an RFC 7523 client
 * credentials grant, matched against the client's federated credentials the
 * way Microsoft Entra matches an app registration's.
 *
 * The token passes the same checks as a service account's token exchange:
 * an RS256 or ES256 signature from a key its issuer publishes, a lifetime of
 * a day at most, and an exact match of issuer, audience, subject and every
 * claim condition. Only an issuer the client's credentials name is ever
 * contacted. Every outcome for a known client is audited; the token never is.
 */
export async function authenticateOauthClientAssertion(params: {
  clientId: string | undefined;
  clientAssertionType: string | undefined;
  clientAssertion: string;
  request: FederationRequestContext | null;
}): Promise<AssertionResult> {
  if (params.clientAssertionType !== JWT_BEARER_CLIENT_ASSERTION_TYPE)
    return refuse(
      "invalid_request",
      `client_assertion_type must be ${JWT_BEARER_CLIENT_ASSERTION_TYPE}`,
    );
  // A workload's token names the workload, not the client, so the client
  // must name itself.
  if (!params.clientId)
    return refuse(
      "invalid_request",
      "client_id is required with a client_assertion",
    );
  if (!enterpriseTier.isCoreActive())
    return refuse(
      "invalid_client",
      "Client assertions need workload identity federation, an enterprise feature.",
    );

  const unverified = readUnverified(params.clientAssertion);
  if (!unverified)
    return refuse("invalid_client", "client_assertion is not a signed JWT");

  const client = await ManagedOauthClientModel.findByClientId(params.clientId);
  if (!client || client.grantType !== "client_credentials") {
    logger.info(
      { clientId: params.clientId, issuer: unverified.issuer },
      "[workload-identity] Refused a client assertion for an unknown client",
    );
    return refuse("invalid_client", UNTRUSTED_MESSAGE);
  }

  const audit = (entry: {
    outcome: AuditOutcome;
    details: Record<string, unknown>;
  }) =>
    recordFederationAudit({
      kind: "oauthClient",
      account: {
        id: client.id,
        name: client.name,
        organizationId: client.organizationId,
      },
      request: params.request,
      statusCode: entry.outcome === "success" ? 200 : 401,
      ...entry,
    });

  if (!ALLOWED_ALGORITHMS.includes(unverified.alg)) {
    await audit({
      outcome: "failure",
      details: {
        reason: "algorithm_not_allowed",
        algorithm: unverified.alg,
        issuer: unverified.issuer,
      },
    });
    return refuse(
      "invalid_client",
      `client_assertion must be signed with ${ALLOWED_ALGORITHMS.join(" or ")}`,
    );
  }

  if (client.disabled) {
    await audit({
      outcome: "denied",
      details: { reason: "oauth_client_disabled", issuer: unverified.issuer },
    });
    return refuse("invalid_client", UNTRUSTED_MESSAGE);
  }

  const credentials = await OauthClientFederatedCredentialModel.findForIssuer({
    oauthClientId: client.id,
    issuer: unverified.issuer,
  });
  if (credentials.length === 0) {
    await audit({
      outcome: "denied",
      details: { reason: "issuer_not_trusted", issuer: unverified.issuer },
    });
    return refuse("invalid_client", UNTRUSTED_MESSAGE);
  }

  const verified = await verifyIssuerToken({
    token: params.clientAssertion,
    issuer: unverified.issuer,
  });
  if (!verified.ok) {
    await audit({
      outcome: "failure",
      details: { reason: verified.reason, issuer: unverified.issuer },
    });
    return refuse(
      "invalid_client",
      verified.message.replace("subject_token", "client_assertion"),
    );
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
  let matched: SelectOauthClientFederatedCredential | null = null;
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
      details: { reason: "no_matching_credential", mismatches, ...evidence },
    });
    return refuse("invalid_client", UNTRUSTED_MESSAGE);
  }

  await OauthClientFederatedCredentialModel.markUsed(matched.id);
  await audit({
    outcome: "success",
    details: {
      federatedCredentialId: matched.id,
      federatedCredentialName: matched.name,
      ...evidence,
    },
  });
  logger.info(
    {
      organizationId: client.organizationId,
      oauthClientId: client.id,
      federatedCredentialId: matched.id,
      issuer: unverified.issuer,
      subject: claims.sub,
    },
    "[workload-identity] Authenticated an OAuth client with an OIDC token",
  );
  return { ok: true, client, federatedCredentialId: matched.id };
}

/** A client authenticated through one of its federated credentials. */
export type FederatedOauthClient = {
  client: NonNullable<
    Awaited<ReturnType<typeof ManagedOauthClientModel.findByClientId>>
  >;
  federatedCredentialId: string;
};

// === Internal helpers

type AssertionResult =
  | ({ ok: true } & FederatedOauthClient)
  | {
      ok: false;
      error: "invalid_request" | "invalid_client";
      description: string;
    };

/**
 * The one refusal for a token that is valid but not trusted, so a caller
 * holding some valid token cannot map out which policies a client has. The
 * audit log records the actual reason.
 */
const UNTRUSTED_MESSAGE =
  "The client assertion is not trusted for this OAuth client. Check the client's federated credentials.";

function refuse(
  error: "invalid_request" | "invalid_client",
  description: string,
): AssertionResult {
  return { ok: false, error, description };
}
