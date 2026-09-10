// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { vi } from "vitest";
import { enterpriseTier } from "@/enterprise-tier";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import AuditLogModel from "@/models/audit-log";
import MemberModel from "@/models/member";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import ServiceAccountModel from "@/models/service-account";
import { createFastifyInstance, type FastifyInstanceWithZod } from "@/server";
import { ResourcePermissions } from "@/services/resource-permissions";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import resourcePermissionRoutes from "./resource-permission.routes";

vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    enterpriseFeatures: { core: false },
  }),
);

describe("resource permission routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    enterpriseTier.setUserCountForTesting(0);
    const org = await makeOrganization();
    organizationId = org.id;
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: "admin" });
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      request.user = user;
      request.organizationId = organizationId;
    });
    registerAuditLogHook(app);
    await app.register(resourcePermissionRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("an expired enterprise entitlement still permits revocation but rejects new grants", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const agent = await makeAgent({
      organizationId,
      agentType: "agent",
      authorId: user.id,
    });
    const reader = await makeUser();
    await makeMember(reader.id, organizationId);
    const url = `/api/resource-permissions/agent/${agent.id}`;
    const grants = [
      { subject: { type: "user", id: reader.id }, actions: ["read"] },
    ];
    const initial = await app.inject({
      method: "PUT",
      url,
      payload: { revision: 1, grants },
    });
    expect(initial.statusCode, initial.body).toBe(200);
    enterpriseTier.setUserCountForTesting(1000);
    const expanded = await app.inject({
      method: "PUT",
      url,
      payload: {
        revision: 2,
        grants: [{ ...grants[0], actions: ["read", "update"] }],
      },
    });
    expect(expanded.statusCode, expanded.body).toBe(403);
    const revoked = await app.inject({
      method: "PUT",
      url,
      payload: { revision: 2, grants: [] },
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(revoked.json().grants).toEqual([]);
  });

  test("migrated resources do not resurrect legacy elevated role flags", async ({
    makeUser,
    makeMember,
    makeCustomRole,
    makeAgent,
  }) => {
    const readerRole = await makeCustomRole(organizationId, {
      permission: { agent: ["read", "update"] },
    });
    const scopeRole = await makeCustomRole(organizationId, {
      permission: { agent: ["admin"] },
    });
    const editor = await makeUser({ name: "Composed editor" });
    const flagOnly = await makeUser({ name: "Scope flag only" });
    await makeMember(editor.id, organizationId, {
      role: `${readerRole.role},${scopeRole.role}`,
    });
    await makeMember(flagOnly.id, organizationId, { role: scopeRole.role });
    const account = await ServiceAccountModel.create({
      organizationId,
      name: "Deployment automation",
      role: `${readerRole.role},${scopeRole.role}`,
      createdBy: user.id,
    });
    const agent = await makeAgent({
      organizationId,
      agentType: "agent",
      scope: "org",
      authorId: user.id,
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/resource-permissions/agent/${agent.id}`,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().legacyAccess).toEqual([]);
    for (const userId of [
      editor.id,
      flagOnly.id,
      `service-account:${account.id}`,
    ]) {
      expect(
        await ResourcePermissions.allows({
          organizationId,
          userId,
          resource: "agent",
          scope: agent.id,
          action: "update",
        }),
      ).toBe(false);
    }
  });

  test("can revoke one's last direct grant without a misleading failed save", async ({
    makeUser,
    makeMember,
    makeCustomRole,
    makeAgent,
  }) => {
    const agent = await makeAgent({
      agentType: "agent",
      organizationId,
      authorId: user.id,
      scope: "personal",
    });
    const recipient = await makeUser();
    const role = await makeCustomRole(organizationId, { permission: {} });
    await makeMember(recipient.id, organizationId, { role: role.role });
    const url = `/api/resource-permissions/agent/${agent.id}`;
    const granted = await app.inject({
      method: "PUT",
      url,
      payload: {
        revision: 1,
        grants: [
          {
            subject: { type: "user", id: recipient.id },
            actions: ["read", "manage-permissions"],
          },
        ],
      },
    });
    expect(granted.statusCode).toBe(200);
    user = recipient;
    const removed = await app.inject({
      method: "PUT",
      url,
      payload: { revision: 2, grants: [] },
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json()).toMatchObject({
      revision: 3,
      grants: [],
      effectiveActions: [],
    });
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(403);
  });

  test("reports wildcard access separately and cannot revoke it through the object policy", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const agent = await makeAgent({
      agentType: "agent",
      organizationId,
      authorId: user.id,
    });
    const recipient = await makeUser({ name: "Resource reader" });
    await makeMember(recipient.id, organizationId);
    const wildcard = await app.inject({
      method: "PUT",
      url: "/api/resource-permissions/agent/*",
      payload: {
        revision: 1,
        grants: [
          { subject: { type: "user", id: recipient.id }, actions: ["read"] },
        ],
      },
    });
    expect(wildcard.statusCode, wildcard.body).toBe(200);
    const url = `/api/resource-permissions/agent/${agent.id}`;
    const cleared = await app.inject({
      method: "PUT",
      url,
      payload: { revision: 1, grants: [] },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({
      grants: [],
      inheritedGrants: [
        {
          name: "Resource reader",
          subject: { type: "user", id: recipient.id },
          actions: ["read"],
        },
      ],
    });
  });

  test("rejects duplicate recipient rows without saving an ambiguous policy", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({
      agentType: "agent",
      organizationId,
      authorId: user.id,
    });
    const before = await ResourcePermissionPolicyModel.find({
      organizationId,
      resource: "agent",
      scope: agent.id,
    });
    const response = await app.inject({
      method: "PUT",
      url: `/api/resource-permissions/agent/${agent.id}`,
      payload: {
        revision: 1,
        grants: [
          { subject: { type: "user", id: user.id }, actions: ["read"] },
          { subject: { type: "user", id: user.id }, actions: ["update"] },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(
      await ResourcePermissionPolicyModel.find({
        organizationId,
        resource: "agent",
        scope: agent.id,
      }),
    ).toEqual(before);
  });

  test("persists and audits service-account grants, returns them on reload, and rejects stale saves", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({
      agentType: "agent",
      organizationId,
      authorId: user.id,
    });
    const account = await ServiceAccountModel.create({
      createdBy: null,
      organizationId,
      name: "Release automation",
      role: "member",
    });
    const url = `/api/resource-permissions/agent/${agent.id}`;
    const grants = [
      {
        subject: { type: "serviceAccount", id: account.id },
        actions: ["read", "update"],
      },
    ];
    const before = await ResourcePermissionPolicyModel.find({
      organizationId,
      resource: "agent",
      scope: agent.id,
    });
    const saved = await app.inject({
      method: "PUT",
      url,
      payload: { revision: 1, grants },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ revision: 2, grants });
    expect((await app.inject({ method: "GET", url })).json()).toMatchObject({
      grants,
    });
    const stale = await app.inject({
      method: "PUT",
      url,
      payload: { revision: 1, grants: [] },
    });
    expect(stale.statusCode).toBe(409);
    const audit = await AuditLogModel.findPaginated({
      organizationId,
      limit: 10,
      offset: 0,
      resourceId: agent.id,
    });
    expect(audit.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "resourcePermissions.updated",
          before: expect.objectContaining({ grants: before?.grants }),
          after: expect.objectContaining({ grants }),
        }),
      ]),
    );
  });

  test("cannot grant access to a foreign resource or recipient", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const foreign = await makeOrganization();
    const outsider = await makeUser();
    await makeMember(outsider.id, foreign.id);
    const foreignAgent = await makeAgent({
      agentType: "agent",
      organizationId: foreign.id,
      authorId: outsider.id,
    });
    const localAgent = await makeAgent({
      agentType: "agent",
      organizationId,
      authorId: user.id,
    });
    const before = await ResourcePermissionPolicyModel.find({
      organizationId,
      resource: "agent",
      scope: localAgent.id,
    });
    const payload = {
      revision: 1,
      grants: [
        { subject: { type: "user", id: outsider.id }, actions: ["read"] },
      ],
    };
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/resource-permissions/agent/${foreignAgent.id}`,
          payload,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/resource-permissions/agent/${localAgent.id}`,
          payload,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      await ResourcePermissionPolicyModel.find({
        organizationId,
        resource: "agent",
        scope: localAgent.id,
      }),
    ).toEqual(before);
  });

  test("read-only access cannot change grants or enumerate grant recipients", async ({
    makeAgent,
    makeCustomRole,
  }) => {
    const agent = await makeAgent({
      agentType: "agent",
      organizationId,
      scope: "org",
    });
    const role = await makeCustomRole(organizationId, {
      role: "agent_reader",
      permission: { agent: ["read"] },
    });
    await MemberModel.updateRole(user.id, organizationId, role.role);
    const url = `/api/resource-permissions/agent/${agent.id}`;
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: `${url}/subjects` })).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "PUT",
          url,
          payload: { revision: 1, grants: [] },
        })
      ).statusCode,
    ).toBe(403);
  });
});
