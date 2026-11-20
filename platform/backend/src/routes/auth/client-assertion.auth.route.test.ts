// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
import { lookup } from "node:dns/promises";
import formbody from "@fastify/formbody";
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import config from "@/config";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import AuditLogModel from "@/models/audit-log";
import ManagedOauthClientModel from "@/models/managed-oauth-client";
import OAuthAccessTokenModel from "@/models/oauth-access-token";
import OauthClientFederatedCredentialModel from "@/models/oauth-client-federated-credential";
import authRoutes from "@/routes/auth";
import { oidcIssuerKeys } from "@/services/workload-identity/oidc-issuer-keys";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { spyOnLogger } from "@/test/logging";
import { useMswServer } from "@/test/msw";
import { JWT_BEARER_CLIENT_ASSERTION_TYPE } from "@/types/oauth-client-federated-credential";

// DNS is the process boundary the SSRF guard resolves through.
vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

spyOnLogger();
setupTestCacheManager();

const ISSUER = "https://token.actions.example.com";
const AUDIENCE = "https://archestra.example.com";
const SUBJECT = "repo:acme/evals:ref:refs/heads/main";
const UNTRUSTED =
  "The client assertion is not trusted for this OAuth client. Check the client's federated credentials.";

let signingKey: CryptoKey;
let publicJwk: JWK;

// biome-ignore lint/correctness/useHookAtTopLevel: registers test lifecycle hooks, not a React hook
useMswServer(
  http.get(`${ISSUER}/.well-known/openid-configuration`, () =>
    HttpResponse.json({
      issuer: ISSUER,
      jwks_uri: `${ISSUER}/.well-known/jwks`,
    }),
  ),
  http.get(`${ISSUER}/.well-known/jwks`, () =>
    HttpResponse.json({ keys: [publicJwk] }),
  ),
);

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  signingKey = privateKey as CryptoKey;
  publicJwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
});

