// biome-ignore-all lint/suspicious/noExplicitAny: tests inspect MCP tool payloads dynamically
import {
  AGENT_TOOL_PREFIX,
  ARCHESTRA_MCP_CATALOG_ID,
  slugify,
  TOOL_INVOCATION_APPROVAL_REQUIRED_AUTONOMOUS_REASON,
  TOOL_RUN_COMMAND_FULL_NAME,
  TOOL_RUN_TOOL_FULL_NAME,
  TOOL_TODO_WRITE_FULL_NAME,
  TOOL_WHOAMI_FULL_NAME,
} from "@archestra/shared";
import { vi } from "vitest";
import mcpClient from "@/clients/mcp-client";
import config from "@/config";
import { ConversationEnabledToolModel, ToolModel } from "@/models";
import { skillSandboxRuntimeService } from "@/skills-sandbox/skill-sandbox-runtime-service";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "@/test";
import { type Agent, agentOwner } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";

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
    expect((result.content[0] as any).text).toContain(
      "run_tool cannot invoke itself",
    );
    expect(mcpClient.executeToolCallForOwner).not.toHaveBeenCalled();
  });

  test("prevents run_tool from invoking itself by short name", async () => {
    const result = await executeArchestraTool(
      TOOL_RUN_TOOL_FULL_NAME,
      { tool_name: "run_tool" },
      mockContext,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "run_tool cannot invoke itself",
    );
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
      makeTool,
    }) => {
      const catalog = await makeInternalMcpCatalog({
        organizationId: mockContext.organizationId,
      });
      await makeTool({
        name: "github__search_repositories",
        catalogId: catalog.id,
      });
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
      makeMember,
      makeOrganization,
      makeTool,
      makeToolPolicy,
      makeUser,
    }) => {
      // policies only evaluate outside permissive mode (evaluateBatch)
      const org = await makeOrganization({ globalToolPolicy: "restrictive" });
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

    beforeAll(() => {
      (config.skillsSandbox as { enabled: boolean }).enabled = true;
    });

    afterAll(() => {
      (config.skillsSandbox as { enabled: boolean }).enabled =
        originalSandboxEnabled;
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    // run_command is seeded into the (org-accessible) Archestra catalog but left
    // unassigned, so every test below exercises the dynamic path.
    beforeEach(async ({ makeAgent }) => {
      await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
      dynamicAgent = await makeAgent({
        name: "Dynamic Sandbox Agent",
        organizationId: mockContext.organizationId,
        accessAllTools: true,
      });
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
    const org = await makeOrganization({ globalToolPolicy: "restrictive" });
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
    const org = await makeOrganization({ globalToolPolicy: "restrictive" });
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
    const org = await makeOrganization({ globalToolPolicy: "restrictive" });
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
      // the full schema is echoed for self-correction
      expect(text).toContain('"required"');
      expect(text).toContain('"additionalProperties"');
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
      expect((result.content[0] as any).text).toContain(
        'unexpected parameter "bogus"',
      );
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
});
