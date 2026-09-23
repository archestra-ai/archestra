import { TOOL_ASK_USER_SHORT_NAME } from "@archestra/shared";
import { beforeEach, vi } from "vitest";
import { archestraMcpBranding } from "@/archestra-mcp-server";
import config from "@/config";
import { ConversationEnabledToolModel } from "@/models";
import { describe, expect, test } from "@/test";

const mockGetChatMcpTools = vi.hoisted(() => vi.fn());
const mockGetChatMcpToolUiResourceUris = vi.hoisted(() => vi.fn());

vi.mock("@/clients/chat-mcp-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/clients/chat-mcp-client")>();
  return {
    ...actual,
    getChatMcpTools: mockGetChatMcpTools,
    getChatMcpToolUiResourceUris: mockGetChatMcpToolUiResourceUris,
  };
});

const { buildChatContext } = await import("./build-chat-context");

describe("buildChatContext", () => {
  beforeEach(() => {
    mockGetChatMcpTools.mockReset().mockResolvedValue({});
    mockGetChatMcpToolUiResourceUris.mockReset().mockResolvedValue({});
  });

  const run = (params: {
    conversationId: string;
    agentId: string;
    agentName: string;
    organizationId: string;
    user: { id: string; email: string; name: string };
    conversationOrigin?: "openappa";
  }) =>
    buildChatContext({
      conversationId: params.conversationId,
      conversationOrigin: params.conversationOrigin,
      agentId: params.agentId,
      agent: {
        name: params.agentName,
        systemPrompt: null,
        toolExposureMode: "full",
      },
      user: params.user,
      organizationId: params.organizationId,
      modelAcceptsImageToolResults: false,
      hookSessionContext: undefined,
      projectInstructions: undefined,
      openedApp: undefined,
      projectFileNames: undefined,
      hookRunCollector: [],
      kbChunksCollector: [],
      elicitation: {} as never,
      subagentToolStream: {} as never,
      taskBridge: {} as never,
      abortSignal: new AbortController().signal,
      suppressContentLogging: false,
      lockedChatAudit: null,
    });

  test("no custom selection fetches tools with enabledToolIds undefined", async ({
    makeAgent,
    makeConversation,
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });
    const conversation = await makeConversation(agent.id, {
      organizationId: org.id,
      userId: user.id,
    });

    const result = await run({
      conversationId: conversation.id,
      agentId: agent.id,
      agentName: agent.name,
      organizationId: org.id,
      user: { id: user.id, email: user.email, name: user.name },
    });

    // A new conversation has no custom selection, so it must NOT be filtered:
    // passing undefined (not []) is what keeps all assigned tools enabled.
    expect(mockGetChatMcpTools).toHaveBeenCalledTimes(1);
    expect(
      mockGetChatMcpTools.mock.calls[0]?.[0].enabledToolIds,
    ).toBeUndefined();
    expect(
      mockGetChatMcpTools.mock.calls[0]?.[0].modelAcceptsImageToolResults,
    ).toBe(false);
    expect(result.toolSelection).toEqual({
      hasCustomSelection: false,
      enabledToolCount: 0,
    });
  });

  test("empty custom selection fetches tools with an empty enabledToolIds array", async ({
    makeAgent,
    makeConversation,
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });
    const conversation = await makeConversation(agent.id, {
      organizationId: org.id,
      userId: user.id,
    });
    await ConversationEnabledToolModel.setEnabledTools(conversation.id, []);

    const result = await run({
      conversationId: conversation.id,
      agentId: agent.id,
      agentName: agent.name,
      organizationId: org.id,
      user: { id: user.id, email: user.email, name: user.name },
    });

    // An explicit empty selection passes [] (not undefined), and the surfaced
    // log fields report a custom selection of zero tools.
    expect(mockGetChatMcpTools.mock.calls[0]?.[0].enabledToolIds).toEqual([]);
    expect(result.toolSelection).toEqual({
      hasCustomSelection: true,
      enabledToolCount: 0,
    });
  });

  test("tells the model to offer choices through ask_user, which chat can show", async ({
    makeAgent,
    makeConversation,
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });
    const conversation = await makeConversation(agent.id, {
      organizationId: org.id,
      userId: user.id,
    });
    const askUser = archestraMcpBranding.getToolName(TOOL_ASK_USER_SHORT_NAME);
    mockGetChatMcpTools.mockResolvedValue({ [askUser]: {} });

    const result = await run({
      conversationId: conversation.id,
      agentId: agent.id,
      agentName: agent.name,
      organizationId: org.id,
      user: { id: user.id, email: user.email, name: user.name },
    });

    expect(result.systemPrompt).toContain(
      `When you ask the user a question, clarification, preference, or approval, call ${askUser}. Never ask multiple-choice questions or request user decisions in plain text.`,
    );
  });

  test("guides policy chats through the built-in skill and policy tools", async ({
    makeAgent,
    makeConversation,
    makeOrganization,
    makeUser,
  }) => {
    const originalEnabled = config.openappa.enabled;
    config.openappa.enabled = true;
    try {
      const org = await makeOrganization();
      const user = await makeUser();
      const agent = await makeAgent({ organizationId: org.id });
      const conversation = await makeConversation(agent.id, {
        organizationId: org.id,
        userId: user.id,
      });
      const common = {
        conversationId: conversation.id,
        agentId: agent.id,
        agentName: agent.name,
        organizationId: org.id,
        user: { id: user.id, email: user.email, name: user.name },
      };
      const policyTool = archestraMcpBranding.getToolName(
        "get_guardrails_policy",
      );
      const remedyTool = archestraMcpBranding.getToolName("get_remedy_plans");
      const appTool = archestraMcpBranding.getToolName("scaffold_app");
      mockGetChatMcpTools.mockResolvedValue({
        [policyTool]: {},
        [remedyTool]: {},
        [appTool]: {},
      });
      const policyChat = await run({
        ...common,
        conversationOrigin: "openappa",
      });
      const ordinaryChat = await run(common);
      expect(policyChat.systemPrompt).toContain("appa-guide");
      expect(policyChat.systemPrompt).toContain("preview proposed changes");
      expect(Object.keys(policyChat.mcpTools)).toEqual([
        policyTool,
        remedyTool,
      ]);
      expect(Object.keys(ordinaryChat.mcpTools)).toContain(appTool);
      expect(ordinaryChat.systemPrompt).not.toContain(
        "You are helping the user configure this deployment's OpenAPPA policy",
      );
    } finally {
      config.openappa.enabled = originalEnabled;
    }
  });
});
