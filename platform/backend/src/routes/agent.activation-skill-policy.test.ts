import { and, eq } from "drizzle-orm";
import { type Mock, vi } from "vitest";
import { getAgentTypePermissionChecker, userHasPermission } from "@/auth";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import {
  AgentActivationSkillRuleModel,
  AgentVersionModel,
  OrganizationModel,
  ToolModel,
} from "@/models";
import SkillModel from "@/models/skill";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { InsertSkill, Skill, User } from "@/types";

vi.mock("@/auth");
vi.mock("@/observability");

const mockGetAgentTypePermissionChecker = getAgentTypePermissionChecker as Mock;
const mockUserHasPermission = userHasPermission as Mock;

describe("agent activation-skill policy routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    vi.clearAllMocks();
    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(user.id, organizationId);
    mockGetAgentTypePermissionChecker.mockResolvedValue({
      require: vi.fn(),
      isAdmin: vi.fn().mockReturnValue(true),
      isTeamAdmin: vi.fn().mockReturnValue(true),
      hasAnyReadPermission: vi.fn().mockReturnValue(true),
      hasAnyAdminPermission: vi.fn().mockReturnValue(true),
      getAgentTypesWithPermission: vi.fn().mockReturnValue(["agent"]),
    });
    mockUserHasPermission.mockResolvedValue(true);

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });
    registerAuditLogHook(app);
    const { default: agentRoutes } = await import("./agent");
    await app.register(agentRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  async function makeSkill(
    overrides: Partial<InsertSkill> = {},
  ): Promise<Skill> {
    const skill = await SkillModel.createWithFiles({
      skill: {
        organizationId,
        name: `skill-${crypto.randomUUID().slice(0, 8)}`,
        description: "Policy test skill",
        content: "# Instructions",
        scope: "org",
        latestVersion: 1,
        ...overrides,
      } as InsertSkill,
      files: [],
      environmentIds: [],
    });
    if (!skill) throw new Error("failed to create skill");
    return skill;
  }

  test("defaults to All and round-trips independent allow and exclusion rules", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ agentType: "agent", organizationId });
    const skill = await makeSkill();
    const reference = { source: "native" as const, skillId: skill.id };

    const initial = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/activation-skill-policy`,
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({
      mode: "all",
      revision: 0,
      allowedReferences: [],
      excludedReferences: [],
      hiddenAllowedCount: 0,
      hiddenExcludedCount: 0,
    });

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/agents/${agent.id}/activation-skill-policy`,
      payload: {
        expectedRevision: 0,
        mode: "manual",
        operations: [
          { op: "add", disposition: "allow", reference },
          { op: "add", disposition: "exclude", reference },
        ],
      },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      mode: "manual",
      revision: 1,
      allowedReferences: [reference],
      excludedReferences: [reference],
      allowedSkills: [{ reference, name: skill.name }],
      excludedSkills: [{ reference, name: skill.name }],
    });
  });

  test("eligible choices remain available when model-driven discovery is disabled", async () => {
    const skill = await makeSkill();
    const response = await app.inject({
      method: "GET",
      url: "/api/agents/activation-skills?view=eligible&limit=100&offset=0",
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      enabled: false,
      data: [
        {
          name: skill.name,
          reference: { source: "native", skillId: skill.id },
        },
      ],
    });
  });

  test("rejects a stale revision without changing the saved policy", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ agentType: "agent", organizationId });
    const first = await app.inject({
      method: "PATCH",
      url: `/api/agents/${agent.id}/activation-skill-policy`,
      payload: { expectedRevision: 0, mode: "manual" },
    });
    expect(first.statusCode).toBe(200);

    const stale = await app.inject({
      method: "PATCH",
      url: `/api/agents/${agent.id}/activation-skill-policy`,
      payload: { expectedRevision: 0, mode: "all" },
    });
    expect(stale.statusCode).toBe(409);
    const current = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/activation-skill-policy`,
    });
    expect(current.json()).toMatchObject({ mode: "manual", revision: 1 });
  });

  test("does not disclose or discard an unavailable stored reference", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ agentType: "agent", organizationId });
    await AgentActivationSkillRuleModel.addRules({
      agentId: agent.id,
      rules: [
        {
          disposition: "allow",
          reference: {
            source: "plugin",
            pluginId: crypto.randomUUID(),
            skillPath: "skills/private",
          },
        },
      ],
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/activation-skill-policy`,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      allowedReferences: [],
      allowedSkills: [],
      hiddenAllowedCount: 1,
    });
    expect(response.body).not.toContain("skills/private");
  });

  test("allows removing an unavailable stored reference", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ agentType: "agent", organizationId });
    const hiddenReference = {
      source: "plugin" as const,
      pluginId: crypto.randomUUID(),
      skillPath: "skills/removed-private",
    };
    await AgentActivationSkillRuleModel.addRules({
      agentId: agent.id,
      rules: [{ disposition: "allow", reference: hiddenReference }],
    });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/agents/${agent.id}/activation-skill-policy`,
      payload: {
        expectedRevision: 0,
        operations: [
          {
            op: "remove",
            disposition: "allow",
            reference: hiddenReference,
          },
        ],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      revision: 1,
      hiddenAllowedCount: 0,
    });
  });

  test("create persists a staged Manual policy before returning", async () => {
    const skill = await makeSkill();
    const reference = { source: "native" as const, skillId: skill.id };
    const response = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: {
        name: `Policy Agent ${crypto.randomUUID().slice(0, 8)}`,
        agentType: "agent",
        scope: "personal",
        teams: [],
        activationSkillPolicy: {
          mode: "manual",
          allowedReferences: [reference],
          excludedReferences: [],
        },
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      activationSkillMode: "manual",
      activationSkillPolicyRevision: 1,
    });

    const policy = await app.inject({
      method: "GET",
      url: `/api/agents/${response.json().id}/activation-skill-policy`,
    });
    expect(policy.json()).toMatchObject({
      mode: "manual",
      revision: 1,
      allowedReferences: [reference],
    });

    const storedVersion = await AgentVersionModel.findByAgentAndVersion({
      agentId: response.json().id,
      organizationId,
      version: 1,
    });
    expect(storedVersion?.snapshot).toMatchObject({
      activationSkillMode: "manual",
      activationSkillRules: [{ disposition: "allow", reference }],
    });

    const publicVersion = await app.inject({
      method: "GET",
      url: `/api/agents/${response.json().id}/versions/1`,
    });
    expect(publicVersion.statusCode).toBe(200);
    expect(publicVersion.json().snapshot).toMatchObject({
      activationSkillMode: "manual",
      activationSkillRuleCounts: { allowed: 1, excluded: 0 },
    });
    expect(publicVersion.json().snapshot.activationSkillRuleDigest).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(publicVersion.json().snapshot).not.toHaveProperty(
      "activationSkillRules",
    );
    expect(publicVersion.body).not.toContain(skill.id);
  });

  test("create rejects a skill policy for a non-internal agent", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: {
        name: "Gateway with invalid policy",
        agentType: "mcp_gateway",
        scope: "personal",
        teams: [],
        activationSkillPolicy: {
          mode: "all",
          allowedReferences: [],
          excludedReferences: [],
        },
      },
    });
    expect(response.statusCode).toBe(400);
  });

  test("create requires skill read permission when a policy is supplied", async () => {
    await db
      .update(schema.membersTable)
      .set({ role: "role-without-skill-access" })
      .where(
        and(
          eq(schema.membersTable.userId, user.id),
          eq(schema.membersTable.organizationId, organizationId),
        ),
      );
    const response = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: {
        name: "Internal agent without skill permission",
        agentType: "agent",
        scope: "personal",
        teams: [],
        activationSkillPolicy: {
          mode: "all",
          allowedReferences: [],
          excludedReferences: [],
        },
      },
    });
    expect(response.statusCode).toBe(403);
  });

  test("a semantic PATCH no-op preserves revision and emits no audit or cache-visible change", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ agentType: "agent", organizationId });
    const response = await app.inject({
      method: "PATCH",
      url: `/api/agents/${agent.id}/activation-skill-policy`,
      payload: { expectedRevision: 0, mode: "all" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().revision).toBe(0);
    const auditRows = await db
      .select()
      .from(schema.auditLogsTable)
      .where(eq(schema.auditLogsTable.resourceId, agent.id));
    expect(auditRows).toEqual([]);
  });

  test("rejects contradictory operations for the same exact rule", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ agentType: "agent", organizationId });
    const skill = await makeSkill();
    const operation = {
      disposition: "allow" as const,
      reference: { source: "native" as const, skillId: skill.id },
    };
    const response = await app.inject({
      method: "PATCH",
      url: `/api/agents/${agent.id}/activation-skill-policy`,
      payload: {
        expectedRevision: 0,
        operations: [
          { op: "add", ...operation },
          { op: "remove", ...operation },
        ],
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.message).toContain("add and remove");
  });

  test("rejects a PATCH whose resulting disposition exceeds 1000 rules", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ agentType: "agent", organizationId });
    await AgentActivationSkillRuleModel.addRules({
      agentId: agent.id,
      rules: Array.from({ length: 1000 }, (_, index) => ({
        disposition: "allow" as const,
        reference: {
          source: "plugin" as const,
          pluginId: crypto.randomUUID(),
          skillPath: `skills/hidden-${index}`,
        },
      })),
    });
    const skill = await makeSkill();
    const response = await app.inject({
      method: "PATCH",
      url: `/api/agents/${agent.id}/activation-skill-policy`,
      payload: {
        expectedRevision: 0,
        operations: [
          {
            op: "add",
            disposition: "allow",
            reference: { source: "native", skillId: skill.id },
          },
        ],
      },
    });
    expect(response.statusCode).toBe(422);
    const policy = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/activation-skill-policy`,
    });
    expect(policy.json()).toMatchObject({
      revision: 0,
      hiddenAllowedCount: 1000,
    });
  });

  test("PATCH emits an agent audit diff without exact skill references", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ agentType: "agent", organizationId });
    const skill = await makeSkill();
    const response = await app.inject({
      method: "PATCH",
      url: `/api/agents/${agent.id}/activation-skill-policy`,
      payload: {
        expectedRevision: 0,
        mode: "manual",
        operations: [
          {
            op: "add",
            disposition: "allow",
            reference: { source: "native", skillId: skill.id },
          },
        ],
      },
    });
    expect(response.statusCode).toBe(200);

    const rows = await db
      .select({
        before: schema.auditLogsTable.before,
        after: schema.auditLogsTable.after,
      })
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.action, "agent.updated"),
          eq(schema.auditLogsTable.resourceId, agent.id),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].before).toMatchObject({
      activationSkillMode: "all",
      activationSkillRuleCounts: { allowed: 0, excluded: 0 },
    });
    expect(rows[0].after).toMatchObject({
      activationSkillMode: "manual",
      activationSkillRuleCounts: { allowed: 1, excluded: 0 },
    });
    expect(JSON.stringify(rows)).not.toContain(skill.id);
  });

  test("clone preserves a restrictive policy instead of widening to All", async ({
    makeAgent,
  }) => {
    const source = await makeAgent({ agentType: "agent", organizationId });
    const skill = await makeSkill();
    const reference = { source: "native" as const, skillId: skill.id };
    const configured = await app.inject({
      method: "PATCH",
      url: `/api/agents/${source.id}/activation-skill-policy`,
      payload: {
        expectedRevision: 0,
        mode: "manual",
        operations: [{ op: "add", disposition: "allow", reference }],
      },
    });
    expect(configured.statusCode).toBe(200);

    const clone = await app.inject({
      method: "POST",
      url: `/api/agents/${source.id}/clone`,
      payload: { scope: "personal" },
    });
    expect(clone.statusCode, clone.body).toBe(200);
    const policy = await app.inject({
      method: "GET",
      url: `/api/agents/${clone.json().id}/activation-skill-policy`,
    });
    expect(policy.json()).toMatchObject({
      mode: "manual",
      allowedReferences: [reference],
    });
  });

  test("version restore reapplies the historical skill policy", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ agentType: "agent", organizationId });
    const skill = await makeSkill();
    const reference = { source: "native" as const, skillId: skill.id };
    await app.inject({
      method: "PATCH",
      url: `/api/agents/${agent.id}/activation-skill-policy`,
      payload: {
        expectedRevision: 0,
        mode: "manual",
        operations: [{ op: "add", disposition: "allow", reference }],
      },
    });
    const manualAgent = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}`,
    });
    const manualVersion = manualAgent.json().latestVersion;

    await app.inject({
      method: "PATCH",
      url: `/api/agents/${agent.id}/activation-skill-policy`,
      payload: { expectedRevision: 1, mode: "all" },
    });
    const beforeRestore = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}`,
    });
    const restored = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/versions/${manualVersion}/restore`,
      payload: { baseVersion: beforeRestore.json().latestVersion },
    });
    expect(restored.statusCode, restored.body).toBe(200);

    const policy = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/activation-skill-policy`,
    });
    expect(policy.json()).toMatchObject({
      mode: "manual",
      allowedReferences: [reference],
    });
  });

  test("same-environment card counts batch candidates but apply each agent's policy", async ({
    makeAgent,
  }) => {
    await OrganizationModel.patch(organizationId, { skillToolsEnabled: true });
    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
    const suffix = crypto.randomUUID().slice(0, 8);
    const manual = await makeAgent({
      agentType: "agent",
      organizationId,
      name: `Manual ${suffix}`,
    });
    const all = await makeAgent({
      agentType: "agent",
      organizationId,
      name: `All ${suffix}`,
    });
    await Promise.all([
      ToolModel.assignSkillToolsToAgent(manual.id, organizationId),
      ToolModel.assignSkillToolsToAgent(all.id, organizationId),
    ]);
    const first = await makeSkill({ name: `first-${suffix}` });
    await makeSkill({ name: `second-${suffix}` });
    await makeSkill({
      name: first.name,
      scope: "personal",
      authorId: user.id,
    });
    const configured = await app.inject({
      method: "PATCH",
      url: `/api/agents/${manual.id}/activation-skill-policy`,
      payload: {
        expectedRevision: 0,
        mode: "manual",
        operations: [
          {
            op: "add",
            disposition: "allow",
            reference: { source: "native", skillId: first.id },
          },
        ],
      },
    });
    expect(configured.statusCode).toBe(200);

    const response = await app.inject({
      method: "GET",
      url: `/api/agents?agentTypes=agent&name=${suffix}&limit=10&offset=0&includeActivationSkillsCount=true`,
    });
    expect(response.statusCode).toBe(200);
    expect(
      Object.fromEntries(
        response
          .json()
          .data.map(
            (agent: { name: string; activationSkillsCount: number }) => [
              agent.name,
              agent.activationSkillsCount,
            ],
          ),
      ),
    ).toEqual({ [`Manual ${suffix}`]: 1, [`All ${suffix}`]: 2 });
  });
});

import { ARCHESTRA_MCP_CATALOG_ID } from "@archestra/shared";
