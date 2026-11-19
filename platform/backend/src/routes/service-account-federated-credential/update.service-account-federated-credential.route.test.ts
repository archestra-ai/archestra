// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
import { ADMIN_ROLE_NAME } from "@archestra/shared";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import AuditLogModel from "@/models/audit-log";
import ServiceAccountModel from "@/models/service-account";
import ServiceAccountFederatedCredentialModel from "@/models/service-account-federated-credential";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import { drainBackgroundWork } from "@/utils/background-work";
import serviceAccountFederatedCredentialRoutes from "./service-account-federated-credential.routes";

describe("PATCH /api/service-accounts/:id/federated-credentials/:credentialId", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let caller: User;
  let serviceAccountId: string;
  let credentialId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    caller = await makeUser();
    await makeMember(caller.id, organizationId, { role: ADMIN_ROLE_NAME });
    serviceAccountId = (
      await ServiceAccountModel.create({
        organizationId,
        name: "terraform",
        role: "member",
        createdBy: caller.id,
      })
    ).id;
    credentialId = (
      await ServiceAccountFederatedCredentialModel.create({
        organizationId,
        serviceAccountId,
        name: "infra",
        issuer: "https://token.actions.githubusercontent.com",
        audience: "https://archestra.example.com",
        subject: "repo:acme/infra:ref:refs/heads/main",
        claimConditions: {},
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

  test("updates the trust policy and audits its before and after", async () => {
    const url = `/api/service-accounts/${serviceAccountId}/federated-credentials/${credentialId}`;

    const updated = await app.inject({
      method: "PATCH",
      url,
      payload: { claimConditions: { environment: "production" } },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json().claimConditions).toEqual({
      environment: "production",
    });

    await drainBackgroundWork();
    const { data } = await AuditLogModel.findPaginated({
      organizationId,
      resourceType: "serviceAccountFederatedCredential",
      outcome: "success",
      limit: 10,
      offset: 0,
    });
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      action: "serviceAccountFederatedCredential.updated",
      resourceId: credentialId,
      before: { claimConditions: {} },
      after: { claimConditions: { environment: "production" } },
    });
  });

  test("cannot reach another account's credential through this account's path", async () => {
    const other = await ServiceAccountModel.create({
      organizationId,
      name: "other",
      role: "member",
      createdBy: caller.id,
    });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/service-accounts/${other.id}/federated-credentials/${credentialId}`,
      payload: { subject: "anything" },
    });

    expect(response.statusCode).toBe(404);
    expect(
      await ServiceAccountFederatedCredentialModel.findById({
        id: credentialId,
        serviceAccountId,
        organizationId,
      }),
    ).not.toBeNull();
  });
});