describe("POST /api/auth/oauth2/token with a client assertion", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let clientId: string;
  let oauthClientId: string;
  let credentialId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    config.authRateLimitDisabled = true;
    app = createFastifyInstance();
    await app.register(formbody);
    await app.register(authRoutes);
    oidcIssuerKeys.clear();
    vi.mocked(lookup).mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
    ] as never);
    organizationId = (await makeOrganization()).id;
    const author = await makeUser();
    const created = await ManagedOauthClientModel.create({
      organizationId,
      name: "nightly-evals",
      scopes: ["llm:proxy"],
      authorId: author.id,
    });
    clientId = created.oauthClient.clientId;
    oauthClientId = created.oauthClient.id;
    credentialId = (
      await OauthClientFederatedCredentialModel.create({
        organizationId,
        oauthClientId,
        name: "evals main",
        issuer: ISSUER,
        audience: AUDIENCE,
        subject: SUBJECT,
        claimConditions: { repository: "acme/evals" },
        createdBy: null,
      })
    ).id;
  });

  afterEach(async () => {
    await app.close();
  });

  test("issues the client's ordinary access token for a matching OIDC token, with no secret", async () => {
    const result = await assertAs(await oidcToken());

    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toMatchObject({
      token_type: "Bearer",
      expires_in: 3600,
      scope: "llm:proxy",
    });
    const accessToken = String(result.json().access_token);
    expect(accessToken.startsWith("oauth_at_")).toBe(true);
    const stored = await OAuthAccessTokenModel.getByTokenHash(
      OAuthAccessTokenModel.hashTokenForLookup(accessToken),
    );
    expect(stored).toMatchObject({ clientId });

    const [row] = await auditRows();
    expect(row).toMatchObject({
      action: "oauthClient.token_exchanged",
      outcome: "success",
      resourceType: "oauthClient",
      resourceId: oauthClientId,
      after: { federatedCredentialId: credentialId, subject: SUBJECT },
    });
  });

  test.each([
    {
      name: "subject",
      claims: { sub: "repo:acme/evals:pull_request" },
      reason: "subject_mismatch",
    },
    {
      name: "claim condition",
      claims: { repository: "acme/other" },
      reason: "claim_mismatch:repository",
    },
  ])("refuses a token whose $name does not match", async ({
    claims,
    reason,
  }) => {
    const result = await assertAs(await oidcToken(claims));

    expect(result.statusCode).toBe(401);
    expect(result.json()).toEqual({
      error: "invalid_client",
      error_description: UNTRUSTED,
    });
    const [row] = await auditRows();
    expect(row).toMatchObject({
      outcome: "denied",
      after: {
        reason: "no_matching_credential",
        mismatches: [{ federatedCredentialId: credentialId, reason }],
      },
    });
  });

  test("refuses a token signed by a key the issuer does not publish", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    const result = await assertAs(await oidcToken({}, privateKey as CryptoKey));

    expect(result.statusCode).toBe(401);
    expect(result.json().error).toBe("invalid_client");
  });

  test("refuses a secret and an assertion together, and a missing client_id", async () => {
    const token = await oidcToken();
    const both = await tokenRequest({
      client_id: clientId,
      client_secret: "anything",
      client_assertion: token,
      client_assertion_type: JWT_BEARER_CLIENT_ASSERTION_TYPE,
    });
    expect(both.statusCode).toBe(400);
    expect(both.json().error).toBe("invalid_request");

    const anonymous = await tokenRequest({
      client_assertion: token,
      client_assertion_type: JWT_BEARER_CLIENT_ASSERTION_TYPE,
    });
    expect(anonymous.statusCode).toBe(400);
    expect(anonymous.json().error).toBe("invalid_request");
  });

  test("deleting the credential revokes the tokens it issued", async () => {
    const issued = await assertAs(await oidcToken());
    const tokenHash = OAuthAccessTokenModel.hashTokenForLookup(
      String(issued.json().access_token),
    );
    expect(await OAuthAccessTokenModel.getByTokenHash(tokenHash)).toBeTruthy();

    await OauthClientFederatedCredentialModel.delete({
      id: credentialId,
      oauthClientId,
      organizationId,
    });

    expect(await OAuthAccessTokenModel.getByTokenHash(tokenHash)).toBeFalsy();
  });

  test("narrowing the credential revokes its tokens; renaming it does not", async () => {
    const issued = await assertAs(await oidcToken());
    const tokenHash = OAuthAccessTokenModel.hashTokenForLookup(
      String(issued.json().access_token),
    );

    await OauthClientFederatedCredentialModel.update({
      id: credentialId,
      oauthClientId,
      organizationId,
      data: { name: "evals on main" },
    });
    expect(await OAuthAccessTokenModel.getByTokenHash(tokenHash)).toBeTruthy();

    await OauthClientFederatedCredentialModel.update({
      id: credentialId,
      oauthClientId,
      organizationId,
      data: { claimConditions: { repository: "acme/evals", ref: "main" } },
    });
    expect(await OAuthAccessTokenModel.getByTokenHash(tokenHash)).toBeFalsy();
  });

  // === Helpers

  function assertAs(token: string) {
    return tokenRequest({
      client_id: clientId,
      client_assertion: token,
      client_assertion_type: JWT_BEARER_CLIENT_ASSERTION_TYPE,
    });
  }

  function tokenRequest(fields: Record<string, string>) {
    return app.inject({
      method: "POST",
      url: "/api/auth/oauth2/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "client_credentials",
        ...fields,
      }).toString(),
    });
  }

  async function auditRows() {
    const { data } = await AuditLogModel.findPaginated({
      organizationId,
      action: "oauthClient.token_exchanged",
      limit: 10,
      offset: 0,
    });
    return data;
  }
});

async function oidcToken(
  claims: Record<string, unknown> = {},
  key: CryptoKey = signingKey,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ repository: "acme/evals", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject((claims.sub as string | undefined) ?? SUBJECT)
    .setIssuedAt(now - 30)
    .setExpirationTime(now + 600)
    .sign(key);
}
