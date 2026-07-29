import { vi } from "vitest";
import db, { schema } from "@/database";
import { AgentToolModel, HookFileModel } from "@/models";
import AgentModel from "@/models/agent";
import AgentVersionModel from "@/models/agent-version";
import { agentSubagentExclusionsService } from "@/services/agent-subagent-exclusions";
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

describe("AgentVersionModel fork-on-write coverage", () => {
  // Config lives across sibling entities that are edited through their own
  // routes/MCP tools, not only AgentModel.update. Each of those write paths
  // forks at its boundary via forkIfChangedBestEffort — these pin that the
  // version history is actually captured, not silently deferred.

  test("hook create/update/delete each fork a new config version", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    expect(await AgentVersionModel.listForAgent(agent.id)).toHaveLength(1);

    const hook = await HookFileModel.create({
      agentId: agent.id,
      organizationId: org.id,
      event: "session_start",
      fileName: "setup.py",
      content: "print('hi')",
      requirements: [],
      enabled: true,
    });
    expect(await AgentVersionModel.listForAgent(agent.id)).toHaveLength(2);
    const afterCreate = await AgentVersionModel.findByAgentAndVersion(
      agent.id,
      2,
    );
    expect(afterCreate?.snapshot.hooks).toEqual([
      {
        event: "session_start",
        fileName: "setup.py",
        content: "print('hi')",
        requirements: [],
        enabled: true,
      },
    ]);

    await HookFileModel.update({
      id: hook.id,
      organizationId: org.id,
      data: { content: "print('bye')" },
    });
    expect(await AgentVersionModel.listForAgent(agent.id)).toHaveLength(3);

    await HookFileModel.delete(hook.id, org.id);
    const versions = await AgentVersionModel.listForAgent(agent.id);
    expect(versions).toHaveLength(4);
    expect(versions[0].snapshot.hooks).toEqual([]);
  });

  test("tool unassign forks a version", async ({
    makeAgent,
    makeTool,
    makeAgentTool,
  }) => {
    const agent = await makeAgent();
    const tool = await makeTool();
    await makeAgentTool(agent.id, tool.id);
    // makeAgentTool inserts without forking, so version the assignment first —
    // otherwise removing it just returns to v1's tool-less snapshot.
    await AgentVersionModel.forkIfChanged(agent.id);
    expect(await AgentVersionModel.listForAgent(agent.id)).toHaveLength(2);

    const deleted = await AgentToolModel.delete(agent.id, tool.id);

    expect(deleted).toBe(true);
    const versions = await AgentVersionModel.listForAgent(agent.id);
    expect(versions).toHaveLength(3);
    expect(versions[0].snapshot.tools).toEqual([]);
  });

  test("subagent-exclusion replace forks a version", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const target = await makeAgent({ organizationId: org.id });

    await agentSubagentExclusionsService.replaceExclusions({
      agentId: agent.id,
      organizationId: org.id,
      excludedSubagentIds: [target.id],
    });

    const versions = await AgentVersionModel.listForAgent(agent.id);
    expect(versions).toHaveLength(2);
    expect(
      versions[0].snapshot.excludedSubagents.map((s) => s.agentId),
    ).toEqual([target.id]);
  });

  test("a fork failure never fails the surrounding write (best-effort)", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    const spy = vi
      .spyOn(AgentVersionModel, "forkIfChanged")
      .mockRejectedValueOnce(new Error("fork exploded"));

    // The config change commits before the fork runs, so the update must still
    // succeed and return the mutated agent even though the fork threw.
    const updated = await AgentModel.update(agent.id, {
      description: "edited",
    });

    expect(updated?.description).toBe("edited");
    expect(spy).toHaveBeenCalledTimes(1);
    // Fork was swallowed → head pointer stays where it was.
    expect(updated?.latestVersion).toBe(1);

    spy.mockRestore();
  });
});
