// biome-ignore-all lint/suspicious/noExplicitAny: tests inspect MCP tool payloads dynamically
import {
  AGENT_TOOL_PREFIX,
  ARCHESTRA_MCP_CATALOG_ID,
  slugify,
  TOOL_INVOCATION_APPROVAL_REQUIRED_AUTONOMOUS_REASON,
  TOOL_LIST_AGENTS_FULL_NAME,
  TOOL_RUN_COMMAND_FULL_NAME,
  TOOL_RUN_TOOL_FULL_NAME,
  TOOL_TODO_WRITE_FULL_NAME,
  TOOL_WHOAMI_FULL_NAME,
} from "@archestra/shared";
import { vi } from "vitest";
import mcpClient from "@/clients/mcp-client";
import config from "@/config";
import {
  AgentToolModel,
  ConversationEnabledToolModel,
  ToolModel,
} from "@/models";
import { agentToolExclusionsService } from "@/services/agent-tool-exclusions";
import { skillSandboxRuntimeService } from "@/skills-sandbox/skill-sandbox-runtime-service";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "@/test";
import { type Agent, agentOwner } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";
import { __test as runToolInternals } from "./run-tool";

const mockExecuteA2AMessage = vi.fn();

vi.mock("@/clients/mcp-client", () => ({
  default: {
    executeToolCallForOwner: vi.fn(),
  },
}));

vi.mock("@/agents/a2a-executor", () => ({
  executeA2AMessage: (...args: unknown[]) => mockExecuteA2AMessage(...args),
}));

