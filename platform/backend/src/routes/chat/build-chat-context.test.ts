import { beforeEach, vi } from "vitest";
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

describe("buildChatContext enabled-tool selection", () => {
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
  }) =>
    buildChatContext({
      conversationId: params.conversationId,
      agentId: params.agentId,
      agent: {
        name: params.agentName,
        systemPrompt: null,
        toolExposureMode: "full",
      },
      user: params.user,
      organizationId: params.organizationId,
      hookSessionContext: undefined,
      projectInstructions: undefined,
      hookRunCollector: [],
      elicitation: {} as never,
      abortSignal: new AbortController().signal,
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
});
