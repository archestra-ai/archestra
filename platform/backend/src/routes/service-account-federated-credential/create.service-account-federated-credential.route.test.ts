// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
import { ADMIN_ROLE_NAME } from "@archestra/shared";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import AuditLogModel from "@/models/audit-log";
import ServiceAccountModel from "@/models/service-account";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import { drainBackgroundWork } from "@/utils/background-work";
import serviceAccountFederatedCredentialRoutes from "./service-account-federated-credential.routes";

const VALID = {
  name: "infra apply",
  issuer: "https://token.actions.githubusercontent.com",
  audience: "https://archestra.example.com",
  subject: "repo:acme/infra:environment:production",
  claimConditions: { repository: "acme/infra" },
};

describe("POST /api/service-accounts/:id/federated-credentials", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let caller: User;
  let serviceAccountId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    caller = await makeUser();
    await makeMember(caller.id, organizationId, { role: ADMIN_ROLE_NAME });
    // Created by the caller, so its access policy names them.
    serviceAccountId = (
      await ServiceAccountModel.create({
        organizationId,
        name: "terraform",
        role: "member",
        createdBy: caller.id,
      })
    ).id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      request.user = caller;
      request.organizationId = organizationId;
      request.authMethod = "session";
    });
    registerAuditLogHook(app);
    await app.register(serviceAccountFederatedCredentialRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("creates a trust policy, lists it, and audits the change", async () => {
    const created = await create(VALID);

    expect(created.statusCode, created.body).toBe(200);
    expect(created.json()).toMatchObject({ ...VALID, serviceAccountId });
    const listed = await app.inject({
      method: "GET",
      url: `/api/service-accounts/${serviceAccountId}/federated-credentials`,
    });
    expect(listed.json()).toEqual([created.json()]);

    await drainBackgroundWork();
    const { data } = await AuditLogModel.findPaginated({
      organizationId,
      resourceType: "serviceAccountFederatedCredential",
      limit: 10,
      offset: 0,
    });
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      action: "serviceAccountFederatedCredential.created",
      outcome: "success",
      resourceId: created.json().id,
      after: { issuer: VALID.issuer, subject: VALID.subject },
    });
  });

  test.each([
    {
      name: "a plain http issuer",
      body: { issuer: "http://token.actions.githubusercontent.com" },
    },
    {
      name: "an issuer with a query",
      body: { issuer: "https://issuer.example.com/?tenant=1" },
    },
    { name: "a private issuer", body: { issuer: "https://10.0.0.5" } },
    { name: "a loopback issuer", body: { issuer: "https://localhost:8443" } },
    {
      name: "a condition on a claim with its own field",
      body: { claimConditions: { aud: "x" } },
    },
    {
      name: "a wildcard-looking claim name",
      body: { claimConditions: { "repo*": "acme/infra" } },
    },
  ])("rejects $name", async ({ body }) => {
    const response = await create({ ...VALID, ...body });

    expect(response.statusCode).toBe(400);
  });

  test("rejects a duplicate name on the same account", async () => {
    expect((await create(VALID)).statusCode).toBe(200);

    expect((await create(VALID)).statusCode).toBe(409);
  });

  test("answers 404 to a member who cannot manage the account", async ({
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
      url: `/api/service-accounts/${serviceAccountId}/federated-credentials`,
      payload: body,
    });
  }
});
