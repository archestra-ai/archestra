import { ADMIN_ROLE_NAME } from "@shared";
import { AgentModel, SkillModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { MAX_SKILL_FILE_BYTES } from "@/skills/github-import";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

interface MigrationField {
  field: string;
  detail: string;
}

interface ConvertResponse {
  skill: {
    name: string;
    description: string;
    content: string;
    scope: string;
    metadata: Record<string, string>;
  };
  report: { carried: MigrationField[]; annotated: MigrationField[] };
  deletedAgent: boolean;
}

describe("POST /api/agents/:id/convert-to-skill", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    user = await makeUser();
    organizationId = (await makeOrganization()).id;
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: skillRoutes } = await import("./skill");
    await app.register(skillRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("converts an agent into a skill with provenance metadata", async ({
    makeInternalAgent,
  }) => {
    const agent = await makeInternalAgent({
      organizationId,
      name: "Support Helper",
      scope: "personal",
      systemPrompt: "You are a support assistant. Be concise.",
      description: "Helps with tickets",
      icon: "🎧",
      suggestedPrompts: [{ summaryTitle: "Refund", prompt: "Issue a refund?" }],
      teams: [],
      labels: [],
      knowledgeBaseIds: [],
      connectorIds: [],
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/convert-to-skill`,
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as ConvertResponse;

    expect(body.skill.name).toBe("support-helper");
    expect(body.skill.content).toContain(
      "You are a support assistant. Be concise.",
    );
    expect(body.skill.content).toContain("## Example prompts");
    // the conversion is never mentioned in the body.
    expect(body.skill.content).not.toContain("Migrated");
    expect(body.skill.metadata.origin).toBe("agent");
    expect(body.skill.metadata.originAgentId).toBe(agent.id);
    expect(body.skill.metadata.icon).toBe("🎧");
    expect(body.deletedAgent).toBe(false);
    expect(body.report.carried.map((field) => field.field)).toContain(
      "systemPrompt",
    );
    // the REST path persists the agent's scope, so it reports it carried.
    expect(
      body.report.carried.find((field) => field.field === "scope")?.detail,
    ).toBe("personal");

    // by default non-destructive: the skill persisted, the agent is untouched.
    const stored = await SkillModel.findByName(
      organizationId,
      "support-helper",
    );
    expect(stored?.metadata.originAgentId).toBe(agent.id);
    expect(await AgentModel.findById(agent.id, user.id, true)).not.toBeNull();
  });

  test("lists tool bindings as recommended tools", async ({
    makeInternalAgent,
    makeTool,
    makeAgentTool,
  }) => {
    const tool = await makeTool({ name: "slack__send" });
    const agent = await makeInternalAgent({
      organizationId,
      name: "Tooled Agent",
      scope: "personal",
      systemPrompt: "Do work.",
      teams: [],
      labels: [],
      knowledgeBaseIds: [],
      connectorIds: [],
    });
    await makeAgentTool(agent.id, tool.id, {
      credentialResolutionMode: "dynamic",
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/convert-to-skill`,
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as ConvertResponse;
    expect(body.skill.content).toContain("## Recommended tools");
    expect(body.skill.content).toContain("slack__send");
    expect(body.skill.content).not.toContain("## Requirements");
  });

  test("uses an explicit description and can delete the source agent", async ({
    makeInternalAgent,
  }) => {
    const agent = await makeInternalAgent({
      organizationId,
      name: "Disposable Agent",
      scope: "personal",
      systemPrompt: "Do work.",
      description: null,
      teams: [],
      labels: [],
      knowledgeBaseIds: [],
      connectorIds: [],
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/convert-to-skill`,
      payload: { description: "Handles disposable work", deleteAgent: true },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as ConvertResponse;
    expect(body.skill.description).toBe("Handles disposable work");
    expect(body.deletedAgent).toBe(true);
    expect(body.report.carried.map((field) => field.field)).toContain(
      "description",
    );

    // the agent is soft-deleted, so it no longer resolves through normal lookup.
    expect(await AgentModel.findById(agent.id, user.id, true)).toBeNull();
  });

  test("rejects built-in agents", async ({ makeInternalAgent }) => {
    const agent = await makeInternalAgent({
      organizationId,
      name: "Built In",
      scope: "org",
      builtInAgentConfig: {
        name: "policy-configuration-subagent",
        autoConfigureOnToolDiscovery: false,
      },
      teams: [],
      labels: [],
      knowledgeBaseIds: [],
      connectorIds: [],
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/convert-to-skill`,
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });

  test("rejects non-agent types", async ({ makeInternalAgent }) => {
    const gateway = await makeInternalAgent({
      organizationId,
      name: "Gateway",
      agentType: "mcp_gateway",
      scope: "org",
      teams: [],
      labels: [],
      knowledgeBaseIds: [],
      connectorIds: [],
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${gateway.id}/convert-to-skill`,
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });

  test("returns 409 when a skill of the same name already exists", async ({
    makeInternalAgent,
  }) => {
    await SkillModel.createWithFiles({
      skill: {
        organizationId,
        authorId: user.id,
        name: "duplicate-agent",
        description: "existing",
        content: "# existing",
        metadata: {},
        sourceType: "manual",
        scope: "personal",
      },
      files: [],
    });

    const agent = await makeInternalAgent({
      organizationId,
      name: "Duplicate Agent",
      scope: "personal",
      systemPrompt: "x",
      teams: [],
      labels: [],
      knowledgeBaseIds: [],
      connectorIds: [],
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/convert-to-skill`,
      payload: {},
    });

    expect(response.statusCode).toBe(409);
  });

  test("keeps the source agent on a name conflict so deleteAgent stays retry-safe", async ({
    makeInternalAgent,
  }) => {
    const conflicting = await SkillModel.createWithFiles({
      skill: {
        organizationId,
        authorId: user.id,
        name: "retry-agent",
        description: "existing",
        content: "# existing",
        metadata: {},
        sourceType: "manual",
        scope: "personal",
      },
      files: [],
    });
    if (!conflicting) throw new Error("setup: expected conflicting skill");

    const agent = await makeInternalAgent({
      organizationId,
      name: "Retry Agent",
      scope: "personal",
      systemPrompt: "x",
      teams: [],
      labels: [],
      knowledgeBaseIds: [],
      connectorIds: [],
    });

    // conversion fails on the name conflict; because create+delete share one
    // transaction, the source agent must NOT have been deleted.
    const failed = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/convert-to-skill`,
      payload: { deleteAgent: true },
    });
    expect(failed.statusCode).toBe(409);
    expect(await AgentModel.findById(agent.id, user.id, true)).not.toBeNull();

    // clear the conflict and retry — the agent still exists, so it converts
    // and deletes cleanly with no leftover partial state.
    await SkillModel.delete(conflicting.id);

    const retried = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/convert-to-skill`,
      payload: { deleteAgent: true },
    });
    expect(retried.statusCode).toBe(200);
    expect((retried.json() as ConvertResponse).deletedAgent).toBe(true);
    expect(await AgentModel.findById(agent.id, user.id, true)).toBeNull();
  });

  test("rejects an agent whose converted content exceeds the skill size limit", async ({
    makeInternalAgent,
  }) => {
    const agent = await makeInternalAgent({
      organizationId,
      name: "Oversized Agent",
      scope: "personal",
      systemPrompt: "x".repeat(MAX_SKILL_FILE_BYTES + 1),
      teams: [],
      labels: [],
      knowledgeBaseIds: [],
      connectorIds: [],
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/convert-to-skill`,
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });

  test("returns 404 (not 400) for a non-agent resource the caller cannot read", async ({
    makeInternalAgent,
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    // a role that can create skills but cannot read MCP gateways.
    const role = await makeCustomRole(organizationId, {
      permission: { agent: ["read"], skill: ["read", "create"] },
    });
    const limited = await makeUser();
    await makeMember(limited.id, organizationId, { role: role.role });

    const gateway = await makeInternalAgent({
      organizationId,
      name: "Hidden Gateway",
      agentType: "mcp_gateway",
      scope: "org",
      teams: [],
      labels: [],
      knowledgeBaseIds: [],
      connectorIds: [],
    });

    // point the request at the limited user (the onRequest hook reads `user`).
    user = limited;

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${gateway.id}/convert-to-skill`,
      payload: {},
    });

    // the caller can't read MCP gateways, so existence must not leak as a 400.
    expect(response.statusCode).toBe(404);
  });

  test("returns 404 for an unknown agent", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/agents/11111111-1111-4111-8111-111111111111/convert-to-skill",
      payload: {},
    });

    expect(response.statusCode).toBe(404);
  });
});