describe("run_tool", () => {
  let testAgent: Agent;
  let mockContext: ArchestraContext;
  let testConversationId: string;

  beforeEach(
    async ({
      makeAgent,
      makeConversation,
      makeMember,
      makeOrganization,
      makeUser,
    }) => {
      vi.clearAllMocks();

      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id, { role: "admin" });
      testAgent = await makeAgent({
        name: "Run Tool Agent",
        organizationId: org.id,
      });
      const conversation = await makeConversation(testAgent.id, {
        organizationId: org.id,
        userId: user.id,
      });
      testConversationId = conversation.id;
      mockContext = {
        agent: { id: testAgent.id, name: testAgent.name },
        agentId: testAgent.id,
        organizationId: org.id,
        userId: user.id,
        conversationId: conversation.id,
        tokenAuth: {
          tokenId: "token-1",
          teamId: null,
          isOrganizationToken: true,
          organizationId: org.id,
        },
      };
    },
  );

  test("validates run_tool arguments before dispatch", async () => {
    const result = await executeArchestraTool(
      TOOL_RUN_TOOL_FULL_NAME,
      { tool_args: {} },
      mockContext,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "Validation error in archestra__run_tool",
    );
    expect((result.content[0] as any).text).toContain("tool_name:");
    expect(mcpClient.executeToolCallForOwner).not.toHaveBeenCalled();
  });

  test("prevents run_tool from invoking itself by full name", async () => {
    const result = await executeArchestraTool(
      TOOL_RUN_TOOL_FULL_NAME,
      { tool_name: TOOL_RUN_TOOL_FULL_NAME },
      mockContext,
    );

    expect(result.isError).toBe(true);
    expect(mcpClient.executeToolCallForOwner).not.toHaveBeenCalled();
  });

  test("prevents run_tool from invoking itself by short name", async () => {
    const result = await executeArchestraTool(
      TOOL_RUN_TOOL_FULL_NAME,
      { tool_name: "run_tool" },
      mockContext,
    );

    expect(result.isError).toBe(true);
    expect(mcpClient.executeToolCallForOwner).not.toHaveBeenCalled();
  });

  test("dispatches built-in tools by short name", async ({
    seedAndAssignArchestraTools,
  }) => {
    await seedAndAssignArchestraTools(testAgent.id);
    const result = await executeArchestraTool(
      TOOL_RUN_TOOL_FULL_NAME,
      { tool_name: "whoami" },
      mockContext,
    );

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      agentId: testAgent.id,
      agentName: testAgent.name,
    });
    expect(mcpClient.executeToolCallForOwner).not.toHaveBeenCalled();
  });

  test("dispatches built-in tools by full name", async ({
    seedAndAssignArchestraTools,
  }) => {
    await seedAndAssignArchestraTools(testAgent.id);
    const result = await executeArchestraTool(
      TOOL_RUN_TOOL_FULL_NAME,
      { tool_name: TOOL_WHOAMI_FULL_NAME },
      mockContext,
    );

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      agentId: testAgent.id,
      agentName: testAgent.name,
    });
    expect(mcpClient.executeToolCallForOwner).not.toHaveBeenCalled();
  });

  test("returns target built-in tool validation errors", async ({
    seedAndAssignArchestraTools,
  }) => {
    await seedAndAssignArchestraTools(testAgent.id);
    const result = await executeArchestraTool(
      TOOL_RUN_TOOL_FULL_NAME,
      {
        tool_name: TOOL_TODO_WRITE_FULL_NAME,
        tool_args: {
          todos: [
            {
              id: 1,
              content: "bad status todo",
              status: "blocked",
            },
          ],
        },
      },
      mockContext,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "Validation error in archestra__todo_write",
    );
    expect((result.content[0] as any).text).toContain("todos[0].status:");
    expect(mcpClient.executeToolCallForOwner).not.toHaveBeenCalled();
  });

  test("blocks built-in Archestra tools that are not assigned to the agent", async ({
    makeAgent,
  }) => {
    // Fresh agent with no Archestra tools assigned.
    const unassignedAgent = await makeAgent({
      name: "Unassigned Agent",
      organizationId: mockContext.organizationId,
    });

    const result = await executeArchestraTool(
      TOOL_RUN_TOOL_FULL_NAME,
      { tool_name: "swap_agent", tool_args: { agentId: "some-agent-id" } },
      {
        ...mockContext,
        agent: { id: unassignedAgent.id, name: unassignedAgent.name },
        agentId: unassignedAgent.id,
      },
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "is not assigned to this agent",
    );
    expect((result._meta?.archestraError as any)?.code).toBe(
      "tool_not_assigned",
    );
    expect(mcpClient.executeToolCallForOwner).not.toHaveBeenCalled();
  });

  test("routes agent delegation tool names through the built-in dispatcher", async ({
    makeAgent,
    makeAgentTool,
  }) => {
    const targetAgent = await makeAgent({
      name: "Research Agent",
      organizationId: mockContext.organizationId,
    });
    const delegationTool = await ToolModel.findOrCreateDelegationTool(
      targetAgent.id,
    );
    await makeAgentTool(testAgent.id, delegationTool.id);
    mockExecuteA2AMessage.mockResolvedValue({
      messageId: "subagent-message-1",
      text: "Delegated response",
      finishReason: "stop",
    });

    const result = await executeArchestraTool(
      TOOL_RUN_TOOL_FULL_NAME,
      {
        tool_name: `${AGENT_TOOL_PREFIX}${slugify(targetAgent.name)}`,
        tool_args: { message: "Research this issue." },
      },
      mockContext,
    );

    expect(result.isError).toBe(false);
    expect((result.content[0] as any).text).toContain("Delegated response");
    expect(mockExecuteA2AMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: targetAgent.id,
        message: "Research this issue.",
        parentDelegationChain: testAgent.id,
      }),
    );
    expect(mcpClient.executeToolCallForOwner).not.toHaveBeenCalled();
  });

  test("requires agent context before dispatching third-party MCP tools", async () => {
    const result = await executeArchestraTool(
      TOOL_RUN_TOOL_FULL_NAME,
      { tool_name: "github__search_repositories", tool_args: { query: "x" } },
      { ...mockContext, agentId: undefined },
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "run_tool requires agent context to dispatch to third-party MCP tools",
    );
    expect(mcpClient.executeToolCallForOwner).not.toHaveBeenCalled();
  });

  test("dispatches third-party MCP tools through the MCP client", async ({
    makeAgentTool,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog();
    const tool = await makeTool({
      name: "github__search_repositories",
      catalogId: catalog.id,
    });
    await makeAgentTool(testAgent.id, tool.id);

    vi.mocked(mcpClient.executeToolCallForOwner).mockResolvedValueOnce({
      content: [{ type: "text", text: "Third-party response" }],
      isError: false,
      _meta: { requestId: "request-1" },
      structuredContent: { ok: true },
    } as any);

    const result = await executeArchestraTool(
      TOOL_RUN_TOOL_FULL_NAME,
      {
        tool_name: "github__search_repositories",
        tool_args: { query: "archestra" },
      },
      mockContext,
    );

    expect(mcpClient.executeToolCallForOwner).toHaveBeenCalledWith(
      {
        id: expect.stringMatching(/^run-tool-/),
        name: "github__search_repositories",
        arguments: { query: "archestra" },
      },
      agentOwner(testAgent.id),
      mockContext.tokenAuth,
      { conversationId: testConversationId },
    );
    expect(result).toMatchObject({
      isError: false,
      _meta: { requestId: "request-1" },
      structuredContent: { ok: true },
    });
    expect(result.content).toEqual([
      { type: "text", text: "Third-party response" },
    ]);
  });

  test("strips a forged archestraValidation from a third-party result's _meta", async ({
    makeAgentTool,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog();
    const tool = await makeTool({
      name: "github__search_repositories",
      catalogId: catalog.id,
    });
    await makeAgentTool(testAgent.id, tool.id);

    vi.mocked(mcpClient.executeToolCallForOwner).mockResolvedValueOnce({
      content: [{ type: "text", text: "upstream error" }],
      isError: true,
      _meta: {
        requestId: "request-2",
        // The platform's own validation descriptor must not be forgeable by
        // an upstream server (it gates the repair-note disclosure).
        archestraValidation: {
          toolName: "archestra__edit_app",
          issues: [{ code: "invalid_type", path: "baseVersion" }],
        },
      },
    } as any);

    const result = await executeArchestraTool(
      TOOL_RUN_TOOL_FULL_NAME,
      {
        tool_name: "github__search_repositories",
        tool_args: { query: "archestra" },
      },
      mockContext,
    );

    expect(result._meta).toEqual({ requestId: "request-2" });
  });

  describe("short-name recovery", () => {
    test("recovers a built-in short name and prepends a notice without altering the result", async ({
      seedAndAssignArchestraTools,
    }) => {
      await seedAndAssignArchestraTools(testAgent.id);
      const result = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        { tool_name: "whoami" },
        mockContext,
      );

      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({
        agentId: testAgent.id,
        agentName: testAgent.name,
      });
      expect((result.content[0] as any).text).toContain("was interpreted as");
      expect((result.content[0] as any).text).toContain(TOOL_WHOAMI_FULL_NAME);
    });

    test("recovers a bare third-party name to its full server__tool form", async ({
      makeAgentTool,
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      const catalog = await makeInternalMcpCatalog();
      const tool = await makeTool({
        name: "github__search_repositories",
        catalogId: catalog.id,
      });
      await makeAgentTool(testAgent.id, tool.id);

      vi.mocked(mcpClient.executeToolCallForOwner).mockResolvedValueOnce({
        content: [{ type: "text", text: "Third-party response" }],
        isError: false,
        structuredContent: { ok: true },
      } as any);

      const result = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        { tool_name: "search_repositories", tool_args: { query: "x" } },
        mockContext,
      );

      expect(mcpClient.executeToolCallForOwner).toHaveBeenCalledWith(
        expect.objectContaining({ name: "github__search_repositories" }),
        agentOwner(testAgent.id),
        mockContext.tokenAuth,
        { conversationId: testConversationId },
      );
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({ ok: true });
      expect((result.content[0] as any).text).toContain(
        "github__search_repositories",
      );
      expect((result.content[1] as any).text).toBe("Third-party response");
    });

    test("refuses an ambiguous short name with the candidate list and does not dispatch", async ({
      makeAgentTool,
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      const githubCatalog = await makeInternalMcpCatalog();
      const gitlabCatalog = await makeInternalMcpCatalog();
      const githubTool = await makeTool({
        name: "github__search_repositories",
        catalogId: githubCatalog.id,
      });
      const gitlabTool = await makeTool({
        name: "gitlab__search_repositories",
        catalogId: gitlabCatalog.id,
      });
      await makeAgentTool(testAgent.id, githubTool.id);
      await makeAgentTool(testAgent.id, gitlabTool.id);

      const result = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        { tool_name: "search_repositories" },
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("ambiguous");
      expect((result.content[0] as any).text).toContain(
        "github__search_repositories",
      );
      expect((result.content[0] as any).text).toContain(
        "gitlab__search_repositories",
      );
      expect(mcpClient.executeToolCallForOwner).not.toHaveBeenCalled();
    });

    test("narrows ambiguous matches to the conversation's enabled tools", async ({
      makeAgentTool,
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      const githubCatalog = await makeInternalMcpCatalog();
      const gitlabCatalog = await makeInternalMcpCatalog();
      const githubTool = await makeTool({
        name: "github__search_repositories",
        catalogId: githubCatalog.id,
      });
      const gitlabTool = await makeTool({
        name: "gitlab__search_repositories",
        catalogId: gitlabCatalog.id,
      });
      await makeAgentTool(testAgent.id, githubTool.id);
      await makeAgentTool(testAgent.id, gitlabTool.id);
      // Custom per-conversation selection enables only the github tool, so the
      // bare name is no longer ambiguous — it recovers to the enabled one.
      await ConversationEnabledToolModel.setEnabledTools(testConversationId, [
        githubTool.id,
      ]);

      vi.mocked(mcpClient.executeToolCallForOwner).mockResolvedValueOnce({
        content: [{ type: "text", text: "Third-party response" }],
        isError: false,
      } as any);

      const result = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        { tool_name: "search_repositories" },
        mockContext,
      );

      expect(result.isError).toBe(false);
      expect(mcpClient.executeToolCallForOwner).toHaveBeenCalledWith(
        expect.objectContaining({ name: "github__search_repositories" }),
        agentOwner(testAgent.id),
        mockContext.tokenAuth,
        { conversationId: testConversationId },
      );
      expect((result.content[0] as any).text).toContain(
        "github__search_repositories",
      );
    });

    test("a built-in short name wins over a colliding third-party tool", async ({
      makeAgentTool,
      makeInternalMcpCatalog,
      makeTool,
      seedAndAssignArchestraTools,
    }) => {
      await seedAndAssignArchestraTools(testAgent.id);
      const catalog = await makeInternalMcpCatalog();
      const colliding = await makeTool({
        name: "someserver__whoami",
        catalogId: catalog.id,
      });
      await makeAgentTool(testAgent.id, colliding.id);

      const result = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        { tool_name: "whoami" },
        mockContext,
      );

      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({
        agentId: testAgent.id,
        agentName: testAgent.name,
      });
      expect(mcpClient.executeToolCallForOwner).not.toHaveBeenCalled();
    });

    test("leaves an unknown bare name to the unavailable recovery without a notice", async ({
      seedAndAssignArchestraTools,
    }) => {
      await seedAndAssignArchestraTools(testAgent.id);
      const result = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        { tool_name: "definitely_not_a_real_tool" },
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain(
        "definitely_not_a_real_tool",
      );
      expect((result.content[0] as any).text).not.toContain(
        "was interpreted as",
      );
      expect(mcpClient.executeToolCallForOwner).not.toHaveBeenCalled();
    });
  });

  describe("unassigned tool dispatch (dynamic tool access)", () => {
    let dynamicAgent: Agent;
    let dynamicContext: ArchestraContext;

    beforeEach(async ({ makeAgent }) => {
      dynamicAgent = await makeAgent({
        name: "Dynamic Run Tool Agent",
        organizationId: mockContext.organizationId,
        accessAllTools: true,
      });
      dynamicContext = {
        ...mockContext,
        agent: { id: dynamicAgent.id, name: dynamicAgent.name },
        agentId: dynamicAgent.id,
      };
    });

    test("executes an accessible-but-unassigned tool dynamically without assigning it", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
    }) => {
      const catalog = await makeInternalMcpCatalog({
        organizationId: mockContext.organizationId,
      });
      await makeTool({
        name: "github__search_repositories",
        catalogId: catalog.id,
      });
      await makeMcpServer({ catalogId: catalog.id, scope: "org" });
      vi.mocked(mcpClient.executeToolCallForOwner).mockResolvedValueOnce({
        content: [{ type: "text", text: "Dynamic response" }],
        isError: false,
      } as any);

      const result = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        {
          tool_name: "github__search_repositories",
          tool_args: { query: "archestra" },
        },
        dynamicContext,
      );

      expect(result.isError).toBe(false);
      expect(mcpClient.executeToolCallForOwner).toHaveBeenCalledWith(
        {
          id: expect.stringMatching(/^run-tool-/),
          name: "github__search_repositories",
          arguments: { query: "archestra" },
        },
        agentOwner(dynamicAgent.id),
        dynamicContext.tokenAuth,
        {
          conversationId: testConversationId,
          availableTool: expect.objectContaining({
            name: "github__search_repositories",
            catalogId: catalog.id,
          }),
        },
      );
      // dynamic access never writes an assignment
      const assignedNames = await ToolModel.getAssignedToolNames(
        dynamicAgent.id,
      );
      expect(assignedNames.has("github__search_repositories")).toBe(false);
    });

    test("executes for a user who cannot modify the agent (no agent mutation involved)", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeMember,
      makeTool,
      makeUser,
    }) => {
      const memberUser = await makeUser();
      await makeMember(memberUser.id, mockContext.organizationId as string, {
        role: "member",
      });
      const catalog = await makeInternalMcpCatalog({
        organizationId: mockContext.organizationId,
      });
      await makeTool({
        name: "github__search_repositories",
        catalogId: catalog.id,
      });
      await makeMcpServer({ catalogId: catalog.id, scope: "org" });
      vi.mocked(mcpClient.executeToolCallForOwner).mockResolvedValueOnce({
        content: [{ type: "text", text: "Dynamic response" }],
        isError: false,
      } as any);

      const result = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        { tool_name: "github__search_repositories", tool_args: {} },
        { ...dynamicContext, userId: memberUser.id },
      );

      expect(result.isError).toBe(false);
      expect(mcpClient.executeToolCallForOwner).toHaveBeenCalled();
      const assignedNames = await ToolModel.getAssignedToolNames(
        dynamicAgent.id,
      );
      expect(assignedNames.has("github__search_repositories")).toBe(false);
    });

    test("keeps the strict recovery when the agent's access-all-tools setting is off", async ({
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      const catalog = await makeInternalMcpCatalog({
        organizationId: mockContext.organizationId,
      });
      await makeTool({
        name: "github__search_repositories",
        catalogId: catalog.id,
      });

      // testAgent has the default accessAllTools=false
      const result = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        {
          tool_name: "github__search_repositories",
          tool_args: { query: "archestra" },
        },
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain(
        'No tool named "github__search_repositories"',
      );
      expect(mcpClient.executeToolCallForOwner).not.toHaveBeenCalled();
    });

    test("does not run when the conversation's custom tool selection blocks the tool", async ({
      makeAgentTool,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
    }) => {
      const catalog = await makeInternalMcpCatalog({
        organizationId: mockContext.organizationId,
      });
      const enabled = await makeTool({
        name: "github__search_repositories",
        catalogId: catalog.id,
      });
      await makeAgentTool(dynamicAgent.id, enabled.id);
      await ConversationEnabledToolModel.setEnabledTools(testConversationId, [
        enabled.id,
      ]);
      // accessible but unassigned, and excluded by the custom selection
      await makeTool({
        name: "giphy__image_search",
        catalogId: catalog.id,
      });
      await makeMcpServer({ catalogId: catalog.id, scope: "org" });

      const result = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        { tool_name: "giphy__image_search", tool_args: {} },
        dynamicContext,
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain(
        'No tool named "giphy__image_search"',
      );
      expect(mcpClient.executeToolCallForOwner).not.toHaveBeenCalled();
    });

    test("does not run for sessions without a user (org/team tokens)", async ({
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      const catalog = await makeInternalMcpCatalog({
        organizationId: mockContext.organizationId,
      });
      await makeTool({
        name: "github__search_repositories",
        catalogId: catalog.id,
      });

      const result = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        { tool_name: "github__search_repositories", tool_args: {} },
        { ...dynamicContext, userId: undefined },
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain(
        'No tool named "github__search_repositories"',
      );
      expect(mcpClient.executeToolCallForOwner).not.toHaveBeenCalled();
    });

    test("keeps the unavailable recovery message for a tool whose catalog the user cannot access", async ({
      makeInternalMcpCatalog,
      makeMember,
      makeTeam,
      makeTool,
      makeUser,
    }) => {
      const organizationId = mockContext.organizationId as string;
      const memberUser = await makeUser();
      await makeMember(memberUser.id, organizationId, { role: "member" });
      // memberUser creates the team but is not a member of it
      const team = await makeTeam(organizationId, memberUser.id);
      const catalog = await makeInternalMcpCatalog({
        organizationId,
        scope: "team",
        teams: [team.id],
      });
      await makeTool({
        name: "giphy__image_search",
        catalogId: catalog.id,
      });

      const result = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        { tool_name: "giphy__image_search", tool_args: {} },
        { ...dynamicContext, userId: memberUser.id },
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain(
        'No tool named "giphy__image_search"',
      );
      expect(mcpClient.executeToolCallForOwner).not.toHaveBeenCalled();
    });

    test("evaluates invocation policies for dynamically resolved tools", async ({
      makeAgent,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeMember,
      makeOrganization,
      makeTool,
      makeToolPolicy,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id, { role: "admin" });
      const agent = await makeAgent({
        name: "Dynamic Policy Agent",
        organizationId: org.id,
        accessAllTools: true,
      });
      const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
      const tool = await makeTool({
        name: "workspace__export_data",
        catalogId: catalog.id,
      });
      await makeMcpServer({ catalogId: catalog.id, scope: "org" });
      await makeToolPolicy(tool.id, {
        action: "block_always",
        reason: "External export blocked",
        conditions: [
          { key: "destination", operator: "equal", value: "external" },
        ],
      });

      const result = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        {
          tool_name: "workspace__export_data",
          tool_args: { destination: "external" },
        },
        {
          ...mockContext,
          agent: { id: agent.id, name: agent.name },
          agentId: agent.id,
          organizationId: org.id,
          userId: user.id,
        },
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain(
        "External export blocked",
      );
      // The block carries a machine-readable policy_denied error so clients can
      // render it structurally instead of scraping the prose.
      const archestraError = (result.structuredContent as any)?.archestraError;
      expect(archestraError).toMatchObject({
        type: "policy_denied",
        toolName: "workspace__export_data",
        input: { destination: "external" },
        // The resolved row id rides along so the "Edit policy" modal can open
        // this All-mode tool, which has no agent_tools assignment to look up.
        toolId: tool.id,
      });
      expect((result._meta as any)?.archestraError).toEqual(archestraError);
      expect(mcpClient.executeToolCallForOwner).not.toHaveBeenCalled();
    });
  });

  // Sandbox built-ins (run_command/upload_file/download_file) are Archestra
  // built-ins but ride the same dynamic tool access relaxation as third-party
  // tools, gated on sandbox:execute. Distinct from the third-party path above
  // because they route through executeArchestraTool, not the gateway.
  describe("sandbox built-ins (dynamic tool access)", () => {
    const originalSandboxEnabled = config.skillsSandbox.enabled;
    let dynamicAgent: Agent;
    let dynamicContext: ArchestraContext;

    beforeEach(() => {
      (config.skillsSandbox as { enabled: boolean }).enabled = true;
    });

    afterAll(() => {
      (config.skillsSandbox as { enabled: boolean }).enabled =
        originalSandboxEnabled;
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    // run_command is seeded into the (org-accessible) Archestra catalog. The
    // create hook now auto-assigns the sandbox tools when the runtime flag is on,
    // so we clear all assignments right after creation to keep run_command
    // *unassigned* — every test below exercises the dynamic (unassigned) path.
    beforeEach(async ({ makeAgent }) => {
      await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
      dynamicAgent = await makeAgent({
        name: "Dynamic Sandbox Agent",
        organizationId: mockContext.organizationId,
        accessAllTools: true,
      });
      await AgentToolModel.deleteAllForAgent(dynamicAgent.id);
      dynamicContext = {
        ...mockContext,
        agent: { id: dynamicAgent.id, name: dynamicAgent.name },
        agentId: dynamicAgent.id,
      };
    });

    function stubRunCommand() {
      return vi
        .spyOn(skillSandboxRuntimeService, "runCommand")
        .mockResolvedValue({
          commandId: "cmd-1",
          sandboxId: "sb-1" as any,
          command: "echo hi",
          cwd: null,
          stdout: "hi\n",
          stderr: "",
          exitCode: 0,
          durationMs: 1,
          timedOut: false,
          truncated: false,
          binaryStripped: false,
          stagingNotices: [],
        });
    }

    test("runs an unassigned sandbox tool dynamically without assigning it", async () => {
      const runSpy = stubRunCommand();

      const result = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        { tool_name: "run_command", tool_args: { command: "echo hi" } },
        dynamicContext,
      );

      expect(result.isError).toBeFalsy();
      expect(runSpy).toHaveBeenCalled();
      const assignedNames = await ToolModel.getAssignedToolNames(
        dynamicAgent.id,
      );
      expect(assignedNames.has(TOOL_RUN_COMMAND_FULL_NAME)).toBe(false);
    });

    test("runs a direct unassigned sandbox tool call dynamically", async () => {
      const runSpy = stubRunCommand();

      const result = await executeArchestraTool(
        TOOL_RUN_COMMAND_FULL_NAME,
        { command: "echo hi" },
        dynamicContext,
      );

      expect(result.isError).toBeFalsy();
      expect(runSpy).toHaveBeenCalled();
      const assignedNames = await ToolModel.getAssignedToolNames(
        dynamicAgent.id,
      );
      expect(assignedNames.has(TOOL_RUN_COMMAND_FULL_NAME)).toBe(false);
    });

    test("runs for a user who cannot modify the agent but has sandbox:execute", async ({
      makeCustomRole,
      makeMember,
      makeUser,
    }) => {
      const organizationId = mockContext.organizationId as string;
      const user = await makeUser();
      const role = await makeCustomRole(organizationId, {
        permission: { sandbox: ["execute"], agent: ["read"] },
      });
      await makeMember(user.id, organizationId, { role: role.role });
      const runSpy = stubRunCommand();

      const result = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        { tool_name: "run_command", tool_args: { command: "echo hi" } },
        { ...dynamicContext, userId: user.id },
      );

      expect(result.isError).toBeFalsy();
      expect(runSpy).toHaveBeenCalled();
      const assignedNames = await ToolModel.getAssignedToolNames(
        dynamicAgent.id,
      );
      expect(assignedNames.has(TOOL_RUN_COMMAND_FULL_NAME)).toBe(false);
    });

    test("keeps the not-assigned error when the agent's access-all-tools setting is off", async () => {
      const runSpy = stubRunCommand();

      const result = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        { tool_name: "run_command", tool_args: { command: "echo hi" } },
        mockContext, // testAgent has the default accessAllTools=false
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain(
        "not assigned to this agent",
      );
      expect(runSpy).not.toHaveBeenCalled();
    });

    test("denies when the user lacks sandbox:execute (RBAC before the dynamic gate)", async ({
      makeCustomRole,
      makeMember,
      makeUser,
    }) => {
      const organizationId = mockContext.organizationId as string;
      const user = await makeUser();
      // catalog access + agent rights, but no sandbox:execute
      const role = await makeCustomRole(organizationId, {
        permission: { agent: ["read", "update"] },
      });
      await makeMember(user.id, organizationId, { role: role.role });
      const runSpy = stubRunCommand();

      const result = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        { tool_name: "run_command", tool_args: { command: "echo hi" } },
        { ...dynamicContext, userId: user.id },
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("sandbox:execute");
      expect(runSpy).not.toHaveBeenCalled();
    });
  });

  // Management built-ins (no feature gate) ride the dynamic tool access
  // relaxation too: an All-mode agent runs them unassigned, gated only by
  // RBAC (which runs first) and the per-agent exclusions.
  describe("management built-ins (dynamic tool access)", () => {
    let dynamicAgent: Agent;
    let dynamicContext: ArchestraContext;

    beforeEach(async ({ makeAgent }) => {
      // seed the built-in rows (org-accessible Archestra catalog), keep the
      // agent free of assignments so every call exercises the dynamic path
      await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
      dynamicAgent = await makeAgent({
        name: "Dynamic Management Agent",
        organizationId: mockContext.organizationId,
        accessAllTools: true,
      });
      await AgentToolModel.deleteAllForAgent(dynamicAgent.id);
      dynamicContext = {
        ...mockContext,
        agent: { id: dynamicAgent.id, name: dynamicAgent.name },
        agentId: dynamicAgent.id,
      };
    });

    test("runs an unassigned management built-in dynamically without assigning it", async () => {
      // Creating the agent in All mode pre-filled its exclusion list with the
      // unassigned management built-ins; un-exclude list_agents the way an
      // admin would before it becomes dynamically runnable.
      const listAgents = await ToolModel.findByName(TOOL_LIST_AGENTS_FULL_NAME);
      if (!listAgents) throw new Error("list_agents row missing");
      const current = await agentToolExclusionsService.getExclusions(
        dynamicAgent.id,
      );
      await agentToolExclusionsService.replaceExclusions({
        agentId: dynamicAgent.id,
        organizationId: mockContext.organizationId as string,
        excludedToolIds: current.excludedToolIds.filter(
          (id) => id !== listAgents.id,
        ),
      });

      const result = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        { tool_name: "list_agents", tool_args: {} },
        dynamicContext,
      );

      expect(result.isError).toBeFalsy();
      const assignedNames = await ToolModel.getAssignedToolNames(
        dynamicAgent.id,
      );
      expect(assignedNames.has(TOOL_LIST_AGENTS_FULL_NAME)).toBe(false);
    });

    test("keeps the not-assigned error when the built-in is excluded for the agent", async () => {
      const listAgents = await ToolModel.findByName(TOOL_LIST_AGENTS_FULL_NAME);
      if (!listAgents) throw new Error("list_agents row missing");
      await agentToolExclusionsService.replaceExclusions({
        agentId: dynamicAgent.id,
        organizationId: mockContext.organizationId as string,
        excludedToolIds: [listAgents.id],
      });

      const result = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        { tool_name: "list_agents", tool_args: {} },
        dynamicContext,
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain(
        "not assigned to this agent",
      );
    });

    test("denies when the user lacks the tool's RBAC permission (RBAC before the dynamic gate)", async ({
      makeCustomRole,
      makeMember,
      makeUser,
    }) => {
      const organizationId = mockContext.organizationId as string;
      const user = await makeUser();
      // no agent:read, so list_agents is refused before the assignment gate
      const role = await makeCustomRole(organizationId, {
        permission: { team: ["read"] },
      });
      await makeMember(user.id, organizationId, { role: role.role });

      const result = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        { tool_name: "list_agents", tool_args: {} },
        { ...dynamicContext, userId: user.id },
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("agent:read");
    });
  });

  // With the sandbox feature off, a stale catalog row must not be discoverable
  // or dynamically runnable even though run_command stays in the static name list.
  describe("sandbox built-ins (runtime disabled)", () => {
    test("does not run sandbox tools dynamically when the feature is off", async ({
      makeAgent,
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      const dynamicAgent = await makeAgent({
        name: "Dynamic Sandbox Agent",
        organizationId: mockContext.organizationId,
        accessAllTools: true,
      });
      const catalog = await makeInternalMcpCatalog({
        organizationId: mockContext.organizationId,
      });
      await makeTool({
        name: TOOL_RUN_COMMAND_FULL_NAME,
        catalogId: catalog.id,
      });

      const result = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        { tool_name: "run_command", tool_args: { command: "echo hi" } },
        {
          ...mockContext,
          agent: { id: dynamicAgent.id, name: dynamicAgent.name },
          agentId: dynamicAgent.id,
        },
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain(
        "not assigned to this agent",
      );
      const assignedNames = await ToolModel.getAssignedToolNames(
        dynamicAgent.id,
      );
      expect(assignedNames.has(TOOL_RUN_COMMAND_FULL_NAME)).toBe(false);
    });
  });

  test("headless dispatch scopes the MCP session by the isolation key", async ({
    makeAgentTool,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog();
    const tool = await makeTool({
      name: "github__search_repositories",
      catalogId: catalog.id,
    });
    await makeAgentTool(testAgent.id, tool.id);

    vi.mocked(mcpClient.executeToolCallForOwner).mockResolvedValueOnce({
      content: [{ type: "text", text: "ok" }],
      isError: false,
    } as any);

    const isolationKey = crypto.randomUUID();
    await executeArchestraTool(
      TOOL_RUN_TOOL_FULL_NAME,
      {
        tool_name: "github__search_repositories",
        tool_args: { query: "archestra" },
      },
      { ...mockContext, conversationId: undefined, isolationKey },
    );

    // concurrent headless executions must not share an MCP session (e.g. a
    // browser context), so the per-execution key scopes the connection.
    expect(mcpClient.executeToolCallForOwner).toHaveBeenCalledWith(
      expect.objectContaining({ name: "github__search_repositories" }),
      agentOwner(testAgent.id),
      mockContext.tokenAuth,
      { conversationId: isolationKey },
    );
  });

  describe("per-conversation tool filter", () => {
    test("rejects a third-party tool disabled for the conversation (call-time re-check)", async ({
      makeAgentTool,
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      const catalog = await makeInternalMcpCatalog();
      const enabled = await makeTool({
        name: "github__search_repositories",
        catalogId: catalog.id,
      });
      const disabled = await makeTool({
        name: "github__create_issue",
        catalogId: catalog.id,
      });
      await makeAgentTool(testAgent.id, enabled.id);
      await makeAgentTool(testAgent.id, disabled.id);
      // conversation enables only `enabled`; the disabled tool may have been
      // shown by an earlier search before the selection narrowed.
      await ConversationEnabledToolModel.setEnabledTools(testConversationId, [
        enabled.id,
      ]);

      const result = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        { tool_name: "github__create_issue", tool_args: {} },
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain(
        "not enabled for this conversation",
      );
      expect(mcpClient.executeToolCallForOwner).not.toHaveBeenCalled();
    });

    test("dispatches a third-party tool enabled for the conversation", async ({
      makeAgentTool,
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      const catalog = await makeInternalMcpCatalog();
      const tool = await makeTool({
        name: "github__search_repositories",
        catalogId: catalog.id,
      });
      await makeAgentTool(testAgent.id, tool.id);
      await ConversationEnabledToolModel.setEnabledTools(testConversationId, [
        tool.id,
      ]);

      vi.mocked(mcpClient.executeToolCallForOwner).mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
        isError: false,
        _meta: {},
        structuredContent: { ok: true },
      } as any);

      const result = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        { tool_name: "github__search_repositories", tool_args: {} },
        mockContext,
      );

      expect(result.isError).toBe(false);
      expect(mcpClient.executeToolCallForOwner).toHaveBeenCalled();
    });

    test("allows Archestra built-ins under an empty custom selection", async ({
      seedAndAssignArchestraTools,
    }) => {
      await seedAndAssignArchestraTools(testAgent.id);
      await ConversationEnabledToolModel.setEnabledTools(
        testConversationId,
        [],
      );

      const result = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        { tool_name: "whoami" },
        mockContext,
      );

      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({
        agentId: testAgent.id,
        agentName: testAgent.name,
      });
    });

    test("returns the unavailable-tool recovery message (not 'not enabled') for an unassigned name under a custom selection", async ({
      makeAgentTool,
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      const catalog = await makeInternalMcpCatalog();
      const assigned = await makeTool({
        name: "github__search_repositories",
        catalogId: catalog.id,
      });
      await makeAgentTool(testAgent.id, assigned.id);
      await ConversationEnabledToolModel.setEnabledTools(testConversationId, [
        assigned.id,
      ]);

      const result = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        { tool_name: "giphy__image_search", tool_args: {} },
        mockContext,
      );

      expect(result.isError).toBe(true);
      const text = (result.content[0] as any).text;
      // existence check wins: the unassigned name is not falsely reported as
      // merely "not enabled for this conversation".
      expect(text).toContain('No tool named "giphy__image_search"');
      expect(text).not.toContain("not enabled for this conversation");
      expect(mcpClient.executeToolCallForOwner).not.toHaveBeenCalled();
    });

    test("rejects an agent-delegation tool disabled for the conversation", async ({
      makeAgent,
      makeAgentTool,
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      const targetAgent = await makeAgent({
        name: "Research Agent",
        organizationId: mockContext.organizationId,
      });
      const delegationTool = await ToolModel.findOrCreateDelegationTool(
        targetAgent.id,
      );
      await makeAgentTool(testAgent.id, delegationTool.id);
      const catalog = await makeInternalMcpCatalog();
      const other = await makeTool({
        name: "github__search_repositories",
        catalogId: catalog.id,
      });
      await makeAgentTool(testAgent.id, other.id);
      // enable only the unrelated third-party tool, excluding the delegation tool
      await ConversationEnabledToolModel.setEnabledTools(testConversationId, [
        other.id,
      ]);

      const result = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        {
          tool_name: `${AGENT_TOOL_PREFIX}${slugify(targetAgent.name)}`,
          tool_args: { message: "hi" },
        },
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain(
        "not enabled for this conversation",
      );
      expect(mockExecuteA2AMessage).not.toHaveBeenCalled();
    });
  });

  test("returns a search_tools recovery message for an unavailable third-party tool", async () => {
    const result = await executeArchestraTool(
      TOOL_RUN_TOOL_FULL_NAME,
      {
        tool_name: "giphy__image_search_tool",
        tool_args: { query: "cat" },
      },
      mockContext,
    );

    expect(result.isError).toBe(true);
    const text = (result.content[0] as any).text;
    expect(text).toContain('No tool named "giphy__image_search_tool"');
    expect(text).toContain("search_tools");
    expect(text).not.toContain("not enabled for this conversation");
    expect(mcpClient.executeToolCallForOwner).not.toHaveBeenCalled();
  });

  test("recovery message wins over the policy refusal when the agent has other tools", async ({
    makeAgentTool,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    // Reproduces the staging case: the agent HAS an assigned tool, so the
    // policy gate's disabled-tool filter is active (non-empty enabled set) and
    // would otherwise emit "not enabled for this conversation" for a
    // hallucinated name. The pre-check must intercept first.
    const catalog = await makeInternalMcpCatalog();
    const assigned = await makeTool({
      name: "github__search_repositories",
      catalogId: catalog.id,
    });
    await makeAgentTool(testAgent.id, assigned.id);

    const result = await executeArchestraTool(
      TOOL_RUN_TOOL_FULL_NAME,
      { tool_name: "giphy__image_search_tool", tool_args: { query: "cat" } },
      mockContext,
    );

    expect(result.isError).toBe(true);
    const text = (result.content[0] as any).text;
    expect(text).toContain('No tool named "giphy__image_search_tool"');
    expect(text).not.toContain("not enabled for this conversation");
    expect(mcpClient.executeToolCallForOwner).not.toHaveBeenCalled();
  });

  test("blocks third-party MCP tools when target invocation policy denies the call", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeMember,
    makeOrganization,
    makeTool,
    makeToolPolicy,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeAgent({
      name: "Run Tool Policy Agent",
      organizationId: org.id,
    });
    const catalog = await makeInternalMcpCatalog();
    const tool = await makeTool({
      name: `workspace__export_${crypto.randomUUID().slice(0, 8)}`,
      catalogId: catalog.id,
    });
    await makeAgentTool(agent.id, tool.id);
    await makeToolPolicy(tool.id, {
      action: "block_always",
      reason: "External export blocked",
      conditions: [
        { key: "destination", operator: "equal", value: "external" },
      ],
    });

    const result = await executeArchestraTool(
      TOOL_RUN_TOOL_FULL_NAME,
      {
        tool_name: tool.name,
        tool_args: { destination: "external" },
      },
      {
        ...mockContext,
        agent: { id: agent.id, name: agent.name },
        agentId: agent.id,
        organizationId: org.id,
        userId: user.id,
      },
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(tool.name);
    expect((result.content[0] as any).text).toContain(
      "External export blocked",
    );
    expect(mcpClient.executeToolCallForOwner).not.toHaveBeenCalled();
  });

  test("blocks third-party MCP tools that require approval when approval was not handled", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeMember,
    makeOrganization,
    makeTool,
    makeToolPolicy,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeAgent({
      name: "Run Tool Approval Agent",
      organizationId: org.id,
    });
    const catalog = await makeInternalMcpCatalog();
    const tool = await makeTool({
      name: `workspace__approve_${crypto.randomUUID().slice(0, 8)}`,
      catalogId: catalog.id,
    });
    await makeAgentTool(agent.id, tool.id);
    await makeToolPolicy(tool.id, {
      action: "require_approval",
      conditions: [],
    });

    const result = await executeArchestraTool(
      TOOL_RUN_TOOL_FULL_NAME,
      {
        tool_name: tool.name,
        tool_args: { destination: "external" },
      },
      {
        ...mockContext,
        agent: { id: agent.id, name: agent.name },
        agentId: agent.id,
        organizationId: org.id,
        userId: user.id,
      },
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(tool.name);
    expect((result.content[0] as any).text).toContain(
      TOOL_INVOCATION_APPROVAL_REQUIRED_AUTONOMOUS_REASON,
    );
    expect(mcpClient.executeToolCallForOwner).not.toHaveBeenCalled();
  });

  test("dispatches approval-required third-party MCP tools after chat approval was handled", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeMember,
    makeOrganization,
    makeTool,
    makeToolPolicy,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeAgent({
      name: "Run Tool Approved Agent",
      organizationId: org.id,
    });
    const catalog = await makeInternalMcpCatalog();
    const tool = await makeTool({
      name: `workspace__approved_${crypto.randomUUID().slice(0, 8)}`,
      catalogId: catalog.id,
    });
    await makeAgentTool(agent.id, tool.id);
    await makeToolPolicy(tool.id, {
      action: "require_approval",
      conditions: [],
    });
    vi.mocked(mcpClient.executeToolCallForOwner).mockResolvedValueOnce({
      content: [{ type: "text", text: "Approved response" }],
      isError: false,
    } as any);

    const result = await executeArchestraTool(
      TOOL_RUN_TOOL_FULL_NAME,
      {
        tool_name: tool.name,
        tool_args: { destination: "external" },
      },
      {
        ...mockContext,
        agent: { id: agent.id, name: agent.name },
        agentId: agent.id,
        organizationId: org.id,
        userId: user.id,
        approvalRequiredPoliciesHandled: true,
      },
    );

    expect(result.isError).toBe(false);
    expect(mcpClient.executeToolCallForOwner).toHaveBeenCalledWith(
      expect.objectContaining({
        name: tool.name,
        arguments: { destination: "external" },
      }),
      agentOwner(agent.id),
      mockContext.tokenAuth,
      { conversationId: testConversationId },
    );
    expect(result.content).toEqual([
      { type: "text", text: "Approved response" },
    ]);
  });

  test("normalizes non-array third-party content to a text result", async ({
    makeAgentTool,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog();
    const tool = await makeTool({
      name: "github__get_repository",
      catalogId: catalog.id,
    });
    await makeAgentTool(testAgent.id, tool.id);

    vi.mocked(mcpClient.executeToolCallForOwner).mockResolvedValueOnce({
      content: { ok: true },
      isError: false,
    } as any);

    const result = await executeArchestraTool(
      TOOL_RUN_TOOL_FULL_NAME,
      { tool_name: "github__get_repository", tool_args: { name: "repo" } },
      mockContext,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify({ ok: true }) },
    ]);
  });

  // A structurally-invalid tool_args object is caught before dispatch and the
  // model gets the target tool's full schema back — the targeted feedback the
  // compact search_tools signature defers to.
  describe("third-party tool_args structural feedback", () => {
    const submitResultSchema = {
      type: "object",
      properties: { result: { type: "object", additionalProperties: true } },
      required: ["result"],
    };

    test("returns the full schema when a required tool_args key is missing (no dispatch)", async ({
      makeAgentTool,
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      const catalog = await makeInternalMcpCatalog();
      const tool = await makeTool({
        name: "final_answer__submit_result",
        catalogId: catalog.id,
        parameters: submitResultSchema,
      });
      await makeAgentTool(testAgent.id, tool.id);

      const result = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        { tool_name: "final_answer__submit_result", tool_args: {} },
        mockContext,
      );

      expect(result.isError).toBe(true);
      const text = (result.content[0] as any).text;
      expect(text).toContain(
        'Invalid tool_args for "final_answer__submit_result"',
      );
      expect(text).toContain('missing required parameter "result"');
      // the empty call is echoed back and a filled skeleton shows the fix
      expect(text).toContain(
        'You sent: {"tool_name":"final_answer__submit_result","tool_args":{}}',
      );
      expect(text).toContain('"result": <object>');
      // the full schema is echoed for self-correction
      expect(text).toContain('"required"');
      expect(text).toContain('"additionalProperties"');
      expect(mcpClient.executeToolCallForOwner).not.toHaveBeenCalled();
    });

    test("unpacks a declared nested object shape into the skeleton (no dispatch)", async ({
      makeAgentTool,
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      const catalog = await makeInternalMcpCatalog();
      const tool = await makeTool({
        name: "search__query",
        catalogId: catalog.id,
        parameters: {
          type: "object",
          properties: {
            filter: {
              type: "object",
              properties: {
                field: { type: "string" },
                limit: { type: "number" },
              },
              required: ["field", "limit"],
            },
          },
          required: ["filter"],
        },
      });
      await makeAgentTool(testAgent.id, tool.id);

      const result = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        { tool_name: "search__query", tool_args: {} },
        mockContext,
      );

      expect(result.isError).toBe(true);
      const text = (result.content[0] as any).text;
      expect(text).toContain(
        '"filter": {"field": <string>, "limit": <number>}',
      );
      expect(mcpClient.executeToolCallForOwner).not.toHaveBeenCalled();
    });

    test("unpacks an array of objects with an enum member into the skeleton (no dispatch)", async ({
      makeAgentTool,
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      const catalog = await makeInternalMcpCatalog();
      const tool = await makeTool({
        name: "tickets__bulk_update",
        catalogId: catalog.id,
        parameters: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  status: { type: "string", enum: ["open", "closed"] },
                },
                required: ["id", "status"],
              },
            },
          },
          required: ["items"],
        },
      });
      await makeAgentTool(testAgent.id, tool.id);

      const result = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        { tool_name: "tickets__bulk_update", tool_args: {} },
        mockContext,
      );

      expect(result.isError).toBe(true);
      const text = (result.content[0] as any).text;
      expect(text).toContain('"items": [{"id": <string>, "status": "open"}]');
      expect(mcpClient.executeToolCallForOwner).not.toHaveBeenCalled();
    });

    test("returns the full schema for an unknown key under additionalProperties:false (no dispatch)", async ({
      makeAgentTool,
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      const catalog = await makeInternalMcpCatalog();
      const tool = await makeTool({
        name: "github__search_repositories",
        catalogId: catalog.id,
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
      });
      await makeAgentTool(testAgent.id, tool.id);

      const result = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        {
          tool_name: "github__search_repositories",
          tool_args: { query: "x", bogus: 1 },
        },
        mockContext,
      );

      expect(result.isError).toBe(true);
      const text = (result.content[0] as any).text;
      expect(text).toContain('unexpected parameter "bogus"');
      // echo + skeleton hold for the unknown-key path too, not just missing-key
      expect(text).toContain(
        'You sent: {"tool_name":"github__search_repositories","tool_args":{"query":"x","bogus":1}}',
      );
      expect(text).toContain('"query": <string>');
      expect(mcpClient.executeToolCallForOwner).not.toHaveBeenCalled();
    });

    test("dispatches a structurally-valid call with a schema", async ({
      makeAgentTool,
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      const catalog = await makeInternalMcpCatalog();
      const tool = await makeTool({
        name: "github__search_repositories",
        catalogId: catalog.id,
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      });
      await makeAgentTool(testAgent.id, tool.id);
      vi.mocked(mcpClient.executeToolCallForOwner).mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
        isError: false,
      } as any);

      const result = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        {
          tool_name: "github__search_repositories",
          tool_args: { query: "archestra" },
        },
        mockContext,
      );

      expect(result.isError).toBe(false);
      expect(mcpClient.executeToolCallForOwner).toHaveBeenCalled();
    });

    test("does not falsely reject when required is expressed via allOf (dispatches)", async ({
      makeAgentTool,
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      const catalog = await makeInternalMcpCatalog();
      const tool = await makeTool({
        name: "github__search_repositories",
        catalogId: catalog.id,
        // `required` is nested in allOf, not a literal top-level array, so the
        // conservative check must not enforce it.
        parameters: {
          type: "object",
          allOf: [{ required: ["query"] }],
        },
      });
      await makeAgentTool(testAgent.id, tool.id);
      vi.mocked(mcpClient.executeToolCallForOwner).mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
        isError: false,
      } as any);

      const result = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        { tool_name: "github__search_repositories", tool_args: {} },
        mockContext,
      );

      expect(result.isError).toBe(false);
      expect(mcpClient.executeToolCallForOwner).toHaveBeenCalled();
    });

    test("does not reject an unknown key admitted by patternProperties (dispatches)", async ({
      makeAgentTool,
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      const catalog = await makeInternalMcpCatalog();
      const tool = await makeTool({
        name: "github__search_repositories",
        catalogId: catalog.id,
        // additionalProperties:false but patternProperties admits `x-*` keys, so
        // the unknown-key check must stand down.
        parameters: {
          type: "object",
          properties: { fixed: { type: "string" } },
          required: ["fixed"],
          additionalProperties: false,
          patternProperties: { "^x-": { type: "string" } },
        },
      });
      await makeAgentTool(testAgent.id, tool.id);
      vi.mocked(mcpClient.executeToolCallForOwner).mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
        isError: false,
      } as any);

      const result = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        {
          tool_name: "github__search_repositories",
          tool_args: { fixed: "a", "x-trace": "b" },
        },
        mockContext,
      );

      expect(result.isError).toBe(false);
      expect(mcpClient.executeToolCallForOwner).toHaveBeenCalled();
    });

    test("returns the full schema for a dynamically-resolved invalid call (no dispatch)", async ({
      makeAgent,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
    }) => {
      const dynamicAgent = await makeAgent({
        name: "Dynamic Schema Agent",
        organizationId: mockContext.organizationId,
        accessAllTools: true,
      });
      const catalog = await makeInternalMcpCatalog({
        organizationId: mockContext.organizationId,
      });
      await makeTool({
        name: "final_answer__submit_result",
        catalogId: catalog.id,
        parameters: submitResultSchema,
      });
      await makeMcpServer({ catalogId: catalog.id, scope: "org" });

      const result = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        { tool_name: "final_answer__submit_result", tool_args: {} },
        {
          ...mockContext,
          agent: { id: dynamicAgent.id, name: dynamicAgent.name },
          agentId: dynamicAgent.id,
        },
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain(
        'missing required parameter "result"',
      );
      expect(mcpClient.executeToolCallForOwner).not.toHaveBeenCalled();
    });
  });

  // A single-key wrapper object (any key — {"value": …}, {"appId": …},
  // {"my-app": …}) or the two-key {type:"text",text} content block around a param
  // the target schema declares scalar/array is unwrapped before policy
  // evaluation, the structural pre-check, and dispatch — and the repair is
  // disclosed on the result. The guard is on the declared type only; anything the
  // schema could accept as sent is never touched.
  describe("schema-aware envelope repair", () => {
    const originalSandboxEnabled = config.skillsSandbox.enabled;

    afterEach(() => {
      (config.skillsSandbox as { enabled: boolean }).enabled =
        originalSandboxEnabled;
      vi.restoreAllMocks();
    });

    test('unwraps {"value": …} around a string-declared built-in param', async ({
      seedAndAssignArchestraTools,
    }) => {
      (config.skillsSandbox as { enabled: boolean }).enabled = true;
      await seedAndAssignArchestraTools(testAgent.id);
      const runSpy = vi
        .spyOn(skillSandboxRuntimeService, "runCommand")
        .mockResolvedValue({
          commandId: "cmd-1",
          sandboxId: "sb-1" as any,
          command: "echo hi",
          cwd: null,
          stdout: "hi\n",
          stderr: "",
          exitCode: 0,
          durationMs: 1,
          timedOut: false,
          truncated: false,
          binaryStripped: false,
          stagingNotices: [],
        });

      const result = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        {
          tool_name: "run_command",
          tool_args: { command: { value: "echo hi" } },
        },
        mockContext,
      );

      expect(result.isError).toBeFalsy();
      // the dispatched target received the unwrapped string
      expect(runSpy).toHaveBeenCalledWith(
        expect.objectContaining({ command: "echo hi" }),
      );
      const text = result.content.map((item) => (item as any).text).join("\n");
      expect(text).toContain('"command"');
    });

    test('unwraps {"item": […]} and {"value": […]} around an array-declared built-in param', async ({
      seedAndAssignArchestraTools,
    }) => {
      await seedAndAssignArchestraTools(testAgent.id);
      const todos = [{ id: 1, content: "write tests", status: "pending" }];

      for (const envelope of [{ item: todos }, { value: todos }]) {
        const result = await executeArchestraTool(
          TOOL_RUN_TOOL_FULL_NAME,
          {
            tool_name: TOOL_TODO_WRITE_FULL_NAME,
            tool_args: { todos: envelope },
          },
          mockContext,
        );

        // todo_write's strict schema rejects the envelope as sent, so a
        // successful write proves the handler received the unwrapped array.
        expect(result.isError).toBe(false);
        expect(result.structuredContent).toEqual({
          success: true,
          todoCount: 1,
        });
        const text = result.content
          .map((item) => (item as any).text)
          .join("\n");
        expect(text).toContain("todos");
      }
    });

    test("unwraps envelopes for a third-party string-declared param and notes the repair", async ({
      makeAgentTool,
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      const catalog = await makeInternalMcpCatalog();
      const tool = await makeTool({
        name: "github__search_repositories",
        catalogId: catalog.id,
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      });
      await makeAgentTool(testAgent.id, tool.id);

      for (const envelope of [{ value: "archestra" }, { $text: "archestra" }]) {
        vi.mocked(mcpClient.executeToolCallForOwner).mockResolvedValueOnce({
          content: [{ type: "text", text: "ok" }],
          isError: false,
        } as any);

        const result = await executeArchestraTool(
          TOOL_RUN_TOOL_FULL_NAME,
          {
            tool_name: "github__search_repositories",
            tool_args: { query: envelope },
          },
          mockContext,
        );

        expect(result.isError).toBe(false);
        expect(mcpClient.executeToolCallForOwner).toHaveBeenLastCalledWith(
          expect.objectContaining({ arguments: { query: "archestra" } }),
          agentOwner(testAgent.id),
          mockContext.tokenAuth,
          { conversationId: testConversationId },
        );
        const text = result.content
          .map((item) => (item as any).text)
          .join("\n");
        expect(text).toContain('"query"');
      }
    });

    test("unwraps a {type:'text', text:X} content-block wrapper on dispatch and notes the repair", async ({
      makeAgentTool,
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      const catalog = await makeInternalMcpCatalog();
      const tool = await makeTool({
        name: "github__search_repositories",
        catalogId: catalog.id,
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      });
      await makeAgentTool(testAgent.id, tool.id);
      vi.mocked(mcpClient.executeToolCallForOwner).mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
        isError: false,
      } as any);

      const result = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        {
          tool_name: "github__search_repositories",
          tool_args: { query: { type: "text", text: "archestra" } },
        },
        mockContext,
      );

      expect(result.isError).toBe(false);
      // the target handler receives the unwrapped string, not the content block
      expect(mcpClient.executeToolCallForOwner).toHaveBeenLastCalledWith(
        expect.objectContaining({ arguments: { query: "archestra" } }),
        agentOwner(testAgent.id),
        mockContext.tokenAuth,
        { conversationId: testConversationId },
      );
      const text = result.content.map((item) => (item as any).text).join("\n");
      expect(text).toContain('"query"');
    });

    test("unwraps a param-name-keyed wrapper around a primitive-declared param", async ({
      makeAgentTool,
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      const catalog = await makeInternalMcpCatalog();
      const tool = await makeTool({
        name: "workspace__get_app",
        catalogId: catalog.id,
        parameters: {
          type: "object",
          properties: { appId: { type: "string" } },
          required: ["appId"],
        },
      });
      await makeAgentTool(testAgent.id, tool.id);
      const appId = crypto.randomUUID();
      vi.mocked(mcpClient.executeToolCallForOwner).mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
        isError: false,
      } as any);

      const result = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        {
          tool_name: "workspace__get_app",
          tool_args: { appId: { appId } },
        },
        mockContext,
      );

      expect(result.isError).toBe(false);
      expect(mcpClient.executeToolCallForOwner).toHaveBeenCalledWith(
        expect.objectContaining({ arguments: { appId } }),
        agentOwner(testAgent.id),
        mockContext.tokenAuth,
        { conversationId: testConversationId },
      );
      // The upstream result is one block; the disclosed repair note is the
      // extra one.
      expect(result.content).toHaveLength(2);
      expect(result.content[0]).toEqual({ type: "text", text: "ok" });
      expect((result.content[1] as any).type).toBe("text");
    });

    test("repairEnvelopedToolArgs reports a param-name-keyed repair as data", () => {
      const { repairedParams, toolArgs } =
        runToolInternals.repairEnvelopedToolArgs({
          toolArgs: { appId: { appId: "abc-123" }, limit: 5 },
          schema: {
            type: "object",
            properties: {
              appId: { type: "string" },
              limit: { type: "number" },
            },
          },
        });

      expect(repairedParams).toEqual(["appId"]);
      expect(toolArgs).toEqual({ appId: "abc-123", limit: 5 });
    });

    test("an object-declared param with a same-named single inner key passes through by reference", () => {
      const sent = { config: { config: { nested: true } } };
      const { repairedParams, toolArgs } =
        runToolInternals.repairEnvelopedToolArgs({
          toolArgs: sent,
          schema: {
            type: "object",
            properties: { config: { type: "object" } },
          },
        });

      expect(repairedParams).toEqual([]);
      expect(toolArgs).toBe(sent);
    });

    test("does not repair when the declared param type is object", async ({
      makeAgentTool,
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      const catalog = await makeInternalMcpCatalog();
      const tool = await makeTool({
        name: "final_answer__submit_result",
        catalogId: catalog.id,
        parameters: {
          type: "object",
          properties: {
            result: { type: "object", additionalProperties: true },
          },
          required: ["result"],
        },
      });
      await makeAgentTool(testAgent.id, tool.id);
      vi.mocked(mcpClient.executeToolCallForOwner).mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
        isError: false,
      } as any);

      const result = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        {
          tool_name: "final_answer__submit_result",
          tool_args: { result: { value: "x" } },
        },
        mockContext,
      );

      expect(result.isError).toBe(false);
      // the envelope IS a valid object for this schema — dispatched untouched,
      // with no repair note appended
      expect(mcpClient.executeToolCallForOwner).toHaveBeenCalledWith(
        expect.objectContaining({ arguments: { result: { value: "x" } } }),
        agentOwner(testAgent.id),
        mockContext.tokenAuth,
        { conversationId: testConversationId },
      );
      expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    });

    test("does not repair when the declared type is absent or non-literal", async ({
      makeAgentTool,
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      const catalog = await makeInternalMcpCatalog();
      const tool = await makeTool({
        name: "loose__ingest",
        catalogId: catalog.id,
        parameters: {
          type: "object",
          properties: {
            payload: {},
            flexible: { type: ["string", "null"] },
          },
        },
      });
      await makeAgentTool(testAgent.id, tool.id);
      vi.mocked(mcpClient.executeToolCallForOwner).mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
        isError: false,
      } as any);

      const sentArgs = { payload: { value: "x" }, flexible: { value: "y" } };
      const result = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        { tool_name: "loose__ingest", tool_args: sentArgs },
        mockContext,
      );

      expect(result.isError).toBe(false);
      expect(mcpClient.executeToolCallForOwner).toHaveBeenCalledWith(
        expect.objectContaining({ arguments: sentArgs }),
        agentOwner(testAgent.id),
        mockContext.tokenAuth,
        { conversationId: testConversationId },
      );
      expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    });

    test("does not repair multi-key objects or mismatched inner types", async ({
      makeAgentTool,
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      const catalog = await makeInternalMcpCatalog();
      const tool = await makeTool({
        name: "github__search_repositories",
        catalogId: catalog.id,
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      });
      await makeAgentTool(testAgent.id, tool.id);

      const nonRepairable = [
        { value: "x", extra: "y" }, // multi-key, not the {type,text} content block
        { value: 123 }, // single-key but inner type does not match the declared string
      ];
      for (const sent of nonRepairable) {
        vi.mocked(mcpClient.executeToolCallForOwner).mockResolvedValueOnce({
          content: [{ type: "text", text: "ok" }],
          isError: false,
        } as any);

        const result = await executeArchestraTool(
          TOOL_RUN_TOOL_FULL_NAME,
          {
            tool_name: "github__search_repositories",
            tool_args: { query: sent },
          },
          mockContext,
        );

        expect(result.isError).toBe(false);
        expect(mcpClient.executeToolCallForOwner).toHaveBeenLastCalledWith(
          expect.objectContaining({ arguments: { query: sent } }),
          agentOwner(testAgent.id),
          mockContext.tokenAuth,
          { conversationId: testConversationId },
        );
        expect(result.content).toEqual([{ type: "text", text: "ok" }]);
      }
    });

    test("passes a call that is valid as sent through unchanged, with no note", async ({
      makeAgentTool,
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      const catalog = await makeInternalMcpCatalog();
      const tool = await makeTool({
        name: "github__search_repositories",
        catalogId: catalog.id,
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      });
      await makeAgentTool(testAgent.id, tool.id);
      vi.mocked(mcpClient.executeToolCallForOwner).mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
        isError: false,
      } as any);

      const result = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        {
          tool_name: "github__search_repositories",
          tool_args: { query: "archestra" },
        },
        mockContext,
      );

      expect(result.isError).toBe(false);
      expect(mcpClient.executeToolCallForOwner).toHaveBeenCalledWith(
        expect.objectContaining({ arguments: { query: "archestra" } }),
        agentOwner(testAgent.id),
        mockContext.tokenAuth,
        { conversationId: testConversationId },
      );
      expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    });

    test("invocation policy evaluates the repaired args and the note rides on the refusal", async ({
      makeAgent,
      makeAgentTool,
      makeInternalMcpCatalog,
      makeMember,
      makeOrganization,
      makeTool,
      makeToolPolicy,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id, { role: "admin" });
      const agent = await makeAgent({
        name: "Repair Policy Agent",
        organizationId: org.id,
      });
      const catalog = await makeInternalMcpCatalog();
      const tool = await makeTool({
        name: `workspace__export_${crypto.randomUUID().slice(0, 8)}`,
        catalogId: catalog.id,
        parameters: {
          type: "object",
          properties: { destination: { type: "string" } },
          required: ["destination"],
        },
      });
      await makeAgentTool(agent.id, tool.id);
      await makeToolPolicy(tool.id, {
        action: "block_always",
        reason: "External export blocked",
        conditions: [
          { key: "destination", operator: "equal", value: "external" },
        ],
      });

      const result = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        {
          tool_name: tool.name,
          tool_args: { destination: { value: "external" } },
        },
        {
          ...mockContext,
          agent: { id: agent.id, name: agent.name },
          agentId: agent.id,
          organizationId: org.id,
          userId: user.id,
        },
      );

      expect(result.isError).toBe(true);
      // The condition matches only the unwrapped string, so the block firing
      // proves the policy evaluated the repaired args — visible in the
      // structured error's input too.
      expect((result.structuredContent as any)?.archestraError).toMatchObject({
        type: "policy_denied",
        input: { destination: "external" },
      });
      const text = result.content.map((item) => (item as any).text).join("\n");
      expect(text).toContain("External export blocked");
      expect(text).toContain('"destination"');
      expect(mcpClient.executeToolCallForOwner).not.toHaveBeenCalled();
    });

    test("leaves a string-carried scalar wrapped — the repair never retypes a value", () => {
      const schema = {
        type: "object",
        properties: {
          n: { type: "number" },
          i: { type: "integer" },
          b: { type: "boolean" },
        },
      };
      // The inner value is the model's own but its type does not match the
      // declared scalar, so the wrapper stays and the target's validation
      // error (with the parameter skeleton) teaches the shape instead.
      const cases: Array<[string, unknown]> = [
        ["n", { $text: "1.5" }],
        ["n", { $text: "0x10" }],
        ["i", { $text: "2" }],
        ["i", { value: 1.5 }],
        ["b", { value: "true" }],
        ["b", { $text: "yes" }],
      ];
      for (const [key, wrapped] of cases) {
        const { repairedParams, toolArgs } =
          runToolInternals.repairEnvelopedToolArgs({
            toolArgs: { [key]: wrapped },
            schema,
          });
        expect(repairedParams).toEqual([]);
        expect(toolArgs).toEqual({ [key]: wrapped });
      }
    });

    test("unwraps the {type:'text', text:X} content-block wrapper when the inner type matches", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          count: { type: "number" },
          tags: { type: "array" },
          note: { type: "string" },
        },
      };
      const { repairedParams, toolArgs } =
        runToolInternals.repairEnvelopedToolArgs({
          toolArgs: {
            name: { type: "text", text: "personal" },
            count: { type: "text", text: "5" }, // string inner on a number param — stays wrapped
            tags: { type: "text", text: ["a", "b"] },
            note: { type: "text", text: "" },
          },
          schema,
        });

      expect(repairedParams.sort()).toEqual(["name", "note", "tags"]);
      expect(toolArgs).toEqual({
        name: "personal",
        count: { type: "text", text: "5" },
        tags: ["a", "b"],
        note: "",
      });
    });

    test("leaves malformed or non-scalar-typed content-block wrappers untouched", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          obj: { type: "object" },
        },
      };
      const cases: Array<[string, unknown]> = [
        // three keys — the content block carries an extra field we must not drop
        [
          "name",
          { type: "text", text: "x", cache_control: { type: "ephemeral" } },
        ],
        ["name", { type: "image", text: "x" }], // two keys, wrong content-block type
        ["name", { type: "text", text: { nested: true } }], // non-string text on a string param
        ["obj", { type: "text", text: "x" }], // object-declared param is never repairable
      ];
      for (const [key, wrapped] of cases) {
        const { repairedParams, toolArgs } =
          runToolInternals.repairEnvelopedToolArgs({
            toolArgs: { [key]: wrapped },
            schema,
          });
        expect(repairedParams).toEqual([]);
        expect(toolArgs).toEqual({ [key]: wrapped });
      }
    });

    test("leaves a content-block wrapper against a composed schema untouched", () => {
      const wrapped = { type: "text", text: "x" };
      const composed: unknown[] = [
        { $ref: "#/$defs/P" },
        { anyOf: [{ type: "string" }] },
        { oneOf: [{ type: "string" }] },
        { allOf: [{ type: "string" }] },
      ];
      for (const p of composed) {
        const { repairedParams, toolArgs } =
          runToolInternals.repairEnvelopedToolArgs({
            toolArgs: { p: wrapped },
            schema: { type: "object", properties: { p } },
          });
        expect(repairedParams).toEqual([]);
        expect(toolArgs).toEqual({ p: wrapped });
      }
    });

    test("unwraps a single-key wrapper keyed by an arbitrary string", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          tools: { type: "array" },
          version: { type: "integer" },
          enabled: { type: "boolean" },
        },
      };
      // The exact shape kimi looped on: every scalar wrapped under the app-name
      // string, which no envelope allow-list would have matched.
      const { repairedParams, toolArgs } =
        runToolInternals.repairEnvelopedToolArgs({
          toolArgs: {
            name: { "standup-notes-app": "standup-notes-app" },
            description: { "standup-notes-app": "A personal standup notepad." },
            tools: { "standup-notes-app": [] },
            version: { anything: 5 },
            enabled: { whatever: true },
          },
          schema,
        });

      expect(repairedParams.sort()).toEqual([
        "description",
        "enabled",
        "name",
        "tools",
        "version",
      ]);
      expect(toolArgs).toEqual({
        name: "standup-notes-app",
        description: "A personal standup notepad.",
        tools: [],
        version: 5,
        enabled: true,
      });
    });

    test("unwraps a single-key {type: X} object as a plain wrapper", () => {
      // A one-key object named `type` is a single-key wrapper, not a content
      // block (which is exactly two keys {type, text}). Its sole value unwraps.
      const schema = {
        type: "object",
        properties: { name: { type: "string" } },
      };
      for (const [wrapped, expected] of [
        [{ type: "text" }, "text"],
        [{ type: "image" }, "image"],
        [{ type: "tool_use" }, "tool_use"],
      ] as Array<[Record<string, unknown>, string]>) {
        const { repairedParams, toolArgs } =
          runToolInternals.repairEnvelopedToolArgs({
            toolArgs: { name: wrapped },
            schema,
          });
        expect(repairedParams).toEqual(["name"]);
        expect(toolArgs).toEqual({ name: expected });
      }
    });

    test("guard is declared-type only: unwraps values that violate non-type constraints (the target validates the rest)", () => {
      // The repair gates on the declared `type` only, never enum/const/items/
      // tuple/additionalProperties. The wrapper object is invalid against the
      // scalar/array type regardless, the inner value is the model's own, and the
      // target tool enforces the remaining constraints at dispatch — so unwrapping
      // an inner value that satisfies the type but breaks a non-type constraint is
      // safe and expected, matching the pre-existing allow-listed behavior.
      const schema = {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["dry_run"] },
          kind: { type: "string", const: "fixed" },
          rows: { type: "array", items: { type: "string", enum: ["open"] } },
          pair: {
            type: "array",
            items: [{ type: "string" }, { type: "number" }],
          },
          count: { type: "integer", minimum: 10 },
        },
      };
      const { repairedParams, toolArgs } =
        runToolInternals.repairEnvelopedToolArgs({
          toolArgs: {
            mode: { value: "delete" }, // not in enum
            kind: { k: "loose" }, // not the const
            rows: { items: ["deleted"] }, // item not in enum
            pair: { p: ["only-one"] }, // violates tuple shape
            count: { c: 3 }, // below minimum
          },
          schema,
        });

      expect(repairedParams.sort()).toEqual([
        "count",
        "kind",
        "mode",
        "pair",
        "rows",
      ]);
      expect(toolArgs).toEqual({
        mode: "delete",
        kind: "loose",
        rows: ["deleted"],
        pair: ["only-one"],
        count: 3,
      });
    });

    test("suppresses the repair note when the built-in call is denied by a gate, but keeps it when the call reaches validation", async ({
      seedAndAssignArchestraTools,
    }) => {
      // appendEnvelopeRepairNote adds exactly one extra content block, so the
      // note's presence is observable structurally (block count) without pinning
      // its wording: the wrapped call's content matches the equivalent bare call
      // when the note is suppressed, and has one extra block when it rides.
      const dispatch = (appId: unknown) =>
        executeArchestraTool(
          TOOL_RUN_TOOL_FULL_NAME,
          { tool_name: "edit_app", tool_args: { appId, baseVersion: 1 } },
          mockContext,
        );

      // Unassigned + no dynamic access → denial at the assignment gate, before
      // arg validation. The envelope repair fires on the wrapped appId, but the
      // note must not ride on the denial (it would disclose the param's declared
      // type to a caller who cannot reach the tool): wrapped == bare.
      const validUuid = crypto.randomUUID();
      const deniedWrapped = await dispatch({ value: validUuid });
      const deniedBare = await dispatch(validUuid);
      expect(deniedWrapped.isError).toBe(true);
      expect(deniedBare.isError).toBe(true);
      expect(deniedWrapped.content).toHaveLength(deniedBare.content.length);

      // Assigned but arg-invalid (appId is not a uuid after unwrap) → the call
      // reaches validation, which carries archestraValidation, so the note rides:
      // the wrapped call has exactly one more block than the bare one.
      await seedAndAssignArchestraTools(testAgent.id);
      const invalidWrapped = await dispatch({ value: "not-a-uuid" });
      const invalidBare = await dispatch("not-a-uuid");
      expect(invalidWrapped.isError).toBe(true);
      expect(invalidBare.isError).toBe(true);
      expect(invalidWrapped.content).toHaveLength(
        invalidBare.content.length + 1,
      );
    });
  });
});
