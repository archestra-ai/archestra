// biome-ignore-all lint/suspicious/noExplicitAny: test assertions inspect tool payloads dynamically
import {
  AGENT_TOOL_PREFIX,
  ARCHESTRA_MCP_CATALOG_ID,
  slugify,
  TOOL_CREATE_SKILL_FULL_NAME,
  TOOL_DOWNLOAD_FILE_FULL_NAME,
  TOOL_LIST_SKILLS_FULL_NAME,
  TOOL_LOAD_SKILL_FULL_NAME,
  TOOL_READ_FILE_FULL_NAME,
  TOOL_RUN_COMMAND_FULL_NAME,
  TOOL_RUN_TOOL_FULL_NAME,
  TOOL_SEARCH_TOOLS_FULL_NAME,
  TOOL_UPDATE_SKILL_FULL_NAME,
  TOOL_UPLOAD_FILE_FULL_NAME,
} from "@archestra/shared";
import { ConversationEnabledToolModel, ToolModel } from "@/models";
import { describe, expect, test } from "@/test";
import type { ArchestraContext } from ".";
import { executeArchestraTool } from ".";
import { __test } from "./search-tools";

const {
  makeRankingCandidate,
  prepareSearchQuery,
  rankCandidatesByKeyword,
  findUnmatchedQueryTerms,
} = __test;

function rank(
  candidates: Parameters<typeof makeRankingCandidate>[0][],
  query: string,
): string[] {
  return rankCandidatesByKeyword(
    candidates.map(makeRankingCandidate),
    prepareSearchQuery(query),
  ).map((candidate) => candidate.toolName);
}

function unmatched(
  candidates: Parameters<typeof makeRankingCandidate>[0][],
  query: string,
): string[] {
  return findUnmatchedQueryTerms(
    candidates.map(makeRankingCandidate),
    prepareSearchQuery(query),
  );
}

type SearchToolsStructuredContent = {
  total: number;
  matchCount: number;
  truncated: boolean;
  hint: string | null;
  tools: Array<{
    toolName: string;
    description: string | null;
    source: "archestra" | "mcp" | "agent_delegation";
    server: string | null;
    available: boolean;
    unavailableReason: string | null;
    params: string;
  }>;
};

