// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise

import db, { schema } from "@/database";
import { enterpriseTier } from "@/enterprise-tier";
import A2AContextModel from "@/models/a2a/context";
import A2ATaskModel from "@/models/a2a/task";
import AgentRunModel from "@/models/agent-run";
import ConversationModel from "@/models/conversation";
import ModelModel from "@/models/model";
import ProjectModel from "@/models/project";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import SkillModel from "@/models/skill";
import { describe, expect, test } from "@/test";
import { runScopedResourcePermissionCutover } from "./resource-permissions-cutover";

/**
 * `revision` is the token the permissions editor holds while somebody is
 * editing, so a statement that rewrites an unchanged policy fails their save
 * on every restart. These tests pin that no statement does.
 */
describe("cutover idempotency", () => {
  test("an unconverted session policy settles after one run and never moves again", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    enterpriseTier.setUserCountForTesting(0);
    const org = await makeOrganization({ legacyPermissions: true });
    const owner = await makeUser();
    await makeMember(owner.id, org.id);
    const agent = await makeAgent({ organizationId: org.id });
    const chat = await ConversationModel.create({
      userId: owner.id,
      organizationId: org.id,
      agentId: agent.id,
    });
    const key = {
      organizationId: org.id,
      resource: "conversation" as const,
      scope: chat.id,
    };
    // Seed exactly the policy the conversion would write, but unmigrated —
    // the shape a half-finished earlier cutover leaves behind.
    await db.insert(schema.resourcePermissionPoliciesTable).values({
      ...key,
      legacySharingMigrated: false,
      grants: [
        {
          subject: { type: "user", id: owner.id },
          actions: ["manage-permissions", "read"],
        },
      ],
    });
    const seeded = await ResourcePermissionPolicyModel.find(key);

    await runScopedResourcePermissionCutover();
    const first = await ResourcePermissionPolicyModel.find(key);
    // DEFECT: SESSION_SHARING_CONVERSION's conflict clause carries no
    // `WHERE ... IS DISTINCT FROM` guard (cutover.ts:907-910), unlike the six
    // other statement groups, so it bumps the revision even when the stored
    // grants already match byte for byte.
    expect(first?.grants).toEqual(seeded?.grants);
    expect(first?.revision).toBe((seeded?.revision ?? 0) + 1);

    // The `pending` CTE keeps the damage to that one pass: the row is migrated
    // now, so every later start leaves it alone.
    await runScopedResourcePermissionCutover();
    expect(await ResourcePermissionPolicyModel.find(key)).toEqual(first);
    await runScopedResourcePermissionCutover();
    expect(await ResourcePermissionPolicyModel.find(key)).toEqual(first);
  });

  test("one row of every convertible kind converts once and replays byte-identically", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
    makeCustomRole,
    makeAgent,
    makeApp,
    makeInternalMcpCatalog,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
    makeSecret,
    makeLlmProviderApiKey,
    makeVirtualApiKey,
  }) => {
    enterpriseTier.setUserCountForTesting(0);
    const org = await makeOrganization({ legacyPermissions: true });
    const owner = await makeUser();
    await makeMember(owner.id, org.id);
    const team = await makeTeam(org.id, owner.id);
    // Every flag the retirement statements read, on one role.
    await makeCustomRole(org.id, {
      permission: {
        agent: ["read", "update", "delete", "admin", "team-admin"],
        mcpGateway: ["read", "admin", "deploy-to-restricted"],
        mcpRegistry: ["read", "admin"],
        mcpServerInstallation: ["create", "admin"],
        skill: ["read", "team-admin"],
        app: ["read", "update", "admin"],
        llmModel: ["read", "update"],
        project: ["read", "admin"],
        plugin: ["read", "admin"],
        llmVirtualKey: ["read", "admin"],
        llmProviderApiKey: ["read", "admin"],
        knowledgeSource: ["read", "update", "admin", "deploy-to-restricted"],
        scheduledTask: ["read", "admin"],
        log: ["read", "admin"],
        auditLog: ["read", "admin"],
        serviceAccount: ["read", "update", "delete"],
      },
    });

    const ownership = {
      organizationId: org.id,
      authorId: owner.id,
      scope: "personal" as const,
    };
    await makeAgent({ ...ownership, agentType: "agent" });
    await makeAgent({ ...ownership, agentType: "profile" });
    await makeAgent({ ...ownership, agentType: "mcp_gateway" });
    await makeInternalMcpCatalog(ownership);
    await makeApp({ ...ownership, enabled: true });
    await ModelModel.create({
      externalId: `idempotent-${crypto.randomUUID().slice(0, 8)}`,
      provider: "openai",
      modelId: `idempotent-${crypto.randomUUID().slice(0, 8)}`,
      inputModalities: ["text"],
      outputModalities: ["text"],
      lastSyncedAt: new Date(),
    });
    const skill = await SkillModel.createWithFiles({
      skill: {
        ...ownership,
        name: `idempotent-${crypto.randomUUID().slice(0, 8)}`,
        description: "Replay fixture",
        content: "# Skill",
        metadata: {},
        sourceType: "manual",
      },
      files: [],
    });
    if (!skill) throw new Error("Skill fixture creation failed");
    await ProjectModel.create({
      organizationId: org.id,
      userId: owner.id,
      name: "Replay project",
    });
    const [plugin] = await db
      .insert(schema.pluginsTable)
      .values({
        organizationId: org.id,
        authorId: owner.id,
        scope: "team",
        clientType: "claude-code",
        pluginSlug: `replay-${crypto.randomUUID().slice(0, 8)}`,
        displayName: "Replay plugin",
        contentHash: crypto.randomUUID(),
      })
      .returning();
    await db
      .insert(schema.pluginTeamsTable)
      .values({ pluginId: plugin.id, teamId: team.id });
    const virtualKey = await makeVirtualApiKey(org.id, {
      scope: "team",
      authorId: owner.id,
    });
    await db
      .insert(schema.virtualApiKeyTeamsTable)
      .values({ virtualApiKeyId: virtualKey.id, teamId: team.id });
    const secret = await makeSecret();
    await makeLlmProviderApiKey(org.id, secret.id, {
      scope: "personal",
      userId: owner.id,
    });
    const base = await makeKnowledgeBase(org.id, {
      visibility: "team-scoped",
      teamIds: [team.id],
    });
    await makeKnowledgeBaseConnector(base.id, org.id, {
      visibility: "team-scoped",
      teamIds: [team.id],
    });
    const [file] = await db
      .insert(schema.kbFilesTable)
      .values({
        organizationId: org.id,
        uploadedBy: owner.id,
        visibility: "team-scoped",
        filename: `replay-${crypto.randomUUID().slice(0, 8)}.txt`,
        mimeType: "text/plain",
        sizeBytes: 3,
        contentHash: crypto.randomUUID(),
        data: Buffer.from("abc"),
      })
      .returning();
    await db
      .insert(schema.kbFileTeamsTable)
      .values({ kbFileId: file.id, teamId: team.id });
    const agent = await makeAgent({ organizationId: org.id });
    await ConversationModel.create({
      userId: owner.id,
      organizationId: org.id,
      agentId: agent.id,
    });
    const context = await A2AContextModel.create({
      actorKind: "user",
      actorId: owner.id,
    });
    const task = await A2ATaskModel.create({
      contextId: context.id,
      agentId: agent.id,
      state: "TASK_STATE_COMPLETED",
    });
    await AgentRunModel.create({
      organizationId: org.id,
      taskId: task.id,
      agentId: agent.id,
      actorKind: "user",
      actorId: owner.id,
      actorUserId: owner.id,
      workloadName: `replay-${task.id}`,
      backend: "kubernetes",
      runtimeScope: "test",
    });

    await runScopedResourcePermissionCutover();
    const converted = await readPolicies();
    // Every kind produced a policy, so the comparison below is not vacuous.
    expect(new Set(converted.map((policy) => policy.resource))).toEqual(
      new Set([
        "agent",
        "mcpGateway",
        "mcpRegistry",
        "skill",
        "app",
        "llmModel",
        "project",
        "plugin",
        "llmVirtualKey",
        "llmProviderApiKey",
        "knowledgeBase",
        "knowledgeConnector",
        "knowledgeFile",
        "conversation",
        "agentRun",
        "environment",
        "serviceAccount",
        "scheduledTask",
        "log",
        "auditLog",
      ]),
    );

    for (let restart = 0; restart < 2; restart++) {
      await runScopedResourcePermissionCutover();
      // `revision` included: a bump here is a permissions save that fails for
      // whoever had the editor open across the restart.
      expect(await readPolicies()).toEqual(converted);
    }
  });
});

/** Every stored policy verbatim, `revision` included. */
async function readPolicies() {
  const rows = await db
    .select()
    .from(schema.resourcePermissionPoliciesTable)
    .orderBy(
      schema.resourcePermissionPoliciesTable.resource,
      schema.resourcePermissionPoliciesTable.scope,
    );
  return rows.map(({ updatedAt: _updatedAt, ...policy }) => policy);
}
