import db, { schema } from "@/database";
import AgentModel from "@/models/agent";
import AgentVersionModel from "@/models/agent-version";
import { describe, expect, test } from "@/test";
import type { AgentConfigSnapshot } from "@/types/agent-version";

describe("AgentVersionModel", () => {
  test("create forks version 1 with a config-only snapshot", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ description: "first draft" });

    expect(agent.latestVersion).toBe(1);

    const versions = await AgentVersionModel.listForAgent(agent.id);
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe(1);
    expect(versions[0].snapshot.name).toBe(agent.name);
    expect(versions[0].snapshot.description).toBe("first draft");

    // Sharing and identity/singleton state is deliberately not versioned.
    expect(versions[0].snapshot).not.toHaveProperty("scope");
    expect(versions[0].snapshot).not.toHaveProperty("teams");
    expect(versions[0].snapshot).not.toHaveProperty("labels");
    expect(versions[0].snapshot).not.toHaveProperty("slug");
    expect(versions[0].snapshot).not.toHaveProperty("isDefault");
  });

  test("scalar config change forks a new head", async ({ makeAgent }) => {
    const agent = await makeAgent();

    const updated = await AgentModel.update(agent.id, {
      description: "second draft",
    });

    expect(updated?.latestVersion).toBe(2);
    const head = await AgentVersionModel.findByAgentAndVersion(agent.id, 2);
    expect(head?.snapshot.description).toBe("second draft");
    // Version 1 is immutable history.
    const v1 = await AgentVersionModel.findByAgentAndVersion(agent.id, 1);
    expect(v1?.snapshot.description).toBeNull();
  });

  test("update producing identical config does not fork", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();

    const updated = await AgentModel.update(agent.id, { name: agent.name });

    expect(updated?.latestVersion).toBe(1);
    expect(await AgentVersionModel.listForAgent(agent.id)).toHaveLength(1);
  });

  test("relational-only change (no agents-row write) still forks", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();

    const updated = await AgentModel.update(agent.id, {
      suggestedPrompts: [
        { summaryTitle: "Greet", prompt: "Say hello politely" },
      ],
    });

    expect(updated?.latestVersion).toBe(2);
    const head = await AgentVersionModel.findByAgentAndVersion(agent.id, 2);
    expect(head?.snapshot.suggestedPrompts).toEqual([
      { summaryTitle: "Greet", prompt: "Say hello politely" },
    ]);
  });

  test("sharing-only change (teams) does not fork", async ({
    makeAgent,
    makeOrganization,
    makeTeam,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const agent = await makeAgent({ organizationId: org.id });

    const updated = await AgentModel.update(agent.id, { teams: [team.id] });

    expect(updated?.teams.map((t) => t.id)).toEqual([team.id]);
    expect(updated?.latestVersion).toBe(1);
    expect(await AgentVersionModel.listForAgent(agent.id)).toHaveLength(1);
  });

  test("tool assignment changes the snapshot on the next fork", async ({
    makeAgent,
    makeTool,
    makeAgentTool,
  }) => {
    const agent = await makeAgent();
    const tool = await makeTool();
    await makeAgentTool(agent.id, tool.id);

    const fork = await AgentVersionModel.forkIfChanged(agent.id);

    expect(fork).toEqual({ version: 2, forked: true });
    const head = await AgentVersionModel.findByAgentAndVersion(agent.id, 2);
    expect(head?.snapshot.tools).toEqual([
      {
        toolId: tool.id,
        name: tool.name,
        mcpServerId: null,
        credentialResolutionMode: "static",
      },
    ]);

    // Re-forking with no further changes is suppressed by the content hash.
    const again = await AgentVersionModel.forkIfChanged(agent.id);
    expect(again).toEqual({ version: 2, forked: false });
  });

  test("legacy agent (latestVersion 0) forks version 1 on its first config write", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    // Raw insert simulating a row that predates versioning: no version rows,
    // latest_version at its migration default of 0.
    const [row] = await db
      .insert(schema.agentsTable)
      .values({
        name: "Legacy Agent",
        organizationId: org.id,
        agentType: "mcp_gateway",
      })
      .returning();

    expect(row.latestVersion).toBe(0);
    expect(await AgentVersionModel.listForAgent(row.id)).toHaveLength(0);

    const updated = await AgentModel.update(row.id, {
      description: "first write after rollout",
    });

    expect(updated?.latestVersion).toBe(1);
    const head = await AgentVersionModel.findByAgentAndVersion(row.id, 1);
    expect(head?.snapshot.description).toBe("first write after rollout");
  });

  test("forkIfChanged returns null for a missing agent", async () => {
    const fork = await AgentVersionModel.forkIfChanged(crypto.randomUUID());
    expect(fork).toBeNull();
  });

  test("hard delete cascades version rows", async ({ makeAgent }) => {
    const agent = await makeAgent();
    expect(await AgentVersionModel.listForAgent(agent.id)).toHaveLength(1);

    await AgentModel.hardDelete(agent.id);

    expect(await AgentVersionModel.listForAgent(agent.id)).toHaveLength(0);
  });

  test("content hash is insensitive to object key order", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    const [head] = await AgentVersionModel.listForAgent(agent.id);

    const reordered = Object.fromEntries(
      Object.entries(head.snapshot).reverse(),
    ) as AgentConfigSnapshot;

    expect(AgentVersionModel.computeContentHash(reordered)).toBe(
      head.contentHash,
    );
  });
});