describe("search_tools", () => {
  test("returns ranked matching tools with compact parameter summaries", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeMember,
    makeOrganization,
    makeTool,
    makeAgentTool,
    makeUser,
    seedAndAssignArchestraTools,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeAgent({
      name: "Search Agent",
      organizationId: org.id,
    });
    await seedAndAssignArchestraTools(agent.id);

    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      name: "GitHub MCP",
    });
    const githubTool = await makeTool({
      name: "github__search_repositories",
      description: "Search repositories by topic, language, or owner.",
      catalogId: catalog.id,
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Repository search query string.",
          },
          language: {
            type: "string",
            description: "Optional language filter.",
          },
        },
        required: ["query"],
      },
    });
    await makeAgentTool(agent.id, githubTool.id);
    await makeMcpServer({ catalogId: catalog.id, scope: "org" });

    const context: ArchestraContext = {
      agent: { id: agent.id, name: agent.name },
      agentId: agent.id,
      organizationId: org.id,
      userId: user.id,
    };

    const result = await executeArchestraTool(
      TOOL_SEARCH_TOOLS_FULL_NAME,
      { query: "repository search", limit: 5 },
      context,
    );

    expect(result.isError).toBe(false);
    const structuredContent =
      result.structuredContent as SearchToolsStructuredContent;
    const firstResult = structuredContent.tools[0];
    expect(structuredContent.total).toBeGreaterThan(0);
    expect(firstResult).toEqual({
      toolName: "github__search_repositories",
      description: "Search repositories by topic, language, or owner.",
      source: "mcp",
      server: "github",
      available: true,
      unavailableReason: null,
      params:
        "query!:string — Repository search query string.; language?:string — Optional language filter.",
    });

    const genericQueryResult = await executeArchestraTool(
      TOOL_SEARCH_TOOLS_FULL_NAME,
      { query: "tool", limit: 20 },
      context,
    );

    expect(genericQueryResult.isError).toBe(false);
    const genericStructuredContent =
      genericQueryResult.structuredContent as SearchToolsStructuredContent;
    const returnedToolNames = genericStructuredContent.tools.map(
      (tool) => tool.toolName,
    );
    expect(returnedToolNames).not.toContain(TOOL_SEARCH_TOOLS_FULL_NAME);
    expect(returnedToolNames).not.toContain(TOOL_RUN_TOOL_FULL_NAME);
  });

  test("marks tools without an installed connection as unavailable and ranks them last", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeMember,
    makeOrganization,
    makeTool,
    makeAgentTool,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeAgent({
      name: "Availability Agent",
      organizationId: org.id,
    });

    const installedCatalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      name: "Installed MCP",
    });
    const installedTool = await makeTool({
      name: "installed__do_thing",
      description: "widget action available now",
      catalogId: installedCatalog.id,
    });
    await makeAgentTool(agent.id, installedTool.id);
    await makeMcpServer({ catalogId: installedCatalog.id, scope: "org" });

    // Same catalog shape but no installed connection -> retained, unavailable.
    const removedCatalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      name: "Removed MCP",
    });
    const removedTool = await makeTool({
      name: "removed__do_thing",
      description: "widget action pending reconnect",
      catalogId: removedCatalog.id,
    });
    await makeAgentTool(agent.id, removedTool.id);

    const context: ArchestraContext = {
      agent: { id: agent.id, name: agent.name },
      agentId: agent.id,
      organizationId: org.id,
      userId: user.id,
    };

    const result = await executeArchestraTool(
      TOOL_SEARCH_TOOLS_FULL_NAME,
      { query: "widget action", limit: 5 },
      context,
    );
    expect(result.isError).toBe(false);
    const content = result.structuredContent as SearchToolsStructuredContent;
    const byName = new Map(content.tools.map((tool) => [tool.toolName, tool]));

    expect(byName.get("installed__do_thing")).toMatchObject({
      available: true,
      unavailableReason: null,
    });
    expect(byName.get("removed__do_thing")?.available).toBe(false);
    expect(byName.get("removed__do_thing")?.unavailableReason).toBeTruthy();

    // Available ranks ahead of unavailable.
    const names = content.tools.map((tool) => tool.toolName);
    expect(names.indexOf("installed__do_thing")).toBeLessThan(
      names.indexOf("removed__do_thing"),
    );

    // On truncation, the unavailable tool is dropped first.
    const truncated = await executeArchestraTool(
      TOOL_SEARCH_TOOLS_FULL_NAME,
      { query: "widget action", limit: 1 },
      context,
    );
    const truncatedContent =
      truncated.structuredContent as SearchToolsStructuredContent;
    expect(truncatedContent.tools).toHaveLength(1);
    expect(truncatedContent.tools[0].toolName).toBe("installed__do_thing");
  });

  test("includes unassigned tools from catalogs the user can access when the agent allows dynamic access", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeMember,
    makeOrganization,
    makeTool,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeAgent({
      name: "Search Agent",
      organizationId: org.id,
      accessAllTools: true,
    });

    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      name: "GitHub MCP",
    });
    // intentionally not assigned to the agent
    await makeTool({
      name: "github__search_repositories",
      description: "Search repositories by topic, language, or owner.",
      catalogId: catalog.id,
    });
    await makeMcpServer({ catalogId: catalog.id, scope: "org" });

    const context: ArchestraContext = {
      agent: { id: agent.id, name: agent.name },
      agentId: agent.id,
      organizationId: org.id,
      userId: user.id,
    };

    const result = await executeArchestraTool(
      TOOL_SEARCH_TOOLS_FULL_NAME,
      { query: "repository search" },
      context,
    );

    expect(result.isError).toBe(false);
    const structuredContent =
      result.structuredContent as SearchToolsStructuredContent;
    expect(structuredContent.tools.map((tool) => tool.toolName)).toContain(
      "github__search_repositories",
    );
  });

  test("hides unassigned tools when the agent's access-all-tools setting is off", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeMember,
    makeOrganization,
    makeTool,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    // default accessAllTools=false — discovery stays assigned-tools-only
    const agent = await makeAgent({
      name: "Search Agent",
      organizationId: org.id,
    });

    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      name: "GitHub MCP",
    });
    await makeTool({
      name: "github__search_repositories",
      description: "Search repositories by topic, language, or owner.",
      catalogId: catalog.id,
    });

    const context: ArchestraContext = {
      agent: { id: agent.id, name: agent.name },
      agentId: agent.id,
      organizationId: org.id,
      userId: user.id,
    };

    const result = await executeArchestraTool(
      TOOL_SEARCH_TOOLS_FULL_NAME,
      { query: "repository search" },
      context,
    );

    expect(result.isError).toBe(false);
    const structuredContent =
      result.structuredContent as SearchToolsStructuredContent;
    expect(structuredContent.tools.map((tool) => tool.toolName)).not.toContain(
      "github__search_repositories",
    );
  });

  test("hides unassigned tools whose catalog the user cannot access", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeMember,
    makeOrganization,
    makeTeam,
    makeTool,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "member" });
    const agent = await makeAgent({
      name: "Search Agent",
      organizationId: org.id,
      accessAllTools: true,
    });

    // user creates the team but is not a member of it
    const team = await makeTeam(org.id, user.id);
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      name: "GitHub MCP",
      scope: "team",
      teams: [team.id],
    });
    await makeTool({
      name: "github__search_repositories",
      description: "Search repositories by topic, language, or owner.",
      catalogId: catalog.id,
    });

    const context: ArchestraContext = {
      agent: { id: agent.id, name: agent.name },
      agentId: agent.id,
      organizationId: org.id,
      userId: user.id,
    };

    const result = await executeArchestraTool(
      TOOL_SEARCH_TOOLS_FULL_NAME,
      { query: "repository search" },
      context,
    );

    expect(result.isError).toBe(false);
    const structuredContent =
      result.structuredContent as SearchToolsStructuredContent;
    expect(structuredContent.tools.map((tool) => tool.toolName)).not.toContain(
      "github__search_repositories",
    );
  });

  test("filters Archestra tools by RBAC before ranking", async ({
    makeAgent,
    makeCustomRole,
    makeMember,
    makeOrganization,
    makeUser,
    seedAndAssignArchestraTools,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const role = await makeCustomRole(org.id, {
      permission: { agent: ["read"] },
    });
    await makeMember(user.id, org.id, { role: role.role });

    const agent = await makeAgent({
      name: "Restricted Agent",
      organizationId: org.id,
    });
    await seedAndAssignArchestraTools(agent.id);

    const context: ArchestraContext = {
      agent: { id: agent.id, name: agent.name },
      agentId: agent.id,
      organizationId: org.id,
      userId: user.id,
    };

    // "trusted data policy" matches only policy tools (trusted-data /
    // tool-invocation / autonomy), all of which require permissions this
    // agent:read role lacks, so RBAC filters them all out before ranking.
    const result = await executeArchestraTool(
      TOOL_SEARCH_TOOLS_FULL_NAME,
      { query: "trusted data policy", limit: 10 },
      context,
    );

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      total: 0,
      matchCount: 0,
      truncated: false,
      hint: "No tools matched. Try broader or different keywords, or switch mode. No tool text matches these query terms: trusted, data, policy.",
      tools: [],
    });
  });

  test("on zero matches, hints the sandbox fallback when the sandbox is usable", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
    seedAndAssignArchestraTools,
  }) => {
    const config = (await import("@/config")).default;
    const originalSandboxEnabled = config.skillsSandbox.enabled;
    (config.skillsSandbox as { enabled: boolean }).enabled = true;

    try {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id, { role: "admin" });
      const agent = await makeAgent({
        name: "Sandbox Search Agent",
        organizationId: org.id,
      });
      await seedAndAssignArchestraTools(agent.id);

      const context: ArchestraContext = {
        agent: { id: agent.id, name: agent.name },
        agentId: agent.id,
        organizationId: org.id,
        userId: user.id,
      };

      const result = await executeArchestraTool(
        TOOL_SEARCH_TOOLS_FULL_NAME,
        { query: "zzqqxyzznomatch", limit: 10 },
        context,
      );

      const structuredContent =
        result.structuredContent as SearchToolsStructuredContent;
      expect(structuredContent.matchCount).toBe(0);
      expect(structuredContent.hint).toContain(TOOL_RUN_COMMAND_FULL_NAME);
      expect(structuredContent.hint).toContain("fall back");
    } finally {
      (config.skillsSandbox as { enabled: boolean }).enabled =
        originalSandboxEnabled;
    }
  });

  test("excludes always-exposed tools but keeps authoring tools searchable", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
    seedAndAssignArchestraTools,
  }) => {
    const config = (await import("@/config")).default;
    const originalSandboxEnabled = config.skillsSandbox.enabled;
    (config.skillsSandbox as { enabled: boolean }).enabled = true;

    try {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id, { role: "admin" });
      const agent = await makeAgent({
        name: "Skill Search Agent",
        organizationId: org.id,
      });
      await seedAndAssignArchestraTools(agent.id);

      const context: ArchestraContext = {
        agent: { id: agent.id, name: agent.name },
        agentId: agent.id,
        organizationId: org.id,
        userId: user.id,
      };

      const result = await executeArchestraTool(
        TOOL_SEARCH_TOOLS_FULL_NAME,
        { query: "skill", limit: 20 },
        context,
      );

      expect(result.isError).toBe(false);
      const structuredContent =
        result.structuredContent as SearchToolsStructuredContent;
      const returnedToolNames = structuredContent.tools.map(
        (tool) => tool.toolName,
      );

      // once assigned, the runtime path is top-level, so it stays out of search
      // (unassigned sandbox tools DO surface — see "sandbox built-in discovery")
      expect(returnedToolNames).not.toContain(TOOL_LIST_SKILLS_FULL_NAME);
      expect(returnedToolNames).not.toContain(TOOL_LOAD_SKILL_FULL_NAME);
      expect(returnedToolNames).not.toContain(TOOL_RUN_COMMAND_FULL_NAME);
      expect(returnedToolNames).not.toContain(TOOL_DOWNLOAD_FILE_FULL_NAME);
      expect(returnedToolNames).not.toContain(TOOL_UPLOAD_FILE_FULL_NAME);
      // authoring tools stay search-gated, so they remain discoverable
      expect(returnedToolNames).toContain(TOOL_CREATE_SKILL_FULL_NAME);
      expect(returnedToolNames).toContain(TOOL_UPDATE_SKILL_FULL_NAME);

      const runtimeResult = await executeArchestraTool(
        TOOL_SEARCH_TOOLS_FULL_NAME,
        { query: "download upload command sandbox file", limit: 20 },
        context,
      );

      expect(runtimeResult.isError).toBe(false);
      const runtimeStructuredContent =
        runtimeResult.structuredContent as SearchToolsStructuredContent;
      const runtimeReturnedToolNames = runtimeStructuredContent.tools.map(
        (tool) => tool.toolName,
      );
      expect(runtimeReturnedToolNames).not.toContain(
        TOOL_RUN_COMMAND_FULL_NAME,
      );
      expect(runtimeReturnedToolNames).not.toContain(
        TOOL_DOWNLOAD_FILE_FULL_NAME,
      );
      expect(runtimeReturnedToolNames).not.toContain(
        TOOL_UPLOAD_FILE_FULL_NAME,
      );
    } finally {
      (config.skillsSandbox as { enabled: boolean }).enabled =
        originalSandboxEnabled;
    }
  });

  // Sandbox built-ins surface in search only while UNassigned (so the model can
  // discover and run them dynamically), and only for callers who can actually
  // run them. Seeded but not assigned here to exercise that path.
  describe("sandbox built-in discovery", () => {
    async function searchSandboxTools(
      context: ArchestraContext,
    ): Promise<string[]> {
      const result = await executeArchestraTool(
        TOOL_SEARCH_TOOLS_FULL_NAME,
        { query: "run command upload download file shell execute", limit: 20 },
        context,
      );
      expect(result.isError).toBe(false);
      return (
        result.structuredContent as SearchToolsStructuredContent
      ).tools.map((tool) => tool.toolName);
    }

    test("surfaces an unassigned sandbox tool to a user with sandbox:execute", async ({
      makeAgent,
      makeMember,
      makeOrganization,
      makeUser,
    }) => {
      const config = (await import("@/config")).default;
      const originalSandboxEnabled = config.skillsSandbox.enabled;
      (config.skillsSandbox as { enabled: boolean }).enabled = true;
      try {
        const org = await makeOrganization();
        const user = await makeUser();
        await makeMember(user.id, org.id, { role: "admin" });
        const agent = await makeAgent({
          name: "Sandbox Discovery Agent",
          organizationId: org.id,
          accessAllTools: true,
        });
        // seed (run_command exists in the org-accessible Archestra catalog) but
        // do NOT assign it
        await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);

        const names = await searchSandboxTools({
          agent: { id: agent.id, name: agent.name },
          agentId: agent.id,
          organizationId: org.id,
          userId: user.id,
        });

        expect(names).toContain(TOOL_RUN_COMMAND_FULL_NAME);
        expect(names).toContain(TOOL_UPLOAD_FILE_FULL_NAME);
        expect(names).toContain(TOOL_DOWNLOAD_FILE_FULL_NAME);
        // Persistent-files tools surface too when the sandbox runtime is on.
        expect(names).toContain(TOOL_READ_FILE_FULL_NAME);
      } finally {
        (config.skillsSandbox as { enabled: boolean }).enabled =
          originalSandboxEnabled;
      }
    });

    test("hides sandbox tools from a user without sandbox:execute", async ({
      makeAgent,
      makeCustomRole,
      makeMember,
      makeOrganization,
      makeUser,
    }) => {
      const config = (await import("@/config")).default;
      const originalSandboxEnabled = config.skillsSandbox.enabled;
      (config.skillsSandbox as { enabled: boolean }).enabled = true;
      try {
        const org = await makeOrganization();
        const user = await makeUser();
        const role = await makeCustomRole(org.id, {
          permission: { agent: ["read"] },
        });
        await makeMember(user.id, org.id, { role: role.role });
        const agent = await makeAgent({
          name: "Sandbox Discovery Agent",
          organizationId: org.id,
          accessAllTools: true,
        });
        await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);

        const names = await searchSandboxTools({
          agent: { id: agent.id, name: agent.name },
          agentId: agent.id,
          organizationId: org.id,
          userId: user.id,
        });

        expect(names).not.toContain(TOOL_RUN_COMMAND_FULL_NAME);
      } finally {
        (config.skillsSandbox as { enabled: boolean }).enabled =
          originalSandboxEnabled;
      }
    });
  });

  describe("knowledge-source discovery", () => {
    test("surfaces query_knowledge_sources only when the user can access a connector", async ({
      makeAgent,
      makeMember,
      makeOrganization,
      makeUser,
    }) => {
      const { KnowledgeBaseConnectorModel } = await import("@/models");
      const {
        getArchestraToolFullName,
        TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
      } = await import("@archestra/shared");
      const kbToolName = getArchestraToolFullName(
        TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
      );
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id, { role: "admin" });
      const agent = await makeAgent({
        name: "Knowledge Discovery Agent",
        organizationId: org.id,
        accessAllTools: true,
      });
      await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);

      const context: ArchestraContext = {
        agent: { id: agent.id, name: agent.name },
        agentId: agent.id,
        organizationId: org.id,
        userId: user.id,
      };
      const search = async () => {
        const result = await executeArchestraTool(
          TOOL_SEARCH_TOOLS_FULL_NAME,
          { query: "query knowledge sources search", limit: 20 },
          context,
        );
        expect(result.isError).toBe(false);
        return (
          result.structuredContent as SearchToolsStructuredContent
        ).tools.map((tool) => tool.toolName);
      };

      // agent has no knowledge sources and the user has no connector yet
      expect(await search()).not.toContain(kbToolName);

      await KnowledgeBaseConnectorModel.create({
        organizationId: org.id,
        name: "Search Discovery Connector",
        connectorType: "jira",
        config: {
          type: "jira",
          jiraBaseUrl: "https://test.atlassian.net",
          isCloud: true,
          projectKey: "PROJ",
        },
      });

      expect(await search()).toContain(kbToolName);
    });
  });

  describe("BM25F ranking (golden cases)", () => {
    test("aggregates multiple matching terms above a single-term near-miss", () => {
      const ranked = rank(
        [
          {
            toolName: "slack__post_message",
            description: "Post a message to a channel",
          },
          { toolName: "twilio__send_sms", description: "Send an SMS text" },
        ],
        "send message channel",
      );
      expect(ranked[0]).toBe("slack__post_message");
    });

    test("weights a name hit above a description-only hit", () => {
      const ranked = rank(
        [
          { toolName: "octokit__repository" },
          {
            toolName: "octokit__list",
            description: "Lists every repository you own",
          },
        ],
        "repository",
      );
      expect(ranked[0]).toBe("octokit__repository");
    });

    test("an exact tool-name query always wins over keyword spam", () => {
      const ranked = rank(
        [
          { toolName: "github__search_repositories" },
          {
            toolName: "noise__tool",
            description:
              "github search repositories github search repositories github search",
          },
        ],
        "github__search_repositories",
      );
      expect(ranked[0]).toBe("github__search_repositories");
    });

    test("breaks score ties deterministically by tool name", () => {
      const ranked = rank(
        [{ toolName: "z__alpha" }, { toolName: "a__alpha" }],
        "alpha",
      );
      expect(ranked).toEqual(["a__alpha", "z__alpha"]);
    });

    test("returns nothing when no term matches", () => {
      expect(
        rank([{ toolName: "slack__post_message" }], "nonexistentcapability"),
      ).toEqual([]);
    });

    test("splits snake/kebab names so subtokens match", () => {
      const ranked = rank(
        [{ toolName: "github__search_repositories" }],
        "search repositories",
      );
      expect(ranked).toEqual(["github__search_repositories"]);
    });

    test("does not inflate ranking by repeating a query term", () => {
      const candidates = [
        { toolName: "a__search", description: "search things" },
        { toolName: "b__find", description: "find things" },
      ];
      // repeated 'search' must not outrank via repetition (query tokens dedupe)
      expect(rank(candidates, "search search search")).toEqual(
        rank(candidates, "search"),
      );
    });

    test("a term present in every tool still yields a positive, finite score", () => {
      // df === docCount exercises the log(1 + …) IDF floor (no negative/NaN)
      const ranked = rank(
        [
          { toolName: "a__list", description: "list things" },
          { toolName: "b__list", description: "list things" },
        ],
        "list",
      );
      expect(ranked).toEqual(["a__list", "b__list"]);
    });

    test("ranks a single-candidate corpus without NaN from empty fields", () => {
      // only a name, all other fields empty -> avgFieldLength 0 for those fields
      expect(rank([{ toolName: "solo__tool" }], "solo")).toEqual([
        "solo__tool",
      ]);
    });
  });

  describe("unmatched query terms (golden cases)", () => {
    test("reports every term when the whole query is absent from the corpus", () => {
      expect(
        unmatched([{ toolName: "slack__post_message" }], "send carrier pigeon"),
      ).toEqual(["send", "carrier", "pigeon"]);
    });

    test("reports only the absent term on a partial match", () => {
      const candidates = [
        {
          toolName: "slack__post_message",
          description: "Post a message to a channel",
        },
      ];
      // 'message' hits the description; 'gif' appears nowhere -> only 'gif'.
      expect(rank(candidates, "message gif")).toEqual(["slack__post_message"]);
      expect(unmatched(candidates, "message gif")).toEqual(["gif"]);
    });

    test("does not report a term that only matches via substring boost", () => {
      const candidates = [{ toolName: "github__search_repositories" }];
      // 'repo' has no token match (indexed token is 'repositories') but drives a
      // result through the whole-query name substring boost, so it is matched.
      expect(rank(candidates, "repo")).toEqual(["github__search_repositories"]);
      expect(unmatched(candidates, "repo")).toEqual([]);
    });

    test("reports nothing when every query term hits some tool text", () => {
      expect(
        unmatched(
          [{ toolName: "github__search_repositories" }],
          "search repositories",
        ),
      ).toEqual([]);
    });

    test("treats a term found in any field (e.g. argument names) as matched", () => {
      const candidates = [
        {
          toolName: "x__tool",
          parameters: {
            properties: { channel: { type: "string" } },
          },
        },
      ];
      expect(unmatched(candidates, "channel")).toEqual([]);
    });

    test("reports a term that is only a substring of an unrelated word", () => {
      // "gif" sits inside the description token "gift" but is neither an indexed
      // token nor a name/title substring, so it contributes no ranking signal.
      const candidates = [
        { toolName: "store__redeem", description: "Redeem a gift card" },
      ];
      expect(unmatched(candidates, "gif")).toEqual(["gif"]);
    });
  });

  describe("regex mode", () => {
    test("matches tool names by anchored pattern", () => {
      const result = __test.rankCandidatesByRegex(
        [{ toolName: "github__create_issue" }, { toolName: "slack__post" }].map(
          makeRankingCandidate,
        ),
        "^github__",
      );
      expect(result.ok && result.matches.map((m) => m.toolName)).toEqual([
        "github__create_issue",
      ]);
    });

    test("is case-insensitive and can match descriptions", () => {
      const result = __test.rankCandidatesByRegex(
        [
          { toolName: "x__a", description: "Send a Slack message" },
          { toolName: "x__b", description: "Open a GitHub issue" },
        ].map(makeRankingCandidate),
        "slack",
      );
      expect(result.ok && result.matches.map((m) => m.toolName)).toEqual([
        "x__a",
      ]);
    });

    test("rejects a catastrophic-backtracking pattern with guidance", () => {
      const result = __test.rankCandidatesByRegex(
        [{ toolName: "x__a" }].map(makeRankingCandidate),
        "(a+)+$",
      );
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toContain("too complex");
    });

    test("rejects an invalid pattern with guidance", () => {
      const result = __test.rankCandidatesByRegex(
        [{ toolName: "x__a" }].map(makeRankingCandidate),
        "[unterminated",
      );
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toContain(
        "Invalid regular expression",
      );
    });
  });

  describe("parameter enrichment", () => {
    test("surfaces type, enum, and nested properties", () => {
      const summaries = __test.summarizeInputParameters({
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["open", "closed"],
            description: "Issue state.",
          },
          payload: {
            type: "object",
            properties: {
              id: { type: "number" },
              note: { type: "string" },
            },
            required: ["id"],
          },
        },
        required: ["status"],
      });

      expect(summaries).toEqual([
        {
          name: "status",
          required: true,
          type: "string",
          enum: ["open", "closed"],
          description: "Issue state.",
          properties: null,
          hasHiddenDetail: false,
        },
        {
          name: "payload",
          required: false,
          type: "object",
          enum: null,
          description: null,
          properties: [
            { name: "id", type: "number", required: true, properties: null },
            { name: "note", type: "string", required: false, properties: null },
          ],
          hasHiddenDetail: false,
        },
      ]);
    });

    test("expands a second nested level for object-of-object params", () => {
      const [summary] = __test.summarizeInputParameters({
        type: "object",
        properties: {
          config: {
            type: "object",
            properties: {
              user: {
                type: "object",
                properties: { name: { type: "string" } },
                required: ["name"],
              },
            },
          },
        },
      });
      expect(summary.properties).toEqual([
        {
          name: "user",
          type: "object",
          required: false,
          properties: [
            { name: "name", type: "string", required: true, properties: null },
          ],
        },
      ]);
    });

    test("summarizes nested properties of array-of-object params", () => {
      const [summary] = __test.summarizeInputParameters({
        type: "object",
        properties: {
          todos: {
            type: "array",
            items: {
              type: "object",
              properties: { content: { type: "string" } },
              required: ["content"],
            },
          },
        },
      });
      expect(summary.type).toBe("array");
      expect(summary.properties).toEqual([
        { name: "content", type: "string", required: true, properties: null },
      ]);
    });

    test("collapses union types and falls back to null for missing/garbage types", () => {
      const [union, missing] = __test.summarizeInputParameters({
        type: "object",
        properties: {
          maybe: { type: ["string", "null"] },
          weird: { type: { not: "a string" } },
        },
      });
      expect(union.type).toBe("string|null");
      expect(missing.type).toBeNull();
    });
  });

  describe("formatParamsSignature", () => {
    const signatureFor = (schema: Record<string, unknown>) =>
      __test.formatParamsSignature(__test.summarizeInputParameters(schema));

    test("renders required-first ordering with types and descriptions", () => {
      expect(
        signatureFor({
          type: "object",
          properties: {
            language: {
              type: "string",
              description: "Optional language filter.",
            },
            query: {
              type: "string",
              description: "Repository search query string.",
            },
          },
          required: ["query"],
        }),
      ).toBe(
        "query!:string — Repository search query string.; language?:string — Optional language filter.",
      );
    });

    test("renders type and enum together", () => {
      expect(
        signatureFor({
          type: "object",
          properties: { sort: { type: "string", enum: ["asc", "desc"] } },
        }),
      ).toBe('sort?:string enum("asc"|"desc")');
    });

    test("json-encodes non-string enum values and omits a null type", () => {
      expect(
        signatureFor({
          type: "object",
          properties: { level: { enum: [1, true, null] } },
        }),
      ).toBe("level?:enum(1|true|null)");
    });

    test("expands one-level object shape", () => {
      expect(
        signatureFor({
          type: "object",
          properties: {
            payload: {
              type: "object",
              properties: { id: { type: "number" }, note: { type: "string" } },
              required: ["id"],
            },
          },
        }),
      ).toBe("payload?:object{id!:number, note?:string}");
    });

    test("expands array-of-object items", () => {
      expect(
        signatureFor({
          type: "object",
          properties: {
            todos: {
              type: "array",
              items: {
                type: "object",
                properties: { content: { type: "string" } },
                required: ["content"],
              },
            },
          },
        }),
      ).toBe("todos?:array{content!:string}");
    });

    test("expands a second object level inline", () => {
      expect(
        signatureFor({
          type: "object",
          properties: {
            config: {
              type: "object",
              properties: {
                user: {
                  type: "object",
                  properties: { name: { type: "string" } },
                },
              },
            },
          },
        }),
      ).toBe("config?:object{user?:object{name?:string}}");
    });

    test("expands a second level through array-of-object items", () => {
      expect(
        signatureFor({
          type: "object",
          properties: {
            payload: {
              type: "object",
              properties: {
                rows: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { id: { type: "number" } },
                  },
                },
              },
            },
          },
        }),
      ).toBe("payload?:object{rows?:array{id?:number}}");
    });

    test("renders type, object shape, and enum together", () => {
      expect(
        signatureFor({
          type: "object",
          properties: {
            target: {
              type: "object",
              properties: { id: { type: "string" } },
              enum: [{ id: "a" }],
            },
          },
        }),
      ).toBe('target?:object{id?:string} enum({"id":"a"})');
    });

    test("collapses whitespace in descriptions to keep the signature single-line", () => {
      expect(
        signatureFor({
          type: "object",
          properties: {
            body: { type: "string", description: "Line one.\n  Line two." },
          },
        }),
      ).toBe("body?:string — Line one. Line two.");
    });

    const enumSignatureFor = (count: number) =>
      signatureFor({
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: Array.from({ length: count }, (_, index) => `v${index}`),
          },
        },
      });

    test("renders every enum value at exactly the cap with no overflow marker", () => {
      const signature = enumSignatureFor(20);
      expect(signature.endsWith('"v19")')).toBe(true);
      expect(signature).not.toContain("more");
    });

    test("caps long enums and reports the overflow count", () => {
      expect(enumSignatureFor(21).endsWith('"v19"|…(+1 more))')).toBe(true);
      expect(enumSignatureFor(25).endsWith('"v19"|…(+5 more))')).toBe(true);
    });

    test("returns an empty string when there are no parameters", () => {
      expect(__test.formatParamsSignature([])).toBe("");
      expect(signatureFor({ type: "object", properties: {} })).toBe("");
    });

    describe("hidden-detail marker", () => {
      const hasHidden = (schema: Record<string, unknown>) =>
        __test.summarizeInputParameters(schema)[0]?.hasHiddenDetail;

      test("marks an explicit additionalProperties object (freeform)", () => {
        const schema = {
          type: "object",
          properties: {
            result: { type: "object", additionalProperties: true },
          },
          required: ["result"],
        };
        expect(hasHidden(schema)).toBe(true);
        expect(signatureFor(schema)).toBe("result!:object…");
      });

      test("marks an opaque object with no listed properties", () => {
        const schema = {
          type: "object",
          properties: { meta: { type: "object" } },
        };
        expect(hasHidden(schema)).toBe(true);
        expect(signatureFor(schema)).toBe("meta?:object…");
      });

      test("fully shows an object nested two levels deep, no marker", () => {
        const schema = {
          type: "object",
          properties: {
            config: {
              type: "object",
              properties: {
                user: { type: "object", properties: { name: {} } },
              },
            },
          },
        };
        expect(hasHidden(schema)).toBe(false);
        expect(signatureFor(schema)).toBe(
          "config?:object{user?:object{name?}}",
        );
      });

      test("marks an object nested deeper than the two levels shown", () => {
        const schema = {
          type: "object",
          properties: {
            config: {
              type: "object",
              properties: {
                user: {
                  type: "object",
                  properties: {
                    address: { type: "object", properties: { city: {} } },
                  },
                },
              },
            },
          },
        };
        expect(hasHidden(schema)).toBe(true);
        expect(signatureFor(schema)).toBe(
          "config?:object{user?:object{address?:object}}…",
        );
      });

      test("marks an opaque second-level object", () => {
        const schema = {
          type: "object",
          properties: {
            config: {
              type: "object",
              properties: { user: { type: "object" } },
            },
          },
        };
        expect(hasHidden(schema)).toBe(true);
        expect(signatureFor(schema)).toBe("config?:object{user?:object}…");
      });

      // The render resolves array items only when they list properties, while the
      // marker resolves any object-typed items; this pins that they still agree —
      // opaque items collapse the array to a bare type and the marker fires.
      test("marks a second-level array of opaque objects", () => {
        const schema = {
          type: "object",
          properties: {
            config: {
              type: "object",
              properties: {
                rows: { type: "array", items: { type: "object" } },
              },
            },
          },
        };
        expect(hasHidden(schema)).toBe(true);
        expect(signatureFor(schema)).toBe("config?:object{rows?:array}…");
      });

      test("does not mark a closed second-level object", () => {
        const schema = {
          type: "object",
          properties: {
            config: {
              type: "object",
              properties: {
                user: {
                  type: "object",
                  properties: { name: { type: "string" } },
                  additionalProperties: false,
                },
              },
            },
          },
        };
        expect(hasHidden(schema)).toBe(false);
        expect(signatureFor(schema)).toBe(
          "config?:object{user?:object{name?:string}}",
        );
      });

      test("marks an array of freeform objects", () => {
        const schema = {
          type: "object",
          properties: {
            rows: {
              type: "array",
              items: { type: "object", additionalProperties: true },
            },
          },
        };
        expect(hasHidden(schema)).toBe(true);
        expect(signatureFor(schema)).toBe("rows?:array…");
      });

      test("does not mark an array of fully-shown objects", () => {
        const schema = {
          type: "object",
          properties: {
            todos: {
              type: "array",
              items: {
                type: "object",
                properties: { content: { type: "string" } },
                required: ["content"],
              },
            },
          },
        };
        expect(hasHidden(schema)).toBe(false);
        expect(signatureFor(schema)).toBe("todos?:array{content!:string}");
      });

      test("does not mark scalars", () => {
        expect(
          hasHidden({ type: "object", properties: { q: { type: "string" } } }),
        ).toBe(false);
      });

      test("does not mark a fully-shown object that merely omits additionalProperties", () => {
        const schema = {
          type: "object",
          properties: {
            payload: {
              type: "object",
              properties: { id: { type: "number" } },
            },
          },
        };
        expect(hasHidden(schema)).toBe(false);
        expect(signatureFor(schema)).toBe("payload?:object{id?:number}");
      });

      test("does not mark a closed object with explicit additionalProperties:false", () => {
        const schema = {
          type: "object",
          properties: {
            payload: {
              type: "object",
              properties: { id: { type: "number" } },
              additionalProperties: false,
            },
          },
        };
        expect(hasHidden(schema)).toBe(false);
      });
    });
  });

  test("returns an error without agent context", async () => {
    const result = await executeArchestraTool(
      TOOL_SEARCH_TOOLS_FULL_NAME,
      { query: "repository search" },
      {
        agent: { id: "agent-id", name: "Agent" },
      },
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "search_tools requires agent context",
    );
  });

  describe("signals", () => {
    test("reports matchCount and truncated when results exceed the limit", async ({
      makeAgent,
      makeAgentTool,
      makeInternalMcpCatalog,
      makeMember,
      makeOrganization,
      makeTool,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id, { role: "admin" });
      const agent = await makeAgent({ name: "Trunc", organizationId: org.id });
      const catalog = await makeInternalMcpCatalog({
        organizationId: org.id,
        name: "GitHub MCP",
      });
      for (const name of [
        "github__search_repositories",
        "github__search_issues",
        "github__search_code",
      ]) {
        const tool = await makeTool({
          name,
          description: "github search",
          catalogId: catalog.id,
          parameters: {},
        });
        await makeAgentTool(agent.id, tool.id);
      }

      const context: ArchestraContext = {
        agent: { id: agent.id, name: agent.name },
        agentId: agent.id,
        organizationId: org.id,
        userId: user.id,
      };
      const result = await executeArchestraTool(
        TOOL_SEARCH_TOOLS_FULL_NAME,
        { query: "github search", limit: 1 },
        context,
      );
      const structured =
        result.structuredContent as SearchToolsStructuredContent;
      expect(structured.total).toBe(1);
      expect(structured.matchCount).toBe(3);
      expect(structured.truncated).toBe(true);
      expect(structured.hint).toContain("top 1 of 3");
    });

    test("zero results return an actionable hint naming available servers", async ({
      makeAgent,
      makeAgentTool,
      makeInternalMcpCatalog,
      makeMember,
      makeOrganization,
      makeTool,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id, { role: "admin" });
      const agent = await makeAgent({ name: "Zero", organizationId: org.id });
      const catalog = await makeInternalMcpCatalog({
        organizationId: org.id,
        name: "GitHub MCP",
      });
      const tool = await makeTool({
        name: "github__search_repositories",
        description: "search",
        catalogId: catalog.id,
        parameters: {},
      });
      await makeAgentTool(agent.id, tool.id);

      const context: ArchestraContext = {
        agent: { id: agent.id, name: agent.name },
        agentId: agent.id,
        organizationId: org.id,
        userId: user.id,
      };
      const result = await executeArchestraTool(
        TOOL_SEARCH_TOOLS_FULL_NAME,
        { query: "nonexistentcapabilityxyz", limit: 5 },
        context,
      );
      const structured =
        result.structuredContent as SearchToolsStructuredContent;
      expect(structured.matchCount).toBe(0);
      expect(structured.hint).toContain("No tools matched");
      expect(structured.hint).toContain("GitHub MCP");
    });

    test("a successful search does not flag extra query terms that hit no tool text", async ({
      makeAgent,
      makeAgentTool,
      makeInternalMcpCatalog,
      makeMember,
      makeOrganization,
      makeTool,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id, { role: "admin" });
      const agent = await makeAgent({
        name: "Partial",
        organizationId: org.id,
      });
      const catalog = await makeInternalMcpCatalog({
        organizationId: org.id,
        name: "Slack MCP",
      });
      const tool = await makeTool({
        name: "slack__post_message",
        description: "Post a message to a channel",
        catalogId: catalog.id,
        parameters: {},
      });
      await makeAgentTool(agent.id, tool.id);

      const context: ArchestraContext = {
        agent: { id: agent.id, name: agent.name },
        agentId: agent.id,
        organizationId: org.id,
        userId: user.id,
      };
      const result = await executeArchestraTool(
        TOOL_SEARCH_TOOLS_FULL_NAME,
        { query: "message gif", limit: 5 },
        context,
      );
      const structured =
        result.structuredContent as SearchToolsStructuredContent;
      // 'message' matches slack__post_message; 'gif' matches nothing. The search still
      // succeeded, so the unmatched 'gif' is suppressed rather than surfaced as noise.
      expect(structured.matchCount).toBe(1);
      expect(structured.hint).toBeNull();
    });

    test("a truncated search omits the unmatched-terms clause", async ({
      makeAgent,
      makeAgentTool,
      makeInternalMcpCatalog,
      makeMember,
      makeOrganization,
      makeTool,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id, { role: "admin" });
      const agent = await makeAgent({ name: "Both", organizationId: org.id });
      const catalog = await makeInternalMcpCatalog({
        organizationId: org.id,
        name: "GitHub MCP",
      });
      for (const name of [
        "github__search_repositories",
        "github__search_issues",
        "github__search_code",
      ]) {
        const tool = await makeTool({
          name,
          description: "github search",
          catalogId: catalog.id,
          parameters: {},
        });
        await makeAgentTool(agent.id, tool.id);
      }

      const context: ArchestraContext = {
        agent: { id: agent.id, name: agent.name },
        agentId: agent.id,
        organizationId: org.id,
        userId: user.id,
      };
      // 'search' matches all three (-> truncated at limit 1); 'zzznope' matches
      // nothing. The search succeeded, so only the truncation clause appears -- the
      // unmatched 'zzznope' is suppressed.
      const result = await executeArchestraTool(
        TOOL_SEARCH_TOOLS_FULL_NAME,
        { query: "search zzznope", limit: 1 },
        context,
      );
      const structured =
        result.structuredContent as SearchToolsStructuredContent;
      expect(structured.truncated).toBe(true);
      expect(structured.hint).toContain("top 1 of 3");
      expect(structured.hint).not.toContain("No tool text matches");
      expect(structured.hint).not.toContain("zzznope");
    });

    test("regex mode never appends an unmatched-terms clause", async ({
      makeAgent,
      makeAgentTool,
      makeInternalMcpCatalog,
      makeMember,
      makeOrganization,
      makeTool,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id, { role: "admin" });
      const agent = await makeAgent({ name: "Regex", organizationId: org.id });
      const catalog = await makeInternalMcpCatalog({
        organizationId: org.id,
        name: "GitHub MCP",
      });
      const tool = await makeTool({
        name: "github__search_repositories",
        description: "search",
        catalogId: catalog.id,
        parameters: {},
      });
      await makeAgentTool(agent.id, tool.id);

      const context: ArchestraContext = {
        agent: { id: agent.id, name: agent.name },
        agentId: agent.id,
        organizationId: org.id,
        userId: user.id,
      };
      const result = await executeArchestraTool(
        TOOL_SEARCH_TOOLS_FULL_NAME,
        { query: "^github__", limit: 5, mode: "regex" },
        context,
      );
      const structured =
        result.structuredContent as SearchToolsStructuredContent;
      expect(structured.matchCount).toBe(1);
      expect(structured.hint).toBeNull();
    });
  });

  describe("per-conversation tool filter", () => {
    test("hides a third-party tool disabled for the conversation", async ({
      makeAgent,
      makeAgentTool,
      makeConversation,
      makeInternalMcpCatalog,
      makeMember,
      makeOrganization,
      makeTool,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id, { role: "admin" });
      const agent = await makeAgent({ name: "Conv", organizationId: org.id });
      const catalog = await makeInternalMcpCatalog({
        organizationId: org.id,
        name: "GitHub MCP",
      });
      const enabledTool = await makeTool({
        name: "github__search_repositories",
        description: "search",
        catalogId: catalog.id,
        parameters: {},
      });
      const disabledTool = await makeTool({
        name: "github__create_issue",
        description: "github create",
        catalogId: catalog.id,
        parameters: {},
      });
      await makeAgentTool(agent.id, enabledTool.id);
      await makeAgentTool(agent.id, disabledTool.id);
      const conversation = await makeConversation(agent.id, {
        organizationId: org.id,
        userId: user.id,
      });
      await ConversationEnabledToolModel.setEnabledTools(conversation.id, [
        enabledTool.id,
      ]);

      const base: ArchestraContext = {
        agent: { id: agent.id, name: agent.name },
        agentId: agent.id,
        organizationId: org.id,
        userId: user.id,
      };

      const filtered = await executeArchestraTool(
        TOOL_SEARCH_TOOLS_FULL_NAME,
        { query: "github", limit: 20 },
        { ...base, conversationId: conversation.id },
      );
      const filteredNames = (
        filtered.structuredContent as SearchToolsStructuredContent
      ).tools.map((t) => t.toolName);
      expect(filteredNames).toContain("github__search_repositories");
      expect(filteredNames).not.toContain("github__create_issue");

      // no conversationId ⇒ no filter ⇒ both visible
      const unfiltered = await executeArchestraTool(
        TOOL_SEARCH_TOOLS_FULL_NAME,
        { query: "github", limit: 20 },
        base,
      );
      const unfilteredNames = (
        unfiltered.structuredContent as SearchToolsStructuredContent
      ).tools.map((t) => t.toolName);
      expect(unfilteredNames).toContain("github__search_repositories");
      expect(unfilteredNames).toContain("github__create_issue");
    });

    test("keeps Archestra tools discoverable under an empty custom selection", async ({
      makeAgent,
      makeAgentTool,
      makeConversation,
      makeInternalMcpCatalog,
      makeMember,
      makeOrganization,
      makeTool,
      makeUser,
      seedAndAssignArchestraTools,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id, { role: "admin" });
      const agent = await makeAgent({ name: "Empty", organizationId: org.id });
      await seedAndAssignArchestraTools(agent.id);
      const catalog = await makeInternalMcpCatalog({
        organizationId: org.id,
        name: "GitHub MCP",
      });
      const thirdParty = await makeTool({
        name: "github__search_repositories",
        description: "search",
        catalogId: catalog.id,
        parameters: {},
      });
      await makeAgentTool(agent.id, thirdParty.id);
      const conversation = await makeConversation(agent.id, {
        organizationId: org.id,
        userId: user.id,
      });
      // custom selection enabling zero tools
      await ConversationEnabledToolModel.setEnabledTools(conversation.id, []);

      const context: ArchestraContext = {
        agent: { id: agent.id, name: agent.name },
        agentId: agent.id,
        organizationId: org.id,
        userId: user.id,
        conversationId: conversation.id,
      };

      const skillResult = await executeArchestraTool(
        TOOL_SEARCH_TOOLS_FULL_NAME,
        { query: "skill", limit: 20 },
        context,
      );
      const skillNames = (
        skillResult.structuredContent as SearchToolsStructuredContent
      ).tools.map((t) => t.toolName);
      // Archestra authoring tool stays discoverable (built-ins bypass the gate)
      expect(skillNames).toContain(TOOL_CREATE_SKILL_FULL_NAME);

      const githubResult = await executeArchestraTool(
        TOOL_SEARCH_TOOLS_FULL_NAME,
        { query: "github", limit: 20 },
        context,
      );
      const githubNames = (
        githubResult.structuredContent as SearchToolsStructuredContent
      ).tools.map((t) => t.toolName);
      // third-party tool is filtered out by the empty selection
      expect(githubNames).not.toContain("github__search_repositories");
    });

    test("hides an agent-delegation tool disabled for the conversation", async ({
      makeAgent,
      makeAgentTool,
      makeConversation,
      makeInternalMcpCatalog,
      makeMember,
      makeOrganization,
      makeTool,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id, { role: "admin" });
      const agent = await makeAgent({ name: "Deleg", organizationId: org.id });
      const targetAgent = await makeAgent({
        name: "Research Agent",
        organizationId: org.id,
      });
      const delegationTool = await ToolModel.findOrCreateDelegationTool(
        targetAgent.id,
      );
      await makeAgentTool(agent.id, delegationTool.id);
      const catalog = await makeInternalMcpCatalog({
        organizationId: org.id,
        name: "GitHub MCP",
      });
      const other = await makeTool({
        name: "github__search_repositories",
        description: "search",
        catalogId: catalog.id,
        parameters: {},
      });
      await makeAgentTool(agent.id, other.id);
      const conversation = await makeConversation(agent.id, {
        organizationId: org.id,
        userId: user.id,
      });
      // custom selection enabling only the unrelated tool, excluding delegation
      await ConversationEnabledToolModel.setEnabledTools(conversation.id, [
        other.id,
      ]);

      const delegationName = `${AGENT_TOOL_PREFIX}${slugify(targetAgent.name)}`;
      const base: ArchestraContext = {
        agent: { id: agent.id, name: agent.name },
        agentId: agent.id,
        organizationId: org.id,
        userId: user.id,
      };

      const filtered = await executeArchestraTool(
        TOOL_SEARCH_TOOLS_FULL_NAME,
        { query: "research agent", limit: 20 },
        { ...base, conversationId: conversation.id },
      );
      const filteredNames = (
        filtered.structuredContent as SearchToolsStructuredContent
      ).tools.map((t) => t.toolName);
      expect(filteredNames).not.toContain(delegationName);

      // no conversationId ⇒ no filter ⇒ delegation tool discoverable
      const unfiltered = await executeArchestraTool(
        TOOL_SEARCH_TOOLS_FULL_NAME,
        { query: "research agent", limit: 20 },
        base,
      );
      const unfilteredNames = (
        unfiltered.structuredContent as SearchToolsStructuredContent
      ).tools.map((t) => t.toolName);
      expect(unfilteredNames).toContain(delegationName);
    });
  });
});
