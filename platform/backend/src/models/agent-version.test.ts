import { eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import {
  AgentConnectorAssignmentModel,
  AgentToolModel,
  HookFileModel,
} from "@/models";
import AgentModel from "@/models/agent";
import AgentVersionModel from "@/models/agent-version";
import { agentSubagentExclusionsService } from "@/services/agent-subagent-exclusions";
import { assignToolToAgent } from "@/services/agent-tool-assignment";
import { describe, expect, test } from "@/test";
import type { AgentConfigSnapshot, AgentVersion } from "@/types/agent-version";

type AgentRef = { id: string; organizationId: string };

/** Newest-first version list; both reads are organization-scoped. */
async function listVersions(agent: AgentRef): Promise<AgentVersion[]> {
  const { data } = await AgentVersionModel.listForAgent({
    agentId: agent.id,
    organizationId: agent.organizationId,
    pagination: { limit: 200, offset: 0 },
  });
  return data;
}

async function getVersion(
  agent: AgentRef,
  version: number,
): Promise<AgentVersion | null> {
  return await AgentVersionModel.findByAgentAndVersion({
    agentId: agent.id,
    version,
    organizationId: agent.organizationId,
  });
}

describe("AgentVersionModel", () => {
  test("create forks version 1 with a config-only snapshot", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ description: "first draft" });

    expect(agent.latestVersion).toBe(1);

    const versions = await listVersions(agent);
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
    const head = await getVersion(agent, 2);
    expect(head?.snapshot.description).toBe("second draft");
    // Version 1 is immutable history.
    const v1 = await getVersion(agent, 1);
    expect(v1?.snapshot.description).toBeNull();
  });

  test("update producing identical config does not fork", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();

    const updated = await AgentModel.update(agent.id, { name: agent.name });

    expect(updated?.latestVersion).toBe(1);
    expect(await listVersions(agent)).toHaveLength(1);
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
    const head = await getVersion(agent, 2);
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
    expect(await listVersions(agent)).toHaveLength(1);
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
    const head = await getVersion(agent, 2);
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
    expect(await listVersions(row)).toHaveLength(0);

    const updated = await AgentModel.update(row.id, {
      description: "first write after rollout",
    });

    expect(updated?.latestVersion).toBe(1);
    const head = await getVersion(row, 1);
    expect(head?.snapshot.description).toBe("first write after rollout");
  });

  test("forkIfChanged returns null for a missing agent", async () => {
    const fork = await AgentVersionModel.forkIfChanged(crypto.randomUUID());
    expect(fork).toBeNull();
  });

  test("hard delete cascades version rows", async ({ makeAgent }) => {
    const agent = await makeAgent();
    expect(await listVersions(agent)).toHaveLength(1);

    await AgentModel.hardDelete(agent.id);

    expect(await listVersions(agent)).toHaveLength(0);
  });

  test("content hash is insensitive to object key order", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    const [head] = await listVersions(agent);

    const reordered = Object.fromEntries(
      Object.entries(head.snapshot).reverse(),
    ) as AgentConfigSnapshot;

    expect(AgentVersionModel.computeContentHash(reordered)).toBe(
      head.contentHash,
    );
  });

  test("reads are scoped to the caller's organization", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const agent = await makeAgent();
    const otherOrg = await makeOrganization();

    expect(await listVersions(agent)).toHaveLength(1);
    expect(await getVersion(agent, 1)).not.toBeNull();

    // agent_versions has no organization of its own; an agent id leaked to
    // another tenant must not resolve its history.
    const foreign = { id: agent.id, organizationId: otherOrg.id };
    expect(await listVersions(foreign)).toHaveLength(0);
    expect(await getVersion(foreign, 1)).toBeNull();
  });

  test("listForAgent paginates newest-first", async ({ makeAgent }) => {
    const agent = await makeAgent();
    await AgentModel.update(agent.id, { description: "two" });
    await AgentModel.update(agent.id, { description: "three" });

    const firstPage = await AgentVersionModel.listForAgent({
      agentId: agent.id,
      organizationId: agent.organizationId,
      pagination: { limit: 2, offset: 0 },
    });

    expect(firstPage.pagination.total).toBe(3);
    expect(firstPage.data.map((v) => v.version)).toEqual([3, 2]);

    const secondPage = await AgentVersionModel.listForAgent({
      agentId: agent.id,
      organizationId: agent.organizationId,
      pagination: { limit: 2, offset: 2 },
    });
    expect(secondPage.data.map((v) => v.version)).toEqual([1]);
  });

  test("forking past the retention window drops the oldest versions", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    // Stand in for a long edit history without paying 100 real forks: seed
    // filler rows and point the head at them, then fork once for real.
    const filler = Array.from({ length: 99 }, (_, index) => ({
      agentId: agent.id,
      version: index + 2,
      snapshot: {} as AgentConfigSnapshot,
      contentHash: `filler-${index + 2}`,
    }));
    await db.insert(schema.agentVersionsTable).values(filler);
    await db
      .update(schema.agentsTable)
      .set({ latestVersion: 100 })
      .where(eq(schema.agentsTable.id, agent.id));

    const fork = await AgentVersionModel.forkIfChanged(agent.id);

    expect(fork).toEqual({ version: 101, forked: true });
    const versions = await listVersions(agent);
    // 100 kept: the new head back to version 2; version 1 aged out.
    expect(versions).toHaveLength(100);
    expect(versions[0].version).toBe(101);
    expect(versions[versions.length - 1].version).toBe(2);
    expect(await getVersion(agent, 1)).toBeNull();
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
    expect(await listVersions(agent)).toHaveLength(1);

    const hook = await HookFileModel.create({
      agentId: agent.id,
      organizationId: org.id,
      event: "session_start",
      fileName: "setup.py",
      content: "print('hi')",
      requirements: [],
      enabled: true,
    });
    expect(await listVersions(agent)).toHaveLength(2);
    const afterCreate = await getVersion(agent, 2);
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
    expect(await listVersions(agent)).toHaveLength(3);

    await HookFileModel.delete(hook.id, org.id);
    const versions = await listVersions(agent);
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
    expect(await listVersions(agent)).toHaveLength(2);

    const deleted = await AgentToolModel.delete({
      agentId: agent.id,
      toolId: tool.id,
    });

    expect(deleted).toBe(true);
    const versions = await listVersions(agent);
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

    const versions = await listVersions(agent);
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

  test("clone's head version reflects the copied tools, not the empty create", async ({
    makeAgent,
    makeTool,
    makeAgentTool,
    makeUser,
  }) => {
    const user = await makeUser();
    const source = await makeAgent({ accessAllTools: false });
    const tool = await makeTool();
    await makeAgentTool(source.id, tool.id);

    const clone = await AgentModel.cloneAgent({
      sourceId: source.id,
      userId: user.id,
    });

    // create() forks a tool-less version 1 before cloneAssignments runs. A
    // Custom-mode source skips the trailing accessAllTools update, so without
    // an explicit fork that empty snapshot would stay the head forever.
    const head = await getVersion(clone, clone.latestVersion);
    expect(head?.snapshot.tools.map((t) => t.toolId)).toEqual([tool.id]);
  });

  test("connector sync forks every agent that gained or lost the connector", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const [first, second] = await Promise.all([
      makeAgent({ organizationId: org.id }),
      makeAgent({ organizationId: org.id }),
    ]);
    const [connector] = await db
      .insert(schema.knowledgeBaseConnectorsTable)
      .values({
        organizationId: org.id,
        name: "Docs",
        connectorType: "github",
        config: {
          type: "github",
          githubUrl: "https://api.github.com",
          owner: "o",
          repos: ["r"],
        },
      })
      .returning();

    await AgentConnectorAssignmentModel.syncForAgentAssignments({
      connectorId: connector.id,
      agentIds: [first.id],
    });
    expect(await listVersions(first)).toHaveLength(2);

    // Reassigning to the other agent must fork both: one lost it, one gained it.
    await AgentConnectorAssignmentModel.syncForAgentAssignments({
      connectorId: connector.id,
      agentIds: [second.id],
    });
    expect(await listVersions(first)).toHaveLength(3);
    expect(await listVersions(second)).toHaveLength(2);
  });

  test("a deferred bulk assign yields one version, not one per tool", async ({
    makeAgent,
    makeTool,
  }) => {
    const agent = await makeAgent();
    const tools = await Promise.all([makeTool(), makeTool(), makeTool()]);

    for (const tool of tools) {
      await assignToolToAgent({
        agentId: agent.id,
        toolId: tool.id,
        deferVersionFork: true,
      });
    }
    // Nothing forked yet — the batch owns its version.
    expect(await listVersions(agent)).toHaveLength(1);

    await AgentVersionModel.forkAgentsBestEffort([
      agent.id,
      agent.id,
      agent.id,
    ]);

    const versions = await listVersions(agent);
    expect(versions).toHaveLength(2);
    expect(versions[0].snapshot.tools.map((t) => t.toolId).sort()).toEqual(
      tools.map((t) => t.id).sort(),
    );
  });
});
