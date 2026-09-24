// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { vi } from "vitest";
import { enterpriseTier } from "@/enterprise-tier";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import AuditLogModel from "@/models/audit-log";
import ConversationModel from "@/models/conversation";
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

  test("saves and audits mixed chat recipients and denies changes from a viewer", async ({
    makeAgent,
    makeUser,
    makeMember,
    makeTeam,
  }) => {
    const owner = user;
    const reader = await makeUser();
    await makeMember(reader.id, organizationId);
    const team = await makeTeam(organizationId, owner.id);
    const agent = await makeAgent({ organizationId });
    const conversation = await ConversationModel.create({
      organizationId,
      userId: owner.id,
      agentId: agent.id,
    });
    const url = `/api/resource-permissions/conversation/${conversation.id}`;
    const grants = [
      {
        subject: { type: "user", id: owner.id },
        actions: ["read", "manage-permissions"],
      },
      { subject: { type: "user", id: reader.id }, actions: ["read"] },
      { subject: { type: "team", id: team.id }, actions: ["read"] },
    ];
    const saved = await app.inject({
      method: "PUT",
      url,
      // Creating the chat wrote its owner's policy at revision 1.
      payload: { revision: 1, grants },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ revision: 2, grants });
    const audit = await AuditLogModel.findPaginated({
      organizationId,
      resourceId: conversation.id,
      limit: 10,
      offset: 0,
    });
    expect(audit.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "resourcePermissions.updated",
          after: expect.objectContaining({ grants }),
        }),
      ]),
    );
    user = reader;
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "PUT",
          url,
          payload: { revision: 2, grants: [] },
        })
      ).statusCode,
    ).toBe(403);
  });

  for (const endpoint of ["creation-subjects", "*/subjects"]) {
    test(`${endpoint} searches people by name or email without exposing other organizations`, async ({
      makeUser,
      makeMember,
      makeOrganization,
    }) => {
      const recipient = await makeUser({
        name: "Synthetic Recipient",
        email: "recipient_unique@example.com",
      });
      await makeMember(recipient.id, organizationId);
      const foreignOrganization = await makeOrganization();
      const outsider = await makeUser({
        name: "Synthetic Recipient Elsewhere",
        email: "recipient_unique@elsewhere.example.com",
      });
      await makeMember(outsider.id, foreignOrganization.id);
      const wildcardMatch = await makeUser({
        name: "Unrelated Person",
        email: "recipientXunique@example.com",
      });
      await makeMember(wildcardMatch.id, organizationId);

      for (const query of ["synthetic recipient", "RECIPIENT_UNIQUE"]) {
        const response = await app.inject({
          method: "GET",
          url: `/api/resource-permissions/agent/${endpoint}?query=${encodeURIComponent(query)}`,
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toEqual([
          {
            subject: { type: "user", id: recipient.id },
            name: recipient.name,
            email: recipient.email,
          },
        ]);
      }
    });
  }

  test.each([
    "agent",
    "mcpGateway",
    "skill",
    "scheduledTask",
    "log",
    "auditLog",
  ] as const)("%s rejects retired team-relative scope", async (resource) => {
    const key = { organizationId, resource, scope: "teams:*" };
    const before = await ResourcePermissionPolicyModel.find(key);
    const url = `/api/resource-permissions/${resource}/teams:*`;
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: `${url}/subjects` })).statusCode,
    ).toBe(400);
    const response = await app.inject({
      method: "PUT",
      url,
      payload: { revision: 0, grants: [] },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(await ResourcePermissionPolicyModel.find(key)).toEqual(before);
  });

  test("service accounts remain available for explicit all-resource grants", async () => {
    const account = await ServiceAccountModel.create({
      organizationId,
      createdBy: user.id,
      name: "Synthetic release automation",
      role: "member",
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/resource-permissions/agent/*/subjects",
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject: { type: "serviceAccount", id: account.id },
        }),
      ]),
    );
  });

  test("audits retiring the legacy audience even when the selected recipients are unchanged", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({
      organizationId,
      agentType: "agent",
      authorId: user.id,
    });
    const policy = await ResourcePermissionPolicyModel.find({
      organizationId,
      resource: "agent",
      scope: agent.id,
    });
    expect(policy?.legacyOrganizationAudience).toBe(true);
    const response = await app.inject({
      method: "PUT",
      url: `/api/resource-permissions/agent/${agent.id}`,
      payload: { revision: policy?.revision, grants: policy?.grants },
    });
    expect(response.statusCode, response.body).toBe(200);
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
          before: expect.objectContaining({ legacyOrganizationAudience: true }),
          after: expect.objectContaining({ legacyOrganizationAudience: false }),
        }),
      ]),
    );
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
      authorId: user.id,
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/resource-permissions/agent/${agent.id}`,
    });
    expect(response.statusCode, response.body).toBe(200);
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

  test("a permission manager who is not the owner can revoke access while preserving the owner's grant", async ({
    makeAgent,
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const agent = await makeAgent({
      organizationId,
      agentType: "agent",
      authorId: user.id,
      access: "personal",
    });
    const manager = await makeUser();
    const reader = await makeUser();
    const role = await makeCustomRole(organizationId, { permission: {} });
    await makeMember(manager.id, organizationId, { role: role.role });
    await makeMember(reader.id, organizationId, { role: role.role });
    const url = `/api/resource-permissions/agent/${agent.id}`;
    const current = await ResourcePermissionPolicyModel.find({
      organizationId,
      resource: "agent",
      scope: agent.id,
    });
    const grants = [
      ...(current?.grants ?? []),
      // Every grant is one preset, and the only one carrying
      // manage-permissions is full access, so a manager below full access
      // no longer exists. Refusing delegation beyond the caller's own grants
      // is covered in services/resource-permissions.test.ts.
      {
        subject: { type: "user", id: manager.id },
        actions: ["read", "use", "update", "delete", "manage-permissions"],
      },
      { subject: { type: "user", id: reader.id }, actions: ["read"] },
    ];
    const setup = await app.inject({
      method: "PUT",
      url,
      payload: { revision: current?.revision, grants },
    });
    expect(setup.statusCode, setup.body).toBe(200);
    user = manager;
    const retained = grants.filter((grant) => grant.subject.id !== reader.id);
    const revoked = await app.inject({
      method: "PUT",
      url,
      payload: { revision: setup.json().revision, grants: retained },
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect((await app.inject({ method: "GET", url })).json().grants).toEqual(
      expect.arrayContaining(
        retained.map((grant) => expect.objectContaining(grant)),
      ),
    );
    expect(
      await ResourcePermissions.allows({
        organizationId,
        userId: reader.id,
        resource: "agent",
        scope: agent.id,
        action: "read",
      }),
    ).toBe(false);
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
          before: expect.objectContaining({ grants }),
          after: expect.objectContaining({ grants: retained }),
        }),
      ]),
    );
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
      access: "personal",
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
            // The only agent preset carrying manage-permissions.
            actions: ["read", "use", "update", "delete", "manage-permissions"],
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

  test("an organization-wide grant does not open the sharing of another user's own provider key", async ({
    makeUser,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const owner = await makeUser();
    await makeMember(owner.id, organizationId);
    const secret = await makeSecret({ secret: { apiKey: "sk-owner-only" } });
    const ownKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "openai",
      userId: owner.id,
    });
    const wildcard = {
      organizationId,
      resource: "llmProviderApiKey" as const,
      scope: "*",
    };
    const initial = await ResourcePermissionPolicyModel.find(wildcard);
    await ResourcePermissionPolicyModel.replace({
      ...wildcard,
      revision: initial?.revision ?? 0,
      grants: [
        ...(initial?.grants ?? []),
        {
          subject: { type: "user", id: user.id },
          actions: ["read", "use", "update", "delete", "manage-permissions"],
        },
      ],
    });
    const url = `/api/resource-permissions/llmProviderApiKey/${ownKey.id}`;
    const before = await ResourcePermissionPolicyModel.find({
      organizationId,
      resource: "llmProviderApiKey",
      scope: ownKey.id,
    });

    const read = await app.inject({ method: "GET", url });
    expect(read.statusCode, read.body).toBe(403);
    const saved = await app.inject({
      method: "PUT",
      url,
      payload: {
        revision: before?.revision ?? 0,
        grants: [
          {
            subject: { type: "user", id: user.id },
            actions: ["read", "use"],
          },
        ],
      },
    });
    expect(saved.statusCode, saved.body).toBe(403);
    expect(
      await ResourcePermissionPolicyModel.find({
        organizationId,
        resource: "llmProviderApiKey",
        scope: ownKey.id,
      }),
    ).toEqual(before);
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
        // The edit preset: every stored grant is exactly one preset.
        actions: ["read", "use", "update"],
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
    // The role exists before the agent: organization-wide visibility is stored
    // as a grant to every role that holds `agent:read`, so a role created
    // afterwards reaches nothing until someone grants it.
    const role = await makeCustomRole(organizationId, {
      role: "agent_reader",
      permission: { agent: ["read"] },
    });
    const agent = await makeAgent({
      agentType: "agent",
      organizationId,
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
