// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
import { lookup } from "node:dns/promises";
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import AuditLogModel from "@/models/audit-log";
import ServiceAccountFederatedCredentialModel from "@/models/service-account-federated-credential";
import {
  authenticateMCPGatewayRequest,
  describeGatewayAuthFailure,
  validateMCPGatewayToken,
} from "@/routes/mcp-gateway/utils";
import { beforeAll, beforeEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { spyOnLogger } from "@/test/logging";
import { useMswServer } from "@/test/msw";
import { verifyServiceAccountBearer } from "./federated-bearer";
import { oidcIssuerKeys } from "./oidc-issuer-keys";

// DNS is the process boundary the SSRF guard resolves through.
vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

spyOnLogger();
setupTestCacheManager();

const ISSUER = "https://idp.substrate.example.com";
const AUDIENCE = "https://archestra.example.com";
const ACTOR = "actor/support/triage";
const PUBLIC_ADDRESS = [{ address: "93.184.216.34", family: 4 }];

let signingKey: CryptoKey;
let publicJwk: JWK;
let issuerRequests: string[];
let issuerDown: boolean;

// biome-ignore lint/correctness/useHookAtTopLevel: registers test lifecycle hooks, not a React hook
useMswServer(
  http.get(`${ISSUER}/.well-known/openid-configuration`, ({ request }) => {
    issuerRequests.push(request.url);
    if (issuerDown) return new HttpResponse(null, { status: 503 });
    return HttpResponse.json({
      issuer: ISSUER,
      jwks_uri: `${ISSUER}/openid/v1/jwks`,
    });
  }),
  http.get(`${ISSUER}/openid/v1/jwks`, ({ request }) => {
    issuerRequests.push(request.url);
    return HttpResponse.json({ keys: [publicJwk] });
  }),
);

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  signingKey = privateKey as CryptoKey;
  publicJwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256" };
});

