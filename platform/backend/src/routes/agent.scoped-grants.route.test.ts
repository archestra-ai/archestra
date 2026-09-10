// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise

import { vi } from "vitest";
import db from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import AgentModel from "@/models/agent";
import AgentTeamModel from "@/models/agent-team";
import AuditLogModel from "@/models/audit-log";
import MemberModel from "@/models/member";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import ServiceAccountModel from "@/models/service-account";
import { createFastifyInstance, type FastifyInstanceWithZod } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import routes from "./agent";

vi.mock("@/observability");

describe("agent object grants", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(
    async ({ makeOrganization, makeUser, makeMember, makeCustomRole }) => {
      const org = await makeOrganization();
      organizationId = org.id;
      user = await makeUser();
      const role = await makeCustomRole(org.id, { permission: {} });
      await makeMember(user.id, org.id, { role: role.role });
      app = createFastifyInstance();
      app.addHook("onRequest", async (request) => {
        request.user = user;
        request.organizationId = organizationId;
      });
      registerAuditLogHook(app);
      await app.register(routes);
    },
  );
  afterEach(async () => {
    await app.close();
  });

  test("revoking the creator's grant blocks content edits despite their base update permission", async ({
    makeCustomRole,
    makeAgent,
  }) => {
    const role = await makeCustomRole(organizationId, {
      permission: { agent: ["read", "update"] },
    });
    await MemberModel.updateRole(user.id, organizationId, role.role);
    await db.transaction((tx) =>
      ResourcePermissionPolicyModel.initializeOrganization({
        tx,
        organizationId,
      }),
    );
    const agent = await makeAgent({
      organizationId,
      agentType: "agent",
      authorId: user.id,
      scope: "personal",
    });
    const key = { organizationId, resource: "agent" as const, scope: agent.id };
    const policy = await ResourcePermissionPolicyModel.find(key);
    const before = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}`,
      payload: { name: "Before revocation" },
    });
    expect(before.statusCode, before.body).toBe(200);
    await replacePolicy({
      ...key,
      revision: policy?.revision ?? 0,
      grants: [],
    });
    const denied = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}`,
      payload: { name: "After revocation" },
    });
    expect(denied.statusCode, denied.body).toBe(403);
    expect((await AgentModel.findById(agent.id))?.name).toBe(
      "Before revocation",
    );
  });

  test("viewing a private agent does not grant execution, and execution revocation is immediate", async ({
    makeAgent,
    makeUser,
  }) => {
    const author = await makeUser();
    const agent = await makeAgent({
      agentType: "agent",
      organizationId,
      authorId: author.id,
      scope: "personal",
    });
    const key = { organizationId, resource: "agent" as const, scope: agent.id };
    const subject = { type: "user" as const, id: user.id };
    const access = { userId: user.id, agentId: agent.id, isAgentAdmin: false };
    await replacePolicy({
      ...key,
      revision: 0,
      grants: [{ subject, actions: ["read"] }],
    });
    expect(
      await AgentTeamModel.userHasAgentAccess({ ...access, action: "read" }),
    ).toBe(true);
    expect(
      await AgentTeamModel.userHasAgentAccess({ ...access, action: "use" }),
    ).toBe(false);
    const read = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}`,
    });
    expect(read.statusCode, read.body).toBe(200);
    await replacePolicy({
      ...key,
      revision: 1,
      grants: [{ subject, actions: ["read", "use"] }],
    });
    expect(
      await AgentTeamModel.userHasAgentAccess({ ...access, action: "use" }),
    ).toBe(true);
    await replacePolicy({
      ...key,
      revision: 2,
      grants: [{ subject, actions: ["read"] }],
    });
    expect(
      await AgentTeamModel.userHasAgentAccess({ ...access, action: "use" }),
    ).toBe(false);
  });

  test("a scoped editor can change content but cannot share, delete, or edit another agent", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const author = await makeUser();
    const agent = await makeAgent({
      agentType: "agent",
      organizationId,
      authorId: author.id,
      scope: "org",
    });
    const other = await makeAgent({
      agentType: "agent",
      organizationId,
      authorId: author.id,
      scope: "org",
    });
    await replacePolicy({
      organizationId: organizationId,
      resource: "agent",
      scope: other.id,
      revision: 0,
      grants: [],
    });
    const recipient = await makeUser();
    await makeMember(recipient.id, organizationId);
    await replacePolicy({
      organizationId,
      resource: "agent",
      scope: agent.id,
      revision: 0,
      grants: [
        { subject: { type: "user", id: user.id }, actions: ["read", "update"] },
      ],
    });
    const edited = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}`,
      payload: { name: "Scoped editor update", scope: "org" },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const listed = await app.inject({ method: "GET", url: "/api/agents" });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().data.map((item: { id: string }) => item.id)).toEqual([
      agent.id,
    ]);
    const audit = await AuditLogModel.findPaginated({
      organizationId,
      limit: 10,
      offset: 0,
      resourceId: agent.id,
    });
    expect(audit.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          after: expect.objectContaining({ name: "Scoped editor update" }),
        }),
      ]),
    );
    const shared = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}`,
      payload: { users: [recipient.id] },
    });
    expect(shared.statusCode, shared.body).toBe(400);
    expect((await AgentModel.findById(agent.id))?.users).toEqual([]);
    expect(
      (await app.inject({ method: "DELETE", url: `/api/agents/${agent.id}` }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/agents/${other.id}`,
          payload: { name: "Forbidden edit" },
        })
      ).statusCode,
    ).toBe(404);
    expect((await AgentModel.findById(other.id))?.name).toBe(other.name);
  });

  test("creation persists initial service-account grants and includes them in the audit record", async () => {
    await MemberModel.updateRole(user.id, organizationId, "admin");
    const account = await ServiceAccountModel.create({
      organizationId,
      name: "Build account",
      role: "member",
      createdBy: user.id,
    });
    const grants = [
      {
        subject: { type: "serviceAccount" as const, id: account.id },
        actions: ["read" as const, "use" as const],
      },
    ];
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: {
        ...{
          name: "Created with grants",
          agentType: "agent",
          scope: "personal",
        },
        initialGrants: grants,
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const id = created.json().id;
    expect(
      (
        await ResourcePermissionPolicyModel.find({
          organizationId,
          resource: "agent",
          scope: id,
        })
      )?.grants,
    ).toEqual([
      ...grants,
      {
        subject: { type: "user", id: user.id },
        actions: ["read", "use", "update", "delete", "manage-permissions"],
      },
    ]);
    const audit = await AuditLogModel.findPaginated({
      organizationId,
      limit: 10,
      offset: 0,
      resourceId: id,
    });
    expect(audit.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          after: expect.objectContaining({
            resourcePermissions: [
              ...grants,
              {
                subject: { type: "user", id: user.id },
                actions: [
                  "read",
                  "use",
                  "update",
                  "delete",
                  "manage-permissions",
                ],
              },
            ],
          }),
        }),
      ]),
    );
  });

  test("an empty initial grant list creates explicit creator access that can be revoked", async () => {
    await MemberModel.updateRole(user.id, organizationId, "admin");
    const response = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: {
        name: "Private by grant",
        agentType: "agent",
        scope: "personal",
        initialGrants: [],
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const id = response.json().id;
    const key = { organizationId, resource: "agent" as const, scope: id };
    await MemberModel.updateRole(user.id, organizationId, "member");
    const policy = await ResourcePermissionPolicyModel.find(key);
    expect(policy?.legacySharingMigrated).toBe(true);
    expect(policy?.grants).toEqual([
      {
        subject: { type: "user", id: user.id },
        actions: ["read", "use", "update", "delete", "manage-permissions"],
      },
    ]);
    expect(
      await AgentTeamModel.userHasAgentAccess({
        userId: user.id,
        agentId: id,
        isAgentAdmin: true,
        action: "use",
      }),
    ).toBe(true);
    await replacePolicy({
      ...key,
      revision: policy?.revision ?? 0,
      grants: [],
    });
    expect(
      await AgentTeamModel.userHasAgentAccess({
        userId: user.id,
        agentId: id,
        isAgentAdmin: true,
        action: "use",
      }),
    ).toBe(false);
  });

  test("an invalid initial recipient rejects creation before the resource is inserted", async () => {
    await MemberModel.updateRole(user.id, organizationId, "admin");
    const before = await AgentModel.findAll();
    const rejected = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: {
        ...{
          name: "Created with grants",
          agentType: "agent",
          scope: "personal",
        },
        initialGrants: [
          {
            subject: { type: "user", id: "missing-recipient" },
            actions: ["read"],
          },
        ],
      },
    });
    expect(rejected.statusCode, rejected.body).toBe(400);
    const after = await AgentModel.findAll();
    expect(after.map((item) => item.id).sort()).toEqual(
      before.map((item) => item.id).sort(),
    );
  });
});

async function replacePolicy(
  params: Parameters<typeof ResourcePermissionPolicyModel.replace>[0],
) {
  const policy = await ResourcePermissionPolicyModel.find(params);
  const updated = await ResourcePermissionPolicyModel.replace({
    ...params,
    revision: policy?.revision ?? 0,
  });
  expect(updated).not.toBeNull();
  return updated;
}
