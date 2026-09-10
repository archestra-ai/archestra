// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  TOOL_LIST_SKILLS_FULL_NAME,
  TOOL_LOAD_SKILL_FULL_NAME,
} from "@archestra/shared";
import { executeArchestraTool } from "@/archestra-mcp-server";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import AuditLogModel from "@/models/audit-log";
import MemberModel from "@/models/member";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import ServiceAccountModel from "@/models/service-account";
import SkillModel from "@/models/skill";
import { beforeEach, describe, expect, test } from "@/test";
import skillRoutes from "./skill.routes";
import { manifestNamed, useSkillRouteTestApp } from "./skill.test-helpers";

describe("scoped skill grants", () => {
  const ctx = useSkillRouteTestApp(skillRoutes);
  beforeEach(() => registerAuditLogHook(ctx.app));

  test("creates service-account grants with the skill and audits them", async () => {
    await MemberModel.updateRole(ctx.user.id, ctx.organizationId, "admin");
    const account = await ServiceAccountModel.create({
      organizationId: ctx.organizationId,
      name: "Skill automation",
      role: "member",
      createdBy: ctx.user.id,
    });
    const grants = [
      {
        subject: { type: "serviceAccount" as const, id: account.id },
        actions: ["read" as const, "use" as const],
      },
    ];
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/skills",
      payload: {
        content: manifestNamed("shared-at-creation"),
        initialGrants: grants,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const id = response.json().id;
    const key = {
      organizationId: ctx.organizationId,
      resource: "skill" as const,
      scope: id,
    };
    expect((await ResourcePermissionPolicyModel.find(key))?.grants).toEqual([
      ...grants,
      {
        subject: { type: "user", id: ctx.user.id },
        actions: ["read", "use", "update", "delete", "manage-permissions"],
      },
    ]);
    const audit = await AuditLogModel.findPaginated({
      organizationId: ctx.organizationId,
      resourceId: id,
      limit: 10,
      offset: 0,
    });
    expect(audit.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          after: expect.objectContaining({
            resourcePermissions: [
              ...grants,
              {
                subject: { type: "user", id: ctx.user.id },
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

  test("an object-only editor can discover and edit the skill, but cannot execute, share, or delete it", async ({
    makeCustomRole,
    makeUser,
    makeAgent,
  }) => {
    const role = await makeCustomRole(ctx.organizationId, { permission: {} });
    await MemberModel.updateRole(ctx.user.id, ctx.organizationId, role.role);
    const author = await makeUser();
    const target = await SkillModel.createWithFiles({
      skill: {
        organizationId: ctx.organizationId,
        authorId: author.id,
        name: "scoped-skill",
        description: "Original",
        content: manifestNamed("scoped-skill"),
        metadata: {},
        sourceType: "manual",
        scope: "personal",
      },
      files: [],
    });
    if (!target) throw new Error("Skill fixture creation failed");
    const other = await SkillModel.createWithFiles({
      skill: {
        organizationId: ctx.organizationId,
        authorId: author.id,
        name: "other-skill",
        description: "Not granted",
        content: manifestNamed("other-skill"),
        metadata: {},
        sourceType: "manual",
        scope: "org",
      },
      files: [],
    });
    if (!other) throw new Error("Skill fixture creation failed");
    const policy = {
      organizationId: ctx.organizationId,
      resource: "skill" as const,
      scope: target.id,
    };
    await replacePolicy({
      ...policy,
      revision: 0,
      grants: [
        {
          subject: { type: "user", id: ctx.user.id },
          actions: ["read", "update"],
        },
      ],
    });
    await replacePolicy({
      organizationId: ctx.organizationId,
      resource: "skill",
      scope: other.id,
      revision: 0,
      grants: [],
    });
    const list = await ctx.app.inject({ method: "GET", url: "/api/skills" });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().data.map((skill: { id: string }) => skill.id)).toEqual([
      target.id,
    ]);
    const updated = await ctx.app.inject({
      method: "PUT",
      url: `/api/skills/${target.id}`,
      payload: {
        content: manifestNamed("scoped-skill").replace(
          "A scoped skill.",
          "Changed by a scoped editor.",
        ),
      },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    const audit = await AuditLogModel.findPaginated({
      organizationId: ctx.organizationId,
      resourceId: target.id,
      limit: 10,
      offset: 0,
    });
    expect(audit.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          after: expect.objectContaining({
            description: "Changed by a scoped editor.",
          }),
        }),
      ]),
    );
    expect(
      (
        await ctx.app.inject({
          method: "DELETE",
          url: `/api/skills/${target.id}`,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await ctx.app.inject({
          method: "PUT",
          url: `/api/skills/${target.id}`,
          payload: {
            content: manifestNamed("scoped-skill"),
            userIds: [author.id],
          },
        })
      ).statusCode,
    ).toBe(400);
    const agent = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
    });
    const context = {
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      agent: { id: agent.id, name: agent.name },
    };
    const discovered = await executeArchestraTool(
      TOOL_LIST_SKILLS_FULL_NAME,
      {},
      context,
    );
    expect(discovered.isError).not.toBe(true);
    expect(JSON.stringify(discovered.content)).toContain("scoped-skill");
    expect(JSON.stringify(discovered.content)).not.toContain("other-skill");
    expect(
      (
        await executeArchestraTool(
          TOOL_LOAD_SKILL_FULL_NAME,
          { name: "scoped-skill" },
          context,
        )
      ).isError,
    ).toBe(true);
    await replacePolicy({
      ...policy,
      revision: 1,
      grants: [
        {
          subject: { type: "user", id: ctx.user.id },
          actions: ["read", "use"],
        },
      ],
    });
    expect(
      (
        await executeArchestraTool(
          TOOL_LOAD_SKILL_FULL_NAME,
          { name: "scoped-skill" },
          context,
        )
      ).isError,
    ).not.toBe(true);
    expect(
      (
        await ctx.app.inject({
          method: "PUT",
          url: `/api/skills/${target.id}`,
          payload: { content: manifestNamed("scoped-skill") },
        })
      ).statusCode,
    ).toBe(403);
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
