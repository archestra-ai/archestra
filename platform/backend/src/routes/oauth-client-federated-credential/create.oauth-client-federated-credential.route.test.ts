// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
import { ADMIN_ROLE_NAME } from "@archestra/shared";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import AuditLogModel from "@/models/audit-log";
import ManagedOauthClientModel from "@/models/managed-oauth-client";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import { drainBackgroundWork } from "@/utils/background-work";
import oauthClientFederatedCredentialRoutes from "./oauth-client-federated-credential.routes";

const VALID = {
  name: "nightly evals",
  issuer: "https://token.actions.githubusercontent.com",
  audience: "https://archestra.example.com",
  subject: "repo:acme/evals:ref:refs/heads/main",
  claimConditions: { repository: "acme/evals" },
};

describe("POST /api/oauth-clients/:id/federated-credentials", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let caller: User;
  let oauthClientId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    caller = await makeUser();
    await makeMember(caller.id, organizationId, { role: ADMIN_ROLE_NAME });
    // Authored by the caller, so its grants name them.
    oauthClientId = (
      await ManagedOauthClientModel.create({
        organizationId,
        name: "evals",
        scopes: ["llm:proxy"],
        authorId: caller.id,
      })
    ).oauthClient.id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      request.user = caller;
      request.organizationId = organizationId;
      request.authMethod = "session";
    });
    registerAuditLogHook(app);
    await app.register(oauthClientFederatedCredentialRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("creates a trust policy, lists it, and audits the change", async () => {
    const created = await create(VALID);

    expect(created.statusCode, created.body).toBe(200);
    expect(created.json()).toMatchObject({ ...VALID, oauthClientId });
    const listed = await app.inject({
      method: "GET",
      url: `/api/oauth-clients/${oauthClientId}/federated-credentials`,
    });
    expect(listed.json()).toEqual([created.json()]);

    await drainBackgroundWork();
    const { data } = await AuditLogModel.findPaginated({
      organizationId,
      resourceType: "oauthClientFederatedCredential",
      limit: 10,
      offset: 0,
    });
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      action: "oauthClientFederatedCredential.created",
      outcome: "success",
      resourceId: created.json().id,
      after: { issuer: VALID.issuer, subject: VALID.subject },
    });
  });

  test("refuses a client that signs users in rather than itself", async () => {
    oauthClientId = (
      await ManagedOauthClientModel.create({
        organizationId,
        name: "web app",
        grantType: "authorization_code",
        redirectUris: ["https://app.example.com/callback"],
        authorId: caller.id,
      })
    ).oauthClient.id;

    expect((await create(VALID)).statusCode).toBe(400);
  });

  test.each([
    { name: "a private issuer", body: { issuer: "https://10.0.0.5" } },
    {
      name: "a condition on a claim with its own field",
      body: { claimConditions: { sub: "x" } },
    },
  ])("rejects $name", async ({ body }) => {
    expect((await create({ ...VALID, ...body })).statusCode).toBe(400);
  });

  test("rejects a duplicate name on the same client", async () => {
    expect((await create(VALID)).statusCode).toBe(200);

    expect((await create(VALID)).statusCode).toBe(409);
  });

  test("answers 404 to a member who cannot see the client", async ({
    makeUser,
    makeMember,
  }) => {
    caller = await makeUser();
    await makeMember(caller.id, organizationId);

    expect((await create(VALID)).statusCode).toBe(404);
  });

  function create(body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: `/api/oauth-clients/${oauthClientId}/federated-credentials`,
      payload: body,
    });
  }
});
