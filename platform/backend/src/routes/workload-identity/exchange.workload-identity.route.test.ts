// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
import { lookup } from "node:dns/promises";
import fastifyFormbody from "@fastify/formbody";
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import logger from "@/logging";
import AuditLogModel from "@/models/audit-log";
import ServiceAccountModel from "@/models/service-account";
import ServiceAccountFederatedCredentialModel from "@/models/service-account-federated-credential";
import serviceAccountRoutes from "@/routes/service-account";
import { oidcIssuerKeys } from "@/services/workload-identity/oidc-issuer-keys";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "@/test";
import { authenticatedRouteApp } from "@/test/authenticated-route-app";
import { setupTestCacheManager } from "@/test/cache-manager";
import { spyOnLogger } from "@/test/logging";
import { useMswServer } from "@/test/msw";
import workloadIdentityRoutes from "./workload-identity.routes";

// DNS is the process boundary the SSRF guard resolves through.
vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

spyOnLogger();
setupTestCacheManager();

const ISSUER = "https://token.actions.example.com";
const AUDIENCE = "https://archestra.example.com";
const SUBJECT = "repo:acme/infra:ref:refs/heads/main";
const PUBLIC_ADDRESS = [{ address: "93.184.216.34", family: 4 }];
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";
const JWT_TYPE = "urn:ietf:params:oauth:token-type:jwt";
const UNTRUSTED =
  "The token is not trusted for this service account. Check the account's federated credentials.";

let signingKey: CryptoKey;
let issuerJwk: JWK;
/** What the issuer publishes; a test may rotate it. */
let publicJwk: JWK;
let issuerRequests: string[];
let discoveredIssuer: string;

// biome-ignore lint/correctness/useHookAtTopLevel: registers test lifecycle hooks, not a React hook
useMswServer(
  http.get(`${ISSUER}/.well-known/openid-configuration`, ({ request }) => {
    issuerRequests.push(request.url);
    return HttpResponse.json({
      issuer: discoveredIssuer,
      jwks_uri: `${ISSUER}/.well-known/jwks`,
    });
  }),
  http.get(`${ISSUER}/.well-known/jwks`, ({ request }) => {
    issuerRequests.push(request.url);
    return HttpResponse.json({ keys: [publicJwk] });
  }),
);

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  signingKey = privateKey as CryptoKey;
  issuerJwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
});

