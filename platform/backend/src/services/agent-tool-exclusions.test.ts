import {
  ARCHESTRA_MCP_CATALOG_ID,
  getArchestraToolFullName,
  TOOL_LIST_SKILLS_FULL_NAME,
  TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME,
  TOOL_RUN_COMMAND_FULL_NAME,
  TOOL_RUN_TOOL_FULL_NAME,
  TOOL_SEARCH_TOOLS_FULL_NAME,
  TOOL_WHOAMI_FULL_NAME,
  TOOL_WHOAMI_SHORT_NAME,
} from "@archestra/shared";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { clearChatMcpClient } from "@/clients/chat-mcp-client";
import db, { schema } from "@/database";
import { AgentExcludedToolModel, ToolModel } from "@/models";
import {
  agentToolExclusionsService,
  hasAnyExclusions,
  isToolIdentityExcluded,
  isToolRowExcluded,
} from "@/services/agent-tool-exclusions";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";

vi.mock("@/clients/chat-mcp-client", () => ({
  clearChatMcpClient: vi.fn(),
}));

describe("agentToolExclusionsService", () => {
  let organizationId: string;
  let agent: Agent;

  beforeEach(async ({ makeAgent, makeOrganization }) => {
    vi.clearAllMocks();
    const org = await makeOrganization();
    organizationId = org.id;
    agent = await makeAgent({
      organizationId,
      accessAllTools: true,
    });
  });

  test("replaceExclusions round-trips and dedupes", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({ organizationId });
    const tool = await makeTool({
      name: "github__create_issue",
      catalogId: catalog.id,
    });

    const result = await agentToolExclusionsService.replaceExclusions({
      agentId: agent.id,
      organizationId,
      excludedToolIds: [tool.id, tool.id],
    });

    expect(result).toEqual({
      excludedToolIds: [tool.id],
    });
    expect(await agentToolExclusionsService.getExclusions(agent.id)).toEqual({
      excludedToolIds: [tool.id],
    });
  });

  test("addExclusions unions with existing exclusions and dedupes", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({ organizationId });
    const toolA = await makeTool({ name: "github__a", catalogId: catalog.id });
    const toolB = await makeTool({ name: "github__b", catalogId: catalog.id });

    await agentToolExclusionsService.addExclusions({
      agentId: agent.id,
      organizationId,
      toolIds: [toolA.id],
    });
    // toolA is already excluded and repeated — the union must dedupe.
    const result = await agentToolExclusionsService.addExclusions({
      agentId: agent.id,
      organizationId,
      toolIds: [toolB.id, toolA.id],
    });

    expect([...result.excludedToolIds].sort()).toEqual(
      [toolA.id, toolB.id].sort(),
    );
    expect(
      [
        ...(await agentToolExclusionsService.getExclusions(agent.id))
          .excludedToolIds,
      ].sort(),
    ).toEqual([toolA.id, toolB.id].sort());
  });

  test("evicts the cached chat MCP client after a successful replace", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({ organizationId });
    const tool = await makeTool({
      name: "github__create_issue",
      catalogId: catalog.id,
    });

    await agentToolExclusionsService.replaceExclusions({
      agentId: agent.id,
      organizationId,
      excludedToolIds: [tool.id],
    });

    expect(clearChatMcpClient).toHaveBeenCalledWith(agent.id);
  });

  test("a failed replace leaves prior exclusions intact and does not evict", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({ organizationId });
    const tool = await makeTool({
      name: "github__create_issue",
      catalogId: catalog.id,
    });
    await agentToolExclusionsService.replaceExclusions({
      agentId: agent.id,
      organizationId,
      excludedToolIds: [tool.id],
    });
    vi.clearAllMocks();

    await expect(
      agentToolExclusionsService.replaceExclusions({
        agentId: agent.id,
        organizationId,
        excludedToolIds: [crypto.randomUUID()],
      }),
    ).rejects.toThrow(/Unknown tool id/);

    expect(await agentToolExclusionsService.getExclusions(agent.id)).toEqual({
      excludedToolIds: [tool.id],
    });
    expect(clearChatMcpClient).not.toHaveBeenCalled();
  });

  test("maps a validate-then-delete race (FK violation) to a 400, not a 500", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({ organizationId });
    const tool = await makeTool({
      name: "github__soon_gone",
      catalogId: catalog.id,
    });

    // Simulate the TOCTOU window: the tool row disappears after validation
    // succeeded but before the insert runs inside the transaction.
    const original = AgentExcludedToolModel.replaceForAgent.bind(
      AgentExcludedToolModel,
    );
    const spy = vi
      .spyOn(AgentExcludedToolModel, "replaceForAgent")
      .mockImplementation(async (agentId, toolIds, tx) => {
        await (tx ?? db)
          .delete(schema.toolsTable)
          .where(eq(schema.toolsTable.id, tool.id));
        return original(agentId, toolIds, tx);
      });

    try {
      await expect(
        agentToolExclusionsService.replaceExclusions({
          agentId: agent.id,
          organizationId,
          excludedToolIds: [tool.id],
        }),
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining("no longer exist"),
      });
    } finally {
      spy.mockRestore();
    }

    // Rolled back: no partial state, no eviction of a valid cache
    expect(await agentToolExclusionsService.getExclusions(agent.id)).toEqual({
      excludedToolIds: [],
    });
    expect(clearChatMcpClient).not.toHaveBeenCalled();
  });

  describe("write validation", () => {
    test("rejects unknown and cross-org tool ids", async ({
      makeInternalMcpCatalog,
      makeOrganization,
      makeTool,
    }) => {
      await expect(
        agentToolExclusionsService.replaceExclusions({
          agentId: agent.id,
          organizationId,
          excludedToolIds: [crypto.randomUUID()],
        }),
      ).rejects.toThrow(/Unknown tool id/);

      const otherOrg = await makeOrganization();
      const foreignCatalog = await makeInternalMcpCatalog({
        organizationId: otherOrg.id,
      });
      const foreignTool = await makeTool({
        name: "foreign__tool",
        catalogId: foreignCatalog.id,
      });
      await expect(
        agentToolExclusionsService.replaceExclusions({
          agentId: agent.id,
          organizationId,
          excludedToolIds: [foreignTool.id],
        }),
      ).rejects.toThrow(/Unknown tool id/);
    });

    test("rejects delegation (agent__) tool rows", async ({
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      const catalog = await makeInternalMcpCatalog({ organizationId });
      const delegationArtifact = await makeTool({
        name: "agent__leaked_artifact",
        catalogId: catalog.id,
      });

      await expect(
        agentToolExclusionsService.replaceExclusions({
          agentId: agent.id,
          organizationId,
          excludedToolIds: [delegationArtifact.id],
        }),
      ).rejects.toThrow(/Delegation tools cannot be excluded/);
    });

    test("rejects catalog-less (proxy-sniffed) tool rows", async ({
      makeTool,
    }) => {
      const proxyTool = await makeTool({ name: "proxy-sniffed-tool" });

      await expect(
        agentToolExclusionsService.replaceExclusions({
          agentId: agent.id,
          organizationId,
          excludedToolIds: [proxyTool.id],
        }),
      ).rejects.toThrow(/not excludable/);
    });

    test("rejects only the meta tools, accepts every other built-in (incl. always-exposed ones)", async ({
      makeAgent,
      seedAndAssignArchestraTools,
    }) => {
      // run_command is only seeded while the skills-sandbox runtime is on.
      const config = (await import("@/config")).default;
      const originalSandboxEnabled = config.skillsSandbox.enabled;
      (config.skillsSandbox as { enabled: boolean }).enabled = true;
      try {
        const seededAgent = await makeAgent({ organizationId });
        await seedAndAssignArchestraTools(seededAgent.id);
      } finally {
        (config.skillsSandbox as { enabled: boolean }).enabled =
          originalSandboxEnabled;
      }
      const searchTools = await ToolModel.findByName(
        TOOL_SEARCH_TOOLS_FULL_NAME,
      );
      const runTool = await ToolModel.findByName(TOOL_RUN_TOOL_FULL_NAME);
      const listSkills = await ToolModel.findByName(TOOL_LIST_SKILLS_FULL_NAME);
      const runCommand = await ToolModel.findByName(TOOL_RUN_COMMAND_FULL_NAME);
      const queryKnowledgeSources = await ToolModel.findByName(
        TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME,
      );
      const whoami = await ToolModel.findByName(TOOL_WHOAMI_FULL_NAME);
      if (
        !searchTools ||
        !runTool ||
        !listSkills ||
        !runCommand ||
        !queryKnowledgeSources ||
        !whoami
      ) {
        throw new Error("Expected seeded Archestra tools");
      }

      for (const metaTool of [searchTools, runTool]) {
        await expect(
          agentToolExclusionsService.replaceExclusions({
            agentId: agent.id,
            organizationId,
            excludedToolIds: [metaTool.id],
          }),
        ).rejects.toThrow(/meta tool cannot be excluded/);
      }

      // Everything else built-in is excludable at tool level, including
      // always-exposed tools (list_skills), sandbox runtime tools
      // (run_command), knowledge tools (query_knowledge_sources), and plain
      // built-ins (whoami).
      const excludable = [listSkills, runCommand, queryKnowledgeSources, whoami]
        .map((tool) => tool.id)
        .sort();
      const result = await agentToolExclusionsService.replaceExclusions({
        agentId: agent.id,
        organizationId,
        excludedToolIds: excludable,
      });
      expect([...result.excludedToolIds].sort()).toEqual(excludable);
    });
  });

  describe("exclusion sets for enforcement", () => {
    test("getExclusionSets exposes row ids and dispatch identity keys", async ({
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      const toolCatalog = await makeInternalMcpCatalog({ organizationId });
      const tool = await makeTool({
        name: "github__create_issue",
        catalogId: toolCatalog.id,
      });
      await agentToolExclusionsService.replaceExclusions({
        agentId: agent.id,
        organizationId,
        excludedToolIds: [tool.id],
      });

      const sets = await agentToolExclusionsService.getExclusionSets(agent.id);
      expect(hasAnyExclusions(sets)).toBe(true);
      expect(isToolRowExcluded({ id: tool.id }, sets)).toBe(true);
      expect(isToolRowExcluded({ id: crypto.randomUUID() }, sets)).toBe(false);
      expect(
        isToolIdentityExcluded(
          { catalogId: toolCatalog.id, name: "github__create_issue" },
          sets,
        ),
      ).toBe(true);
      expect(
        isToolIdentityExcluded(
          { catalogId: toolCatalog.id, name: "github__other" },
          sets,
        ),
      ).toBe(false);
    });

    test("Archestra built-in exclusions match by short name, so the default alias can't bypass a branded exclusion", async ({
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      // White-labeled deployment: the built-in row stores a branded name, but
      // dispatch (run_tool / the gateway) reaches the same tool by the default
      // `archestra__` alias. Both must resolve to the same short-name key.
      const brandedName = "acme__whoami";
      const defaultAliasName = getArchestraToolFullName(TOOL_WHOAMI_SHORT_NAME);
      expect(brandedName).not.toBe(defaultAliasName);
      const shortNameSpy = vi
        .spyOn(archestraMcpBranding, "getToolShortName")
        .mockImplementation((name: string) =>
          name === brandedName || name === defaultAliasName
            ? TOOL_WHOAMI_SHORT_NAME
            : null,
        );
      try {
        await makeInternalMcpCatalog({
          id: ARCHESTRA_MCP_CATALOG_ID,
          organizationId,
        });
        const branded = await makeTool({
          name: brandedName,
          catalogId: ARCHESTRA_MCP_CATALOG_ID,
        });
        await agentToolExclusionsService.replaceExclusions({
          agentId: agent.id,
          organizationId,
          excludedToolIds: [branded.id],
        });

        const sets = await agentToolExclusionsService.getExclusionSets(
          agent.id,
        );
        // Matched under the branded name the row stores...
        expect(
          isToolIdentityExcluded(
            { catalogId: ARCHESTRA_MCP_CATALOG_ID, name: brandedName },
            sets,
          ),
        ).toBe(true);
        // ...and under the default-prefix alias run_tool / the gateway resolve
        // to, which must NOT bypass the exclusion on a white-labeled deployment.
        expect(
          isToolIdentityExcluded(
            { catalogId: ARCHESTRA_MCP_CATALOG_ID, name: defaultAliasName },
            sets,
          ),
        ).toBe(true);
      } finally {
        shortNameSpy.mockRestore();
      }
    });

    test("getActiveExclusionSets is empty when accessAllTools is off", async ({
      makeAgent,
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      const strictAgent = await makeAgent({
        organizationId,
        accessAllTools: false,
      });
      const catalog = await makeInternalMcpCatalog({ organizationId });
      const tool = await makeTool({
        name: "github__create_issue",
        catalogId: catalog.id,
      });
      await agentToolExclusionsService.replaceExclusions({
        agentId: strictAgent.id,
        organizationId,
        excludedToolIds: [tool.id],
      });

      const inactive = await agentToolExclusionsService.getActiveExclusionSets(
        strictAgent.id,
      );
      expect(hasAnyExclusions(inactive)).toBe(false);

      const active = await agentToolExclusionsService.getActiveExclusionSets(
        agent.id,
      );
      expect(hasAnyExclusions(active)).toBe(false); // agent has no exclusions

      await agentToolExclusionsService.replaceExclusions({
        agentId: agent.id,
        organizationId,
        excludedToolIds: [tool.id],
      });
      const populated = await agentToolExclusionsService.getActiveExclusionSets(
        agent.id,
      );
      expect(populated.toolIds.has(tool.id)).toBe(true);
    });
  });
});