describe("a workload's OIDC token as a bearer token", () => {
  beforeEach(() => {
    issuerRequests = [];
    issuerDown = false;
    oidcIssuerKeys.clear();
    vi.mocked(lookup).mockResolvedValue(PUBLIC_ADDRESS as never);
  });

  test("reaches a gateway as the service account that trusts it, and is verified once", async ({
    makeOrganization,
    makeUser,
    makeTeam,
    makeAgent,
    makeServiceAccount,
  }) => {
    const org = await makeOrganization();
    const team = await makeTeam(org.id, (await makeUser()).id, {
      name: "Support",
    });
    const agent = await makeAgent({
      organizationId: org.id,
      access: { teams: [team.id] },
    });
    const account = await makeServiceAccount(org.id, { teamId: team.id });
    await trust({ organizationId: org.id, serviceAccountId: account.id });
    const token = await actorJwt({ sub: ACTOR });

    const first = await validateMCPGatewayToken(agent.id, token);
    const fetchesAfterFirst = issuerRequests.length;
    const second = await validateMCPGatewayToken(agent.id, token);

    expect(first?.serviceAccountId).toBe(account.id);
    expect(second?.serviceAccountId).toBe(account.id);
    expect(fetchesAfterFirst).toBeGreaterThan(0);
    expect(issuerRequests).toHaveLength(fetchesAfterFirst);
    const [event] = await exchangeEvents(org.id);
    expect(event.outcome).toBe("success");
    expect(event.after).toMatchObject({ mode: "bearer", subject: ACTOR });
  });

  test("refuses a token for another actor, and audits why", async ({
    makeOrganization,
    makeServiceAccount,
  }) => {
    const org = await makeOrganization();
    const account = await makeServiceAccount(org.id);
    await trust({ organizationId: org.id, serviceAccountId: account.id });

    const result = await verifyServiceAccountBearer({
      token: await actorJwt({ sub: "actor/support/other" }),
    });

    expect(result).toBeNull();
    const [event] = await exchangeEvents(org.id);
    expect(event.outcome).toBe("denied");
    expect(event.after).toMatchObject({
      mode: "bearer",
      reason: "no_matching_credential",
    });
  });

  test("audits each refused token once, however often it is sent", async ({
    makeOrganization,
    makeServiceAccount,
  }) => {
    const org = await makeOrganization();
    const account = await makeServiceAccount(org.id);
    await trust({ organizationId: org.id, serviceAccountId: account.id });
    const token = await actorJwt({ sub: "actor/support/replayed" });

    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await verifyServiceAccountBearer({ token })).toBeNull();
    }
    const another = await actorJwt({ sub: "actor/support/replayed" });
    expect(await verifyServiceAccountBearer({ token: another })).toBeNull();

    expect(await exchangeEvents(org.id)).toHaveLength(2);
  });

  test("asks an issuer that is down for its keys once for requests arriving together", async ({
    makeOrganization,
    makeServiceAccount,
  }) => {
    const org = await makeOrganization();
    const account = await makeServiceAccount(org.id);
    await trust({ organizationId: org.id, serviceAccountId: account.id });
    issuerDown = true;

    const results = await Promise.all(
      Array.from({ length: 5 }, async () =>
        verifyServiceAccountBearer({ token: await actorJwt({ sub: ACTOR }) }),
      ),
    );
    await verifyServiceAccountBearer({ token: await actorJwt({ sub: ACTOR }) });

    expect(results).toEqual([null, null, null, null, null]);
    expect(issuerRequests).toHaveLength(1);
  });

  test("acts as neither of two service accounts that both trust it", async ({
    makeOrganization,
    makeServiceAccount,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    for (const account of [
      await makeServiceAccount(org.id),
      await makeServiceAccount(org.id),
    ]) {
      await trust({ organizationId: org.id, serviceAccountId: account.id });
    }

    const token = await actorJwt({ sub: ACTOR });
    const result = await verifyServiceAccountBearer({ token });

    expect(result).toBeNull();
    expect((await exchangeEvents(org.id)).map((event) => event.after)).toEqual([
      expect.objectContaining({ reason: "matches_several_service_accounts" }),
      expect.objectContaining({ reason: "matches_several_service_accounts" }),
    ]);
    // The gateway's answer covers a refused workload token too, without
    // revealing which issuers a federated credential names.
    const outcome = await authenticateMCPGatewayRequest(agent.id, token);
    expect(outcome.result).toBeNull();
    expect(
      outcome.reason && describeGatewayAuthFailure(outcome.reason),
    ).toContain("exactly one service account's federated credential trusts it");
  });

  test("refuses a forged token naming a trusted issuer without auditing it", async ({
    makeOrganization,
    makeServiceAccount,
  }) => {
    const org = await makeOrganization();
    const account = await makeServiceAccount(org.id);
    await trust({ organizationId: org.id, serviceAccountId: account.id });
    const { privateKey } = await generateKeyPair("ES256");

    const result = await verifyServiceAccountBearer({
      token: await actorJwt({ sub: ACTOR, key: privateKey as CryptoKey }),
    });

    expect(result).toBeNull();
    expect(await exchangeEvents(org.id)).toEqual([]);
  });

  test("never contacts an issuer no credential names", async () => {
    const result = await verifyServiceAccountBearer({
      token: await actorJwt({ sub: ACTOR }),
    });

    expect(result).toBeNull();
    expect(issuerRequests).toEqual([]);
  });

  test("stops working once its credential is deleted", async ({
    makeOrganization,
    makeServiceAccount,
  }) => {
    const org = await makeOrganization();
    const account = await makeServiceAccount(org.id);
    const credential = await trust({
      organizationId: org.id,
      serviceAccountId: account.id,
    });
    const token = await actorJwt({ sub: ACTOR });
    expect(await verifyServiceAccountBearer({ token })).not.toBeNull();

    await ServiceAccountFederatedCredentialModel.delete({
      id: credential.id,
      serviceAccountId: account.id,
      organizationId: org.id,
    });

    expect(await verifyServiceAccountBearer({ token })).toBeNull();
  });
});

function trust(params: { organizationId: string; serviceAccountId: string }) {
  return ServiceAccountFederatedCredentialModel.create({
    ...params,
    name: "support triage actor",
    issuer: ISSUER,
    audience: AUDIENCE,
    subject: ACTOR,
    claimConditions: {},
    createdBy: null,
  });
}

/** An Agent Substrate actor JWT: an audience array and a nested actor claim. */
function actorJwt(params: { sub: string; key?: CryptoKey }) {
  return new SignJWT({
    "actor.ate.dev": {
      atespace: "support",
      actorName: params.sub.split("/").at(-1),
      actorUID: "3f1c2a9e",
    },
  })
    .setProtectedHeader({ alg: "ES256", kid: "k1", typ: "JWT" })
    .setIssuer(ISSUER)
    .setSubject(params.sub)
    .setAudience([AUDIENCE])
    .setIssuedAt()
    .setExpirationTime("15m")
    .setJti(crypto.randomUUID())
    .sign(params.key ?? signingKey);
}

async function exchangeEvents(organizationId: string) {
  const { data } = await AuditLogModel.findPaginated({
    organizationId,
    action: "serviceAccount.token_exchanged",
    limit: 10,
    offset: 0,
  });
  return data;
}