describe("POST /api/workload-identity/token", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let serviceAccountId: string;
  let credentialId: string;

  beforeEach(async ({ makeOrganization }) => {
    issuerRequests = [];
    discoveredIssuer = ISSUER;
    publicJwk = issuerJwk;
    oidcIssuerKeys.clear();
    vi.mocked(lookup).mockResolvedValue(PUBLIC_ADDRESS as never);
    organizationId = (await makeOrganization()).id;
    const account = await ServiceAccountModel.create({
      organizationId,
      name: "terraform-apply",
      role: "member",
      createdBy: null,
    });
    serviceAccountId = account.id;
    credentialId = (
      await ServiceAccountFederatedCredentialModel.create({
        organizationId,
        serviceAccountId,
        name: "infra main",
        issuer: ISSUER,
        audience: AUDIENCE,
        subject: SUBJECT,
        claimConditions: {
          repository: "acme/infra",
          ref: "refs/heads/main",
        },
        createdBy: null,
      })
    ).id;
    app = await authenticatedRouteApp({
      organizationId,
      routes: [
        // OAuth clients send the exchange form-encoded, as the server parses.
        async (fastify) => {
          await fastify.register(fastifyFormbody);
          await fastify.register(workloadIdentityRoutes);
        },
        serviceAccountRoutes,
      ],
    });
  });

  afterEach(async () => {
    await app.close();
  });

  test("exchanges a matching OIDC token for a short-lived token that authenticates as the account", async () => {
    const oidc = await oidcToken();

    const response = await app.inject({
      method: "POST",
      url: "/api/workload-identity/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: GRANT_TYPE,
        subject_token_type: JWT_TYPE,
        subject_token: oidc,
        service_account_id: serviceAccountId,
      }).toString(),
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json();
    expect(body).toMatchObject({
      issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
      token_type: "Bearer",
      expires_in: 3600,
    });

    // It authenticates as the account, bare or as a Bearer token.
    for (const authorization of [
      body.access_token,
      `Bearer ${body.access_token}`,
    ]) {
      const call = await app.inject({
        method: "GET",
        url: "/api/service-accounts",
        headers: { authorization },
      });
      expect(call.statusCode).toBe(200);
    }
    const verified = await ServiceAccountModel.verifyToken(body.access_token);
    expect(verified?.serviceAccount.id).toBe(serviceAccountId);
    const lifetimeMs = (verified?.token.expiresAt?.getTime() ?? 0) - Date.now();
    expect(lifetimeMs).toBeGreaterThan(59 * 60 * 1000);
    expect(lifetimeMs).toBeLessThanOrEqual(60 * 60 * 1000);

    // Not an API key: it stays out of the account's key list.
    const detail = await ServiceAccountModel.findById(
      serviceAccountId,
      organizationId,
    );
    expect(detail?.tokens).toEqual([]);
    expect(detail?.federatedCredentialCount).toBe(1);

    const [row] = await exchangeAuditRows();
    expect(row).toMatchObject({
      outcome: "success",
      actorType: "service_account",
      resourceId: serviceAccountId,
      after: {
        federatedCredentialId: credentialId,
        issuer: ISSUER,
        subject: SUBJECT,
        claims: { repository: "acme/infra", ref: "refs/heads/main" },
      },
    });
    const logged = JSON.stringify([
      row,
      ...(["error", "warn", "info", "debug"] as const).flatMap(
        (level) => vi.mocked(logger[level]).mock.calls,
      ),
    ]);
    for (const secret of [oidc, body.access_token])
      expect(logged).not.toContain(secret);
  });

  test.each([
    {
      name: "audience",
      claims: { aud: "https://someone-else.example.com" },
      reason: "audience_mismatch",
    },
    {
      name: "subject",
      claims: { sub: "repo:acme/infra:pull_request" },
      reason: "subject_mismatch",
    },
    {
      name: "claim condition",
      claims: { ref: "refs/heads/feature" },
      reason: "claim_mismatch:ref",
    },
  ])("refuses a token whose $name does not match exactly", async ({
    claims,
    reason,
  }) => {
    const response = await exchange(await oidcToken(claims));

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "invalid_grant",
      error_description: UNTRUSTED,
    });
    const [row] = await exchangeAuditRows();
    expect(row).toMatchObject({
      outcome: "denied",
      after: {
        reason: "no_matching_credential",
        mismatches: [{ federatedCredentialId: credentialId, reason }],
      },
    });
  });

  test.each([
    {
      name: "signed by a key the issuer does not publish",
      token: async () => {
        const { privateKey } = await generateKeyPair("RS256");
        return oidcToken({}, { key: privateKey as CryptoKey });
      },
      reason: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
    },
    {
      name: "expired",
      token: () => oidcToken({}, { iat: -3600, exp: -600 }),
      reason: "ERR_JWT_EXPIRED",
    },
    {
      name: "valid for longer than a day",
      token: () => oidcToken({}, { iat: -60, exp: 25 * 3600 }),
      reason: "lifetime_too_long",
    },
    {
      name: "issued in the future",
      token: () => oidcToken({}, { iat: 600, exp: 1200 }),
      reason: "issued_in_the_future",
    },
  ])("refuses a token $name", async ({ token, reason }) => {
    const response = await exchange(await token());

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid_grant");
    const [row] = await exchangeAuditRows();
    expect(row).toMatchObject({ outcome: "failure", after: { reason } });
    expect(await activeFederatedTokens()).toBe(0);
  });

  test("refuses a symmetric (HS256) token before contacting the issuer", async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(SUBJECT)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("a-shared-secret-anyone-could-hold"));

    const response = await exchange(token);

    expect(response.statusCode).toBe(400);
    expect(issuerRequests).toEqual([]);
    const [row] = await exchangeAuditRows();
    expect(row).toMatchObject({
      outcome: "failure",
      after: { reason: "algorithm_not_allowed", algorithm: "HS256" },
    });
  });

  test("never contacts an issuer that no credential of the account names", async () => {
    const response = await exchange(
      await oidcToken({}, { issuer: "https://attacker.example.net" }),
    );

    expect(response.statusCode).toBe(400);
    expect(issuerRequests).toEqual([]);
    expect(lookup).not.toHaveBeenCalled();
    const [row] = await exchangeAuditRows();
    expect(row).toMatchObject({
      outcome: "denied",
      after: {
        reason: "issuer_not_trusted",
        issuer: "https://attacker.example.net",
      },
    });
  });

  test("refuses an issuer whose host resolves to a private address", async () => {
    vi.mocked(lookup).mockResolvedValue([
      { address: "10.0.0.7", family: 4 },
    ] as never);

    const response = await exchange(await oidcToken());

    expect(response.statusCode).toBe(400);
    expect(issuerRequests).toEqual([]);
    const [row] = await exchangeAuditRows();
    expect(row?.after?.reason).toBe(
      "issuer_keys_unavailable: discovery host resolves to a private or loopback address",
    );
  });

  test("refuses keys from a discovery document that names another issuer", async () => {
    discoveredIssuer = "https://other-issuer.example.com";

    const response = await exchange(await oidcToken());

    expect(response.statusCode).toBe(400);
    const [row] = await exchangeAuditRows();
    expect(row?.after?.reason).toBe(
      "issuer_keys_unavailable: discovery document names a different issuer",
    );
  });

  test("follows a key rotation: an unknown kid refetches the issuer's keys", async () => {
    expect((await exchange(await oidcToken())).statusCode).toBe(200);
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    publicJwk = { ...(await exportJWK(publicKey)), kid: "k2", alg: "RS256" };
    vi.useFakeTimers({ now: Date.now() + 2 * 60 * 1000, toFake: ["Date"] });
    try {
      const rotated = await oidcToken(
        {},
        { key: privateKey as CryptoKey, kid: "k2" },
      );
      expect((await exchange(rotated)).statusCode).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  test("deleting the credential, or narrowing it, revokes the tokens it issued", async () => {
    const first = (await exchange(await oidcToken())).json().access_token;
    const second = (await exchange(await oidcToken())).json().access_token;

    // A rename keeps them; a narrower subject does not.
    await ServiceAccountFederatedCredentialModel.update({
      id: credentialId,
      serviceAccountId,
      organizationId,
      data: { name: "renamed" },
    });
    expect(await ServiceAccountModel.verifyToken(first)).not.toBeNull();
    await ServiceAccountFederatedCredentialModel.update({
      id: credentialId,
      serviceAccountId,
      organizationId,
      data: { subject: "repo:acme/infra:environment:production" },
    });
    expect(await ServiceAccountModel.verifyToken(first)).toBeNull();

    const third = (
      await exchange(
        await oidcToken({ sub: "repo:acme/infra:environment:production" }),
      )
    ).json().access_token;
    await ServiceAccountFederatedCredentialModel.delete({
      id: credentialId,
      serviceAccountId,
      organizationId,
    });
    for (const token of [second, third])
      expect(await ServiceAccountModel.verifyToken(token)).toBeNull();
  });

  test("refuses a disabled account", async () => {
    await ServiceAccountModel.update(serviceAccountId, organizationId, {
      disabled: true,
    });

    const response = await exchange(await oidcToken());

    expect(response.statusCode).toBe(400);
    const [row] = await exchangeAuditRows();
    expect(row).toMatchObject({
      outcome: "denied",
      after: { reason: "service_account_disabled" },
    });
  });

  test("answers malformed requests with RFC 6749 error codes", async () => {
    const oidc = await oidcToken();
    const cases = [
      {
        body: { grant_type: "client_credentials" },
        error: "unsupported_grant_type",
      },
      {
        body: { subject_token_type: "urn:ietf:params:oauth:token-type:saml2" },
        error: "invalid_request",
      },
      { body: { service_account_id: "not-a-uuid" }, error: "invalid_request" },
      { body: { subject_token: "not-a-jwt" }, error: "invalid_grant" },
    ];
    for (const { body, error } of cases) {
      const response = await app.inject({
        method: "POST",
        url: "/api/workload-identity/token",
        payload: {
          grant_type: GRANT_TYPE,
          subject_token_type: JWT_TYPE,
          subject_token: oidc,
          service_account_id: serviceAccountId,
          ...body,
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe(error);
    }
  });

  // === helpers

  function exchange(subjectToken: string) {
    return app.inject({
      method: "POST",
      url: "/api/workload-identity/token",
      payload: {
        grant_type: GRANT_TYPE,
        subject_token_type: JWT_TYPE,
        subject_token: subjectToken,
        service_account_id: serviceAccountId,
      },
    });
  }

  async function exchangeAuditRows() {
    const { data } = await AuditLogModel.findPaginated({
      organizationId,
      action: "serviceAccount.token_exchanged",
      limit: 10,
      offset: 0,
    });
    return data;
  }

  async function activeFederatedTokens() {
    const detail = await ServiceAccountModel.findById(
      serviceAccountId,
      organizationId,
    );
    return detail?.tokens.length ?? 0;
  }
});

/**
 * A GitHub-Actions-shaped token for the issuer above. `iat`/`exp` are offsets
 * in seconds from now.
 */
async function oidcToken(
  claims: Record<string, unknown> = {},
  options: {
    key?: CryptoKey;
    kid?: string;
    issuer?: string;
    iat?: number;
    exp?: number;
  } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    repository: "acme/infra",
    ref: "refs/heads/main",
    job_workflow_ref: "acme/infra/.github/workflows/apply.yml@refs/heads/main",
    sub: SUBJECT,
    aud: AUDIENCE,
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: options.kid ?? "k1" })
    .setIssuer(options.issuer ?? ISSUER)
    .setIssuedAt(now + (options.iat ?? 0))
    .setExpirationTime(now + (options.exp ?? 300))
    .sign(options.key ?? signingKey);
}
