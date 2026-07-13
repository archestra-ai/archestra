import { vi } from "vitest";

// Control the one-time mute-hint claim per test (the real one hits the
// distributed cache, which isn't started in this suite). The `mock`-prefixed
// name is referenced lazily inside the factory so it survives vi.mock hoisting.
const mockClaimThreadMuteHint = vi.fn();
// Drives the "was the thread muted mid-run?" check without a live distributed
// cache: defaults to null (no mute) so unrelated tests reply normally; the mute
// tests override it to simulate a marker moving while a run is in flight.
const mockGetThreadMuteMarker = vi.fn().mockResolvedValue(null);
vi.mock("./channel-activation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./channel-activation")>();
  return {
    ...actual,
    claimThreadMuteHint: (
      ...args: Parameters<typeof actual.claimThreadMuteHint>
    ) => mockClaimThreadMuteHint(...args),
    getThreadMuteMarker: (
      ...args: Parameters<typeof actual.getThreadMuteMarker>
    ) => mockGetThreadMuteMarker(...args),
  };
});

import { ChatErrorCode, ChatErrorMessages } from "@archestra/shared";
import { eq } from "drizzle-orm";
import { A2AManager } from "@/agents/a2a/a2a-manager";
import * as a2aExecutor from "@/agents/a2a-executor";
import db, { schema } from "@/database";
import {
  AgentTeamModel,
  ChatOpsChannelBindingModel,
  ChatOpsConfigModel,
  ChatOpsThreadAgentOverrideModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
} from "@/models";
import { ProviderError } from "@/routes/chat/errors";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type {
  ChatOpsApprovalDecision,
  ChatOpsProvider,
  ChatReplyOptions,
  ChatThreadMessage,
  IncomingChatMessage,
  SkippedAttachment,
} from "@/types";
import { LlmProviderAuthRequiredError } from "@/utils/llm-provider-auth-error";
import {
  buildChatOpsSessionId,
  ChatOpsManager,
  matchesAgentName,
} from "./chatops-manager";
import { chatOpsRunRegistry } from "./chatops-run-registry";
import {
  CHATOPS_ATTACHMENT_LIMITS,
  CHATOPS_NO_REPLY_SENTINEL,
  THREAD_MUTE_HINT,
} from "./constants";
import { buildHistorySkippedAttachmentsNote } from "./utils";

describe("matchesAgentName", () => {
  test("matches exact name", () => {
    expect(matchesAgentName("Sales", "Sales")).toBe(true);
  });

  test("matches case-insensitively", () => {
    expect(matchesAgentName("sales", "Sales")).toBe(true);
    expect(matchesAgentName("SALES", "Sales")).toBe(true);
  });

  test("matches ignoring spaces in input", () => {
    expect(matchesAgentName("AgentPeter", "Agent Peter")).toBe(true);
    expect(matchesAgentName("agentpeter", "Agent Peter")).toBe(true);
  });

  test("matches with extra spaces in input", () => {
    expect(matchesAgentName("Agent  Peter", "Agent Peter")).toBe(true);
  });

  test("returns false for partial match", () => {
    expect(matchesAgentName("Agent", "Agent Peter")).toBe(false);
  });

  test("returns false for different name", () => {
    expect(matchesAgentName("Support", "Sales")).toBe(false);
  });

  test("returns false when input has extra characters", () => {
    expect(matchesAgentName("SalesTeam", "Sales")).toBe(false);
  });
});

describe("ChatOpsManager security validation", () => {
  /**
   * Creates a mock ChatOpsProvider for testing
   */
  function createMockProvider(
    overrides: {
      getUserEmail?: (userId: string) => Promise<string | null>;
      sendReply?: (options: ChatReplyOptions) => Promise<string>;
      hasMissingScopes?: () => boolean;
      notifyMissingScopes?: (message: IncomingChatMessage) => Promise<void>;
      clearTypingStatus?: (
        channelId: string,
        threadTs: string,
      ) => Promise<void>;
    } = {},
  ): ChatOpsProvider {
    return {
      providerId: "ms-teams",
      displayName: "Microsoft Teams",
      isConfigured: () => true,
      initialize: async () => {},
      cleanup: async () => {},
      validateWebhookRequest: async () => true,
      handleValidationChallenge: () => null,
      parseWebhookNotification: async () => null,
      sendReply: overrides.sendReply ?? (async () => "reply-id"),
      parseInteractivePayload: () => null,
      sendAgentSelectionCard: async () => {},
      getThreadHistory: async () => [],
      getUserEmail: overrides.getUserEmail ?? (async () => null),
      getChannelName: async () => null,
      getWorkspaceId: () => null,
      getWorkspaceName: () => null,
      hasMissingScopes: overrides.hasMissingScopes ?? (() => false),
      notifyMissingScopes: overrides.notifyMissingScopes ?? (async () => {}),
      downloadFiles: async () => [],
      discoverChannels: async () => null,
      addApprovalRequestForm: async () => {},
      updateApprovalRequest: async () => {},
      ...(overrides.clearTypingStatus && {
        clearTypingStatus: overrides.clearTypingStatus,
      }),
    };
  }

  /**
   * Mock the A2A executor for a test
   */
  function mockA2AExecutor() {
    return vi.spyOn(a2aExecutor, "executeA2AMessage").mockResolvedValue({
      text: "Agent response",
      messageId: "test-message-id",
      finishReason: "stop",
      responseUiMessage: {
        id: "test-message-id",
        role: "assistant",
        parts: [{ type: "text", text: "Agent response" }],
      },
    });
  }

  /**
   * Creates a mock IncomingChatMessage for testing
   */
  function createMockMessage(
    overrides: Partial<IncomingChatMessage> = {},
  ): IncomingChatMessage {
    return {
      messageId: "test-message-id",
      channelId: "test-channel-id",
      workspaceId: "test-workspace-id",
      senderId: "test-sender-aad-id",
      senderName: "Test User",
      text: "Hello agent",
      rawText: "@Bot Hello agent",
      timestamp: new Date(),
      isThreadReply: false,
      ...overrides,
    };
  }

  // ===========================================================================
  // Frictionless onboarding: a channel with no agent yet should auto-assign a
  // clear default (org default, or the sole agent) instead of silently dropping.
  // ===========================================================================

  function makeManagerWith(provider: ChatOpsProvider): ChatOpsManager {
    const manager = new ChatOpsManager();
    (
      manager as unknown as { msTeamsProvider: ChatOpsProvider }
    ).msTeamsProvider = provider;
    return manager;
  }

  async function unboundChannelBinding(organizationId: string) {
    return ChatOpsChannelBindingModel.create({
      organizationId,
      provider: "ms-teams",
      channelId: "test-channel-id",
      workspaceId: "test-workspace-id",
    });
  }

  function refetchBinding() {
    return ChatOpsChannelBindingModel.findByChannel({
      provider: "ms-teams",
      channelId: "test-channel-id",
      workspaceId: "test-workspace-id",
    });
  }

  test("auto-assigns the sole agent when a channel has no agent yet", async ({
    makeOrganization,
    makeInternalAgent,
  }) => {
    mockA2AExecutor();
    const org = await makeOrganization();
    const agent = await makeInternalAgent({ organizationId: org.id });
    await unboundChannelBinding(org.id);

    const provider = createMockProvider();
    await makeManagerWith(provider).processMessage({
      message: createMockMessage(),
      provider,
    });

    expect((await refetchBinding())?.agentId).toBe(agent.id);
  });

  test("auto-assigns the org-wide default agent over other candidates", async ({
    makeOrganization,
    makeInternalAgent,
  }) => {
    mockA2AExecutor();
    const org = await makeOrganization();
    const preferred = await makeInternalAgent({ organizationId: org.id });
    await makeInternalAgent({ organizationId: org.id }); // a second, non-default
    await db
      .update(schema.organizationsTable)
      .set({ defaultAgentId: preferred.id })
      .where(eq(schema.organizationsTable.id, org.id));
    await unboundChannelBinding(org.id);

    const provider = createMockProvider();
    await makeManagerWith(provider).processMessage({
      message: createMockMessage(),
      provider,
    });

    expect((await refetchBinding())?.agentId).toBe(preferred.id);
  });

  test("prompts with the picker (no auto-assign) when multiple agents and no default", async ({
    makeOrganization,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    await makeInternalAgent({ organizationId: org.id });
    await makeInternalAgent({ organizationId: org.id });
    await unboundChannelBinding(org.id);

    const cardSpy = vi.fn().mockResolvedValue(undefined);
    const provider = createMockProvider();
    provider.sendAgentSelectionCard = cardSpy;

    const result = await makeManagerWith(provider).processMessage({
      message: createMockMessage(),
      provider,
    });

    expect(cardSpy).toHaveBeenCalled();
    expect((await refetchBinding())?.agentId).toBeNull();
    // Handled via the card — not a silent drop.
    expect(result.success).toBe(true);
  });

  test("uses the sender's lone personal agent, without pinning it to the channel", async ({
    makeOrganization,
    makeUser,
    makeInternalAgent,
  }) => {
    mockA2AExecutor();
    const org = await makeOrganization();
    const user = await makeUser({ email: "joey@example.com" });
    await makeInternalAgent({
      organizationId: org.id,
      scope: "personal",
      authorId: user.id,
    });
    await unboundChannelBinding(org.id);

    const sendReplySpy = vi.fn().mockResolvedValue("reply-id");
    const provider = createMockProvider({
      getUserEmail: async () => "joey@example.com",
      sendReply: sendReplySpy,
    });

    const result = await makeManagerWith(provider).processMessage({
      message: createMockMessage({ senderEmail: "joey@example.com" }),
      provider,
    });

    // The sender's personal agent handled the message...
    expect(result.success).toBe(true);
    // ...but a personal agent must NOT be pinned as the shared channel default
    // (other members would be denied access to it).
    expect((await refetchBinding())?.agentId).toBeNull();
  });

  test("successful authorization - user exists and has team access", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeInternalAgent,
  }) => {
    mockA2AExecutor();

    // Setup: Create user, org, team, agent with team access
    const user = await makeUser({ email: "authorized@example.com" });
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    await makeTeamMember(team.id, user.id);
    const agent = await makeInternalAgent({
      organizationId: org.id,
      teams: [team.id],
    });
    await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);

    // Create channel binding
    await ChatOpsChannelBindingModel.create({
      organizationId: org.id,
      provider: "ms-teams",
      channelId: "test-channel-id",
      workspaceId: "test-workspace-id",
      agentId: agent.id,
    });

    // Create mock provider that returns the user's email
    const sendReplySpy = vi.fn().mockResolvedValue("reply-id");
    const mockProvider = createMockProvider({
      getUserEmail: async () => "authorized@example.com",
      sendReply: sendReplySpy,
    });

    const manager = new ChatOpsManager();
    // Inject the mock provider
    (
      manager as unknown as { msTeamsProvider: ChatOpsProvider }
    ).msTeamsProvider = mockProvider;

    const message = createMockMessage();
    const result = await manager.processMessage({
      message,
      provider: mockProvider,
    });

    expect(result.success).toBe(true);
    expect(result.agentResponse).toBe("Agent response");
    // Security error reply should NOT have been called
    expect(sendReplySpy).not.toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Access Denied"),
      }),
    );
  });

  test("per-user provider not connected - replies with a connect link", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeInternalAgent,
  }) => {
    vi.spyOn(a2aExecutor, "executeA2AMessage").mockRejectedValue(
      new LlmProviderAuthRequiredError("github-copilot"),
    );

    const user = await makeUser({ email: "copilot@example.com" });
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    await makeTeamMember(team.id, user.id);
    const agent = await makeInternalAgent({
      organizationId: org.id,
      teams: [team.id],
    });
    await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);

    await ChatOpsChannelBindingModel.create({
      organizationId: org.id,
      provider: "ms-teams",
      channelId: "test-channel-id",
      workspaceId: "test-workspace-id",
      agentId: agent.id,
    });

    const sendReplySpy = vi.fn().mockResolvedValue("reply-id");
    const mockProvider = createMockProvider({
      getUserEmail: async () => "copilot@example.com",
      sendReply: sendReplySpy,
    });

    const manager = new ChatOpsManager();
    (
      manager as unknown as { msTeamsProvider: ChatOpsProvider }
    ).msTeamsProvider = mockProvider;

    const result = await manager.processMessage({
      message: createMockMessage(),
      provider: mockProvider,
    });

    expect(result.success).toBe(false);
    // The reply names the provider and links the user to connect their account.
    expect(sendReplySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("GitHub Copilot"),
      }),
    );
    expect(sendReplySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("/settings"),
      }),
    );
    // Even the connect-prompt reply carries the agent footer.
    expect(sendReplySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        footer: `🤖 ${agent.name}`,
      }),
    );
  });

  // ===========================================================================
  // Transient provider failure auto-retry: web chat renders a retry button for
  // retryable provider errors; chatops has no interactive affordance, so
  // executeAndReply re-runs the turn once automatically before giving up.
  // ===========================================================================

  describe("transient provider failure auto-retry", () => {
    const transientProviderError = () =>
      new ProviderError({
        code: ChatErrorCode.EmptyResponse,
        message: ChatErrorMessages[ChatErrorCode.EmptyResponse],
        isRetryable: true,
      });

    const successfulExecution = () => ({
      text: "Agent response",
      messageId: "test-message-id",
      finishReason: "stop",
      responseUiMessage: {
        id: "test-message-id",
        role: "assistant" as const,
        parts: [{ type: "text" as const, text: "Agent response" }],
      },
    });

    async function setupBoundAgent(fx: {
      makeUser: (overrides?: { email: string }) => Promise<{ id: string }>;
      makeOrganization: () => Promise<{ id: string }>;
      makeTeam: (orgId: string, userId: string) => Promise<{ id: string }>;
      makeTeamMember: (teamId: string, userId: string) => Promise<unknown>;
      makeInternalAgent: (overrides: {
        organizationId: string;
        teams: string[];
      }) => Promise<{ id: string; name: string }>;
    }) {
      const user = await fx.makeUser({ email: "retry@example.com" });
      const org = await fx.makeOrganization();
      const team = await fx.makeTeam(org.id, user.id);
      await fx.makeTeamMember(team.id, user.id);
      const agent = await fx.makeInternalAgent({
        organizationId: org.id,
        teams: [team.id],
      });
      await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);
      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        provider: "ms-teams",
        channelId: "test-channel-id",
        workspaceId: "test-workspace-id",
        agentId: agent.id,
      });

      const sendReplySpy = vi.fn().mockResolvedValue("reply-id");
      const mockProvider = createMockProvider({
        getUserEmail: async () => "retry@example.com",
        sendReply: sendReplySpy,
      });
      return {
        manager: makeManagerWith(mockProvider),
        mockProvider,
        sendReplySpy,
      };
    }

    test("retries once and recovers from a transient provider failure", async ({
      makeUser,
      makeOrganization,
      makeTeam,
      makeTeamMember,
      makeInternalAgent,
    }) => {
      const executeSpy = vi
        .spyOn(a2aExecutor, "executeA2AMessage")
        .mockRejectedValueOnce(transientProviderError())
        .mockResolvedValueOnce(successfulExecution());

      const { manager, mockProvider, sendReplySpy } = await setupBoundAgent({
        makeUser,
        makeOrganization,
        makeTeam,
        makeTeamMember,
        makeInternalAgent,
      });

      const result = await manager.processMessage({
        message: createMockMessage(),
        provider: mockProvider,
      });

      expect(result.success).toBe(true);
      expect(result.agentResponse).toBe("Agent response");
      expect(executeSpy).toHaveBeenCalledTimes(2);
      // No error reply reached the channel — only the successful answer.
      expect(sendReplySpy).not.toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Sorry, I encountered an error"),
        }),
      );
    });

    test("gives up after a single retry and replies with the error", async ({
      makeUser,
      makeOrganization,
      makeTeam,
      makeTeamMember,
      makeInternalAgent,
    }) => {
      const executeSpy = vi
        .spyOn(a2aExecutor, "executeA2AMessage")
        .mockRejectedValue(transientProviderError());

      const { manager, mockProvider, sendReplySpy } = await setupBoundAgent({
        makeUser,
        makeOrganization,
        makeTeam,
        makeTeamMember,
        makeInternalAgent,
      });

      const result = await manager.processMessage({
        message: createMockMessage(),
        provider: mockProvider,
      });

      expect(result.success).toBe(false);
      expect(executeSpy).toHaveBeenCalledTimes(2);
      expect(sendReplySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Sorry, I encountered an error"),
        }),
      );
    });

    test("does not retry a non-retryable provider failure", async ({
      makeUser,
      makeOrganization,
      makeTeam,
      makeTeamMember,
      makeInternalAgent,
    }) => {
      const executeSpy = vi
        .spyOn(a2aExecutor, "executeA2AMessage")
        .mockRejectedValue(
          new ProviderError({
            code: ChatErrorCode.InvalidRequest,
            message: ChatErrorMessages[ChatErrorCode.InvalidRequest],
            isRetryable: false,
          }),
        );

      const { manager, mockProvider, sendReplySpy } = await setupBoundAgent({
        makeUser,
        makeOrganization,
        makeTeam,
        makeTeamMember,
        makeInternalAgent,
      });

      const result = await manager.processMessage({
        message: createMockMessage(),
        provider: mockProvider,
      });

      expect(result.success).toBe(false);
      expect(executeSpy).toHaveBeenCalledTimes(1);
      expect(sendReplySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Sorry, I encountered an error"),
        }),
      );
    });
  });

  // ===========================================================================
  // Muting a thread cancels its in-flight runs: a message already being
  // processed when the user mutes must NOT post its (now-unwanted) answer.
  // ===========================================================================

  describe("mute cancels an in-flight run", () => {
    beforeEach(() => {
      // Default: no mute during the run. Individual tests override per call.
      mockGetThreadMuteMarker.mockReset().mockResolvedValue(null);
    });

    const agentResult = () => ({
      text: "Agent response",
      messageId: "test-message-id",
      finishReason: "stop",
      responseUiMessage: {
        id: "test-message-id",
        role: "assistant" as const,
        parts: [{ type: "text" as const, text: "Agent response" }],
      },
    });

    async function setupBoundAgent(fx: {
      makeUser: (overrides?: { email: string }) => Promise<{ id: string }>;
      makeOrganization: () => Promise<{ id: string }>;
      makeTeam: (orgId: string, userId: string) => Promise<{ id: string }>;
      makeTeamMember: (teamId: string, userId: string) => Promise<unknown>;
      makeInternalAgent: (overrides: {
        organizationId: string;
        teams: string[];
      }) => Promise<{ id: string; name: string }>;
    }) {
      const user = await fx.makeUser({ email: "mute@example.com" });
      const org = await fx.makeOrganization();
      const team = await fx.makeTeam(org.id, user.id);
      await fx.makeTeamMember(team.id, user.id);
      const agent = await fx.makeInternalAgent({
        organizationId: org.id,
        teams: [team.id],
      });
      await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);
      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        provider: "ms-teams",
        channelId: "test-channel-id",
        workspaceId: "test-workspace-id",
        agentId: agent.id,
      });

      const sendReplySpy = vi.fn().mockResolvedValue("reply-id");
      const mockProvider = createMockProvider({
        getUserEmail: async () => "mute@example.com",
        sendReply: sendReplySpy,
      });
      return {
        manager: makeManagerWith(mockProvider),
        mockProvider,
        sendReplySpy,
      };
    }

    // createMockMessage has no threadId, so the run is keyed on the channel id.
    const threadKey = {
      provider: "ms-teams",
      channelId: "test-channel-id",
      threadId: "test-channel-id",
    } as const;

    test("drops the reply when the thread is muted while the run is in flight (cross-pod marker moved)", async ({
      makeUser,
      makeOrganization,
      makeTeam,
      makeTeamMember,
      makeInternalAgent,
    }) => {
      vi.spyOn(a2aExecutor, "executeA2AMessage").mockResolvedValue(
        agentResult(),
      );
      // The run starts with no mute marker, but by the time it goes to reply the
      // marker has moved — a mute landed mid-run (here, on another pod).
      mockGetThreadMuteMarker
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce("muted-token");

      const { manager, mockProvider, sendReplySpy } = await setupBoundAgent({
        makeUser,
        makeOrganization,
        makeTeam,
        makeTeamMember,
        makeInternalAgent,
      });

      const result = await manager.processMessage({
        message: createMockMessage(),
        provider: mockProvider,
      });

      // Reported as a deliberate no-reply, and nothing was posted to the thread.
      expect(result.success).toBe(true);
      expect(result.agentResponse).toBe("");
      expect(sendReplySpy).not.toHaveBeenCalled();
    });

    test("aborts the run and stays silent when the thread is muted on this pod", async ({
      makeUser,
      makeOrganization,
      makeTeam,
      makeTeamMember,
      makeInternalAgent,
    }) => {
      // Simulate the mute landing on this pod mid-run: abort the registered run
      // (as muteChannelThread → chatOpsRunRegistry.cancelThread would) while the
      // model call is "executing", then let it resolve.
      const executeSpy = vi
        .spyOn(a2aExecutor, "executeA2AMessage")
        .mockImplementation(async () => {
          chatOpsRunRegistry.cancelThread(threadKey);
          return agentResult();
        });

      const { manager, mockProvider, sendReplySpy } = await setupBoundAgent({
        makeUser,
        makeOrganization,
        makeTeam,
        makeTeamMember,
        makeInternalAgent,
      });

      const result = await manager.processMessage({
        message: createMockMessage(),
        provider: mockProvider,
      });

      expect(executeSpy).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
      expect(result.agentResponse).toBe("");
      // Neither the answer nor an "aborted" error reaches the muted thread.
      expect(sendReplySpy).not.toHaveBeenCalled();
    });

    test("stays silent when the mute aborts the run during the auto-retry leg", async ({
      makeUser,
      makeOrganization,
      makeTeam,
      makeTeamMember,
      makeInternalAgent,
    }) => {
      // First attempt fails transiently (triggering the one auto-retry); the
      // mute then lands during the retry and aborts it. The abort must not be
      // posted as an error reply.
      const executeSpy = vi
        .spyOn(a2aExecutor, "executeA2AMessage")
        .mockRejectedValueOnce(
          new ProviderError({
            code: ChatErrorCode.EmptyResponse,
            message: ChatErrorMessages[ChatErrorCode.EmptyResponse],
            isRetryable: true,
          }),
        )
        .mockImplementationOnce(async () => {
          chatOpsRunRegistry.cancelThread(threadKey);
          throw new Error("aborted");
        });

      const { manager, mockProvider, sendReplySpy } = await setupBoundAgent({
        makeUser,
        makeOrganization,
        makeTeam,
        makeTeamMember,
        makeInternalAgent,
      });

      const result = await manager.processMessage({
        message: createMockMessage(),
        provider: mockProvider,
      });

      expect(executeSpy).toHaveBeenCalledTimes(2);
      expect(result.success).toBe(true);
      expect(result.agentResponse).toBe("");
      expect(sendReplySpy).not.toHaveBeenCalled();
    });

    test("replies normally when no mute occurs during the run", async ({
      makeUser,
      makeOrganization,
      makeTeam,
      makeTeamMember,
      makeInternalAgent,
    }) => {
      vi.spyOn(a2aExecutor, "executeA2AMessage").mockResolvedValue(
        agentResult(),
      );

      const { manager, mockProvider, sendReplySpy } = await setupBoundAgent({
        makeUser,
        makeOrganization,
        makeTeam,
        makeTeamMember,
        makeInternalAgent,
      });

      const result = await manager.processMessage({
        message: createMockMessage(),
        provider: mockProvider,
      });

      expect(result.success).toBe(true);
      expect(result.agentResponse).toBe("Agent response");
      expect(sendReplySpy).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Agent response" }),
      );
    });
  });

  test("LLM provider rejected the API key - names the key/model used and links to model providers", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeInternalAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    // Anthropic's 401 body surfaces verbatim as the thrown error's message.
    vi.spyOn(a2aExecutor, "executeA2AMessage").mockRejectedValue(
      new Error("invalid x-api-key"),
    );

    const user = await makeUser({ email: "badkey@example.com" });
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    await makeTeamMember(team.id, user.id);

    // Pin the agent to a concrete (model, key) pair so the resolution the
    // error reply re-runs lands on exactly this key.
    const secret = await makeSecret({ secret: { apiKey: "sk-revoked" } });
    const apiKey = await makeLlmProviderApiKey(org.id, secret.id, {
      name: "Work Anthropic",
      provider: "anthropic",
      scope: "org",
    });
    const model = await ModelModel.create({
      externalId: "anthropic/claude-test-model",
      provider: "anthropic",
      modelId: "claude-test-model",
      contextLength: 200000,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      lastSyncedAt: new Date(),
    });
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(apiKey.id, [
      model.id,
    ]);

    const agent = await makeInternalAgent({
      organizationId: org.id,
      teams: [team.id],
      llmApiKeyId: apiKey.id,
      modelId: model.id,
    });
    await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);

    await ChatOpsChannelBindingModel.create({
      organizationId: org.id,
      provider: "ms-teams",
      channelId: "test-channel-id",
      workspaceId: "test-workspace-id",
      agentId: agent.id,
    });

    const sendReplySpy = vi.fn().mockResolvedValue("reply-id");
    const mockProvider = createMockProvider({
      getUserEmail: async () => "badkey@example.com",
      sendReply: sendReplySpy,
    });

    const manager = new ChatOpsManager();
    (
      manager as unknown as { msTeamsProvider: ChatOpsProvider }
    ).msTeamsProvider = mockProvider;

    const result = await manager.processMessage({
      message: createMockMessage(),
      provider: mockProvider,
    });

    expect(result.success).toBe(false);
    // The reply names the exact key and model the failed run used, and the
    // footer leads with the agent identity and trails the raw provider error.
    expect(sendReplySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(
          'organization-wide Anthropic API key "Work Anthropic"',
        ),
        footer: `🤖 ${agent.name} · invalid x-api-key`,
      }),
    );
    expect(sendReplySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("claude-test-model"),
      }),
    );
    // It points the user at where to fix the key.
    expect(sendReplySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("/llm/model-providers"),
      }),
    );
  });

  test("non-auth execution errors keep the generic reply with the raw error footer", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeInternalAgent,
  }) => {
    vi.spyOn(a2aExecutor, "executeA2AMessage").mockRejectedValue(
      new Error("upstream exploded"),
    );

    const user = await makeUser({ email: "boom@example.com" });
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    await makeTeamMember(team.id, user.id);
    const agent = await makeInternalAgent({
      organizationId: org.id,
      teams: [team.id],
    });
    await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);

    await ChatOpsChannelBindingModel.create({
      organizationId: org.id,
      provider: "ms-teams",
      channelId: "test-channel-id",
      workspaceId: "test-workspace-id",
      agentId: agent.id,
    });

    const sendReplySpy = vi.fn().mockResolvedValue("reply-id");
    const mockProvider = createMockProvider({
      getUserEmail: async () => "boom@example.com",
      sendReply: sendReplySpy,
    });

    const manager = new ChatOpsManager();
    (
      manager as unknown as { msTeamsProvider: ChatOpsProvider }
    ).msTeamsProvider = mockProvider;

    const result = await manager.processMessage({
      message: createMockMessage(),
      provider: mockProvider,
    });

    expect(result.success).toBe(false);
    expect(sendReplySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Sorry, I encountered an error processing your request.",
        footer: `🤖 ${agent.name} · upstream exploded`,
      }),
    );
  });

  // ===========================================================================
  // One-time "you can mute me" hint: rides the bot's first reply in a channel
  // thread (where sticky auto-reply applies), and nowhere else.
  // ===========================================================================

  // A channel whose sender is a known, authorized team member, so replies
  // reach the agent-response path (where the hint lives) rather than an
  // access-denied/onboarding branch.
  async function bindAuthorizedChannel(ctx: {
    makeOrganization: (...args: never[]) => Promise<{ id: string }>;
    makeUser: (opts: { email: string }) => Promise<{ id: string }>;
    makeTeam: (orgId: string, userId: string) => Promise<{ id: string }>;
    makeTeamMember: (teamId: string, userId: string) => Promise<unknown>;
    makeInternalAgent: (opts: {
      organizationId: string;
      teams: string[];
    }) => Promise<{ id: string }>;
  }): Promise<{ senderEmail: string }> {
    const senderEmail = "member@example.com";
    const org = await ctx.makeOrganization();
    const user = await ctx.makeUser({ email: senderEmail });
    const team = await ctx.makeTeam(org.id, user.id);
    await ctx.makeTeamMember(team.id, user.id);
    const agent = await ctx.makeInternalAgent({
      organizationId: org.id,
      teams: [team.id],
    });
    await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);
    await ChatOpsChannelBindingModel.create({
      organizationId: org.id,
      provider: "ms-teams",
      channelId: "test-channel-id",
      workspaceId: "test-workspace-id",
      agentId: agent.id,
    });
    return { senderEmail };
  }

  async function processChannelReply(params: {
    message: IncomingChatMessage;
    senderEmail: string;
  }): Promise<ReturnType<typeof vi.fn>> {
    mockA2AExecutor();
    const sendReplySpy = vi.fn().mockResolvedValue("reply-id");
    const provider = createMockProvider({
      sendReply: sendReplySpy,
      getUserEmail: async () => params.senderEmail,
    });
    const manager = new ChatOpsManager();
    (
      manager as unknown as { msTeamsProvider: ChatOpsProvider }
    ).msTeamsProvider = provider;
    await manager.processMessage({ message: params.message, provider });
    return sendReplySpy;
  }

  test("rides the bot's first reply in a channel thread", async ({
    makeOrganization,
    makeUser,
    makeTeam,
    makeTeamMember,
    makeInternalAgent,
  }) => {
    const { senderEmail } = await bindAuthorizedChannel({
      makeOrganization,
      makeUser,
      makeTeam,
      makeTeamMember,
      makeInternalAgent,
    });
    mockClaimThreadMuteHint.mockReset().mockResolvedValue(true);

    const sendReplySpy = await processChannelReply({
      senderEmail,
      message: createMockMessage({
        threadId: "thread-1",
        senderEmail,
        metadata: { conversationType: "channel", botMentioned: true },
      }),
    });

    expect(mockClaimThreadMuteHint).toHaveBeenCalledWith({
      provider: "ms-teams",
      channelId: "test-channel-id",
      threadId: "thread-1",
    });
    expect(sendReplySpy).toHaveBeenCalledWith(
      expect.objectContaining({ hint: THREAD_MUTE_HINT }),
    );
  });

  test("omits the hint on later replies once the thread's slot is claimed", async ({
    makeOrganization,
    makeUser,
    makeTeam,
    makeTeamMember,
    makeInternalAgent,
  }) => {
    const { senderEmail } = await bindAuthorizedChannel({
      makeOrganization,
      makeUser,
      makeTeam,
      makeTeamMember,
      makeInternalAgent,
    });
    // Slot already taken → claim returns false.
    mockClaimThreadMuteHint.mockReset().mockResolvedValue(false);

    const sendReplySpy = await processChannelReply({
      senderEmail,
      message: createMockMessage({
        threadId: "thread-1",
        senderEmail,
        metadata: { conversationType: "channel", botMentioned: false },
      }),
    });

    expect(mockClaimThreadMuteHint).toHaveBeenCalled();
    expect(sendReplySpy.mock.calls[0][0].hint).toBeUndefined();
  });

  test("never hints outside a channel thread (DMs/group chats have no sticky auto-reply)", async ({
    makeOrganization,
    makeUser,
    makeTeam,
    makeTeamMember,
    makeInternalAgent,
  }) => {
    const { senderEmail } = await bindAuthorizedChannel({
      makeOrganization,
      makeUser,
      makeTeam,
      makeTeamMember,
      makeInternalAgent,
    });
    mockClaimThreadMuteHint.mockReset().mockResolvedValue(true);

    const sendReplySpy = await processChannelReply({
      senderEmail,
      message: createMockMessage({
        threadId: "thread-1",
        senderEmail,
        metadata: { conversationType: "groupChat", botMentioned: true },
      }),
    });

    // Gated out before the cache is even consulted.
    expect(mockClaimThreadMuteHint).not.toHaveBeenCalled();
    expect(sendReplySpy.mock.calls[0][0].hint).toBeUndefined();
  });

  test("suppresses the reply when the agent answers with the no-reply sentinel", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeInternalAgent,
  }) => {
    vi.spyOn(a2aExecutor, "executeA2AMessage").mockResolvedValue({
      text: CHATOPS_NO_REPLY_SENTINEL,
      messageId: "test-message-id",
      finishReason: "stop",
      responseUiMessage: {
        id: "test-message-id",
        role: "assistant",
        parts: [{ type: "text", text: CHATOPS_NO_REPLY_SENTINEL }],
      },
    });

    const user = await makeUser({ email: "silent@example.com" });
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    await makeTeamMember(team.id, user.id);
    const agent = await makeInternalAgent({
      organizationId: org.id,
      teams: [team.id],
    });
    await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);
    await ChatOpsChannelBindingModel.create({
      organizationId: org.id,
      provider: "ms-teams",
      channelId: "test-channel-id",
      workspaceId: "test-workspace-id",
      agentId: agent.id,
    });

    const sendReplySpy = vi.fn().mockResolvedValue("reply-id");
    const clearTypingStatusSpy = vi.fn().mockResolvedValue(undefined);
    const mockProvider = createMockProvider({
      getUserEmail: async () => "silent@example.com",
      sendReply: sendReplySpy,
      clearTypingStatus: clearTypingStatusSpy,
    });
    const manager = new ChatOpsManager();
    (
      manager as unknown as { msTeamsProvider: ChatOpsProvider }
    ).msTeamsProvider = mockProvider;

    const result = await manager.processMessage({
      message: createMockMessage(),
      provider: mockProvider,
    });

    expect(result.success).toBe(true);
    expect(sendReplySpy).not.toHaveBeenCalled();
    // Without posting anything, the transient "thinking" indicator must be
    // cleared explicitly or it spins forever (Slack assistant status).
    expect(clearTypingStatusSpy).toHaveBeenCalled();

    // Models often narrate the decision around the sentinel — the narration
    // must be swallowed too, not posted as a visible reply.
    const narrated = `This message is addressed to Matvey, not me, so I'll stay out of it.\n\n${CHATOPS_NO_REPLY_SENTINEL}`;
    vi.spyOn(a2aExecutor, "executeA2AMessage").mockResolvedValue({
      text: narrated,
      messageId: "narrated-message-id",
      finishReason: "stop",
      responseUiMessage: {
        id: "narrated-message-id",
        role: "assistant",
        parts: [{ type: "text", text: narrated }],
      },
    });

    const narratedResult = await manager.processMessage({
      message: createMockMessage({ messageId: "narrated-incoming-id" }),
      provider: mockProvider,
    });

    expect(narratedResult.success).toBe(true);
    expect(sendReplySpy).not.toHaveBeenCalled();
  });

  test("frames group conversations with speaker, mention state, and the no-reply sentinel", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeInternalAgent,
  }) => {
    const executeSpy = mockA2AExecutor();

    const user = await makeUser({ email: "group@example.com" });
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    await makeTeamMember(team.id, user.id);
    const agent = await makeInternalAgent({
      organizationId: org.id,
      teams: [team.id],
    });
    await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);
    await ChatOpsChannelBindingModel.create({
      organizationId: org.id,
      provider: "ms-teams",
      channelId: "test-channel-id",
      workspaceId: "test-workspace-id",
      agentId: agent.id,
    });

    const mockProvider = createMockProvider({
      getUserEmail: async () => "group@example.com",
    });
    const manager = new ChatOpsManager();
    (
      manager as unknown as { msTeamsProvider: ChatOpsProvider }
    ).msTeamsProvider = mockProvider;

    await manager.processMessage({
      message: createMockMessage({
        metadata: { conversationType: "groupChat", botMentioned: false },
      }),
      provider: mockProvider,
    });

    const groupCall = JSON.stringify(executeSpy.mock.calls[0]);
    expect(groupCall).toContain("group conversation with multiple people");
    expect(groupCall).toContain("Test User");
    // The platform name is a known alias — people address the bot by it
    expect(groupCall).toContain(`address you as \\"Archestra\\"`);
    // A missing mention is never asserted negatively — users often address
    // the bot by name without a real @mention.
    expect(groupCall).not.toContain("@mentions you directly");
    expect(groupCall).toContain(CHATOPS_NO_REPLY_SENTINEL);

    // A message @mentioning someone else is flagged as addressed to them
    await manager.processMessage({
      message: createMockMessage({
        messageId: "other-mention-message-id",
        metadata: {
          conversationType: "groupChat",
          botMentioned: false,
          mentionedOthers: ["Innokentii Konstantinov"],
        },
      }),
      provider: mockProvider,
    });

    const otherMentionCall = JSON.stringify(executeSpy.mock.calls[1]);
    expect(otherMentionCall).toContain(
      "It @mentions Innokentii Konstantinov — another person, not you",
    );

    // A direct @mention never gets the silence option — always answer,
    // even when the message is small talk outside the agent's specialty.
    await manager.processMessage({
      message: createMockMessage({
        messageId: "direct-mention-message-id",
        metadata: { conversationType: "channel", botMentioned: true },
      }),
      provider: mockProvider,
    });

    const directMentionCall = JSON.stringify(executeSpy.mock.calls[2]);
    expect(directMentionCall).toContain("It @mentions you directly");
    expect(directMentionCall).toContain("always answer");
    expect(directMentionCall).not.toContain(CHATOPS_NO_REPLY_SENTINEL);

    // DMs get no group framing
    await manager.processMessage({
      message: createMockMessage({
        messageId: "dm-message-id",
        metadata: { conversationType: "personal" },
      }),
      provider: mockProvider,
    });

    const dmCall = JSON.stringify(executeSpy.mock.calls[3]);
    expect(dmCall).not.toContain("group conversation with multiple people");
    expect(dmCall).not.toContain(CHATOPS_NO_REPLY_SENTINEL);
  });

  test("resolves user via senderEmail without calling getUserEmail", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeInternalAgent,
  }) => {
    mockA2AExecutor();

    // Setup
    const user = await makeUser({ email: "preresolved@example.com" });
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    await makeTeamMember(team.id, user.id);
    const agent = await makeInternalAgent({
      organizationId: org.id,
      teams: [team.id],
    });
    await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);

    await ChatOpsChannelBindingModel.create({
      organizationId: org.id,
      provider: "ms-teams",
      channelId: "test-channel-id",
      workspaceId: "test-workspace-id",
      agentId: agent.id,
    });

    // getUserEmail should NOT be called when senderEmail is provided
    const getUserEmailSpy = vi
      .fn()
      .mockResolvedValue("should-not-be-used@example.com");
    const mockProvider = createMockProvider({
      getUserEmail: getUserEmailSpy,
    });

    const manager = new ChatOpsManager();
    (
      manager as unknown as { msTeamsProvider: ChatOpsProvider }
    ).msTeamsProvider = mockProvider;

    // Message with pre-resolved senderEmail (from TeamsInfo)
    const message = createMockMessage({
      senderEmail: "preresolved@example.com",
    });
    const result = await manager.processMessage({
      message,
      provider: mockProvider,
    });

    expect(result.success).toBe(true);
    expect(result.agentResponse).toBe("Agent response");
    // getUserEmail should NOT have been called since senderEmail was provided
    expect(getUserEmailSpy).not.toHaveBeenCalled();
  });

  test("rejects when both senderEmail and getUserEmail return null", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeInternalAgent,
  }) => {
    mockA2AExecutor();

    // Setup
    const user = await makeUser({ email: "user@example.com" });
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    await makeTeamMember(team.id, user.id);
    const agent = await makeInternalAgent({
      organizationId: org.id,
      teams: [team.id],
    });
    await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);

    await ChatOpsChannelBindingModel.create({
      organizationId: org.id,
      provider: "ms-teams",
      channelId: "test-channel-id",
      workspaceId: "test-workspace-id",
      agentId: agent.id,
    });

    // No senderEmail on message AND provider returns null for getUserEmail
    const sendReplySpy = vi.fn().mockResolvedValue("reply-id");
    const mockProvider = createMockProvider({
      getUserEmail: async () => null,
      sendReply: sendReplySpy,
    });

    const manager = new ChatOpsManager();
    (
      manager as unknown as { msTeamsProvider: ChatOpsProvider }
    ).msTeamsProvider = mockProvider;

    const message = createMockMessage();
    const result = await manager.processMessage({
      message,
      provider: mockProvider,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Could not resolve user email");
    // Should send error reply to user
    expect(sendReplySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Could not verify your identity"),
      }),
    );
  });

  test("auto-provisions user when email not found in Archestra and denies access to team-restricted agent", async ({
    makeOrganization,
    makeUser,
    makeTeam,
    makeTeamMember,
    makeInternalAgent,
  }) => {
    mockA2AExecutor();

    // Setup: Create org and agent but user email won't match
    const adminUser = await makeUser({ email: "admin@example.com" });
    const org = await makeOrganization();
    const team = await makeTeam(org.id, adminUser.id);
    await makeTeamMember(team.id, adminUser.id);
    const agent = await makeInternalAgent({
      organizationId: org.id,
      scope: "team",
      teams: [team.id],
    });
    await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);

    await ChatOpsChannelBindingModel.create({
      organizationId: org.id,
      provider: "ms-teams",
      channelId: "test-channel-id",
      workspaceId: "test-workspace-id",
      agentId: agent.id,
    });

    // Provider returns an email that doesn't exist in Archestra
    const sendReplySpy = vi.fn().mockResolvedValue("reply-id");
    const mockProvider = createMockProvider({
      getUserEmail: async () => "unknown@external.com",
      sendReply: sendReplySpy,
    });

    const manager = new ChatOpsManager();
    (
      manager as unknown as { msTeamsProvider: ChatOpsProvider }
    ).msTeamsProvider = mockProvider;

    const message = createMockMessage();
    const result = await manager.processMessage({
      message,
      provider: mockProvider,
    });

    // User is auto-provisioned but has no team access to the team-restricted agent
    expect(result.success).toBe(false);
    expect(result.error).toContain("user does not have access to this agent");
  });

  test("rejects when user lacks team access to agent", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeInternalAgent,
    makeMember,
  }) => {
    mockA2AExecutor();

    // Setup: User exists but is NOT a member of any team with agent access
    const user = await makeUser({ email: "noaccess@example.com" });
    const org = await makeOrganization();
    await makeMember(user.id, org.id); // User is org member but not in agent's team
    const adminUser = await makeUser({ email: "admin@example.com" });
    const team = await makeTeam(org.id, adminUser.id);
    const agent = await makeInternalAgent({
      organizationId: org.id,
      name: "Sales Agent",
      teams: [team.id],
      scope: "team",
    });
    await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);

    await ChatOpsChannelBindingModel.create({
      organizationId: org.id,
      provider: "ms-teams",
      channelId: "test-channel-id",
      workspaceId: "test-workspace-id",
      agentId: agent.id,
    });

    const sendReplySpy = vi.fn().mockResolvedValue("reply-id");
    const mockProvider = createMockProvider({
      getUserEmail: async () => "noaccess@example.com",
      sendReply: sendReplySpy,
    });

    const manager = new ChatOpsManager();
    (
      manager as unknown as { msTeamsProvider: ChatOpsProvider }
    ).msTeamsProvider = mockProvider;

    const message = createMockMessage();
    const result = await manager.processMessage({
      message,
      provider: mockProvider,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("does not have access to this agent");
    // Should send error reply with agent name
    expect(sendReplySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Sales Agent"),
      }),
    );
  });

  test("uses verified user ID for agent execution (not synthetic ID)", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeInternalAgent,
  }) => {
    const executorSpy = mockA2AExecutor();

    // Setup
    const user = await makeUser({ email: "verified@example.com" });
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    await makeTeamMember(team.id, user.id);
    const agent = await makeInternalAgent({
      organizationId: org.id,
      teams: [team.id],
    });
    await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);

    await ChatOpsChannelBindingModel.create({
      organizationId: org.id,
      provider: "ms-teams",
      channelId: "test-channel-id",
      workspaceId: "test-workspace-id",
      agentId: agent.id,
    });

    const mockProvider = createMockProvider({
      getUserEmail: async () => "verified@example.com",
    });

    const manager = new ChatOpsManager();
    (
      manager as unknown as { msTeamsProvider: ChatOpsProvider }
    ).msTeamsProvider = mockProvider;

    const message = createMockMessage();
    await manager.processMessage({ message, provider: mockProvider });

    // Verify executeA2AMessage was called with the real user ID, not synthetic
    expect(executorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: user.id, // Real user ID, not "chatops-ms-teams-xxx"
      }),
    );
  });

  test("Teams approver mixed-case email is accepted", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeInternalAgent,
  }) => {
    const sendMessageSpy = vi
      .spyOn(A2AManager.prototype, "sendMessage")
      .mockResolvedValue({});

    const user = await makeUser({ email: "approver@example.com" });
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    await makeTeamMember(team.id, user.id);
    const agent = await makeInternalAgent({
      organizationId: org.id,
      teams: [team.id],
    });

    await ChatOpsChannelBindingModel.create({
      organizationId: org.id,
      provider: "ms-teams",
      channelId: "test-channel-id",
      workspaceId: "test-workspace-id",
      agentId: agent.id,
    });

    const mockProvider = createMockProvider();
    const manager = new ChatOpsManager();

    const decision: ChatOpsApprovalDecision = {
      taskId: "task-1",
      approvalId: "approval-1",
      approved: true,
      toolName: "some_tool",
      messageTs: "msg-ts",
      channelId: "test-channel-id",
      workspaceId: "test-workspace-id",
      userId: "teams-aad-id",
      userName: "Approver",
      responseUrl: "",
      // Teams surfaces the approver email with original casing...
      approverEmail: "Approver@Example.com",
      originalMessage: createMockMessage({
        // ...while the original request stored it lowercased.
        senderEmail: "approver@example.com",
      }),
    };

    try {
      await manager.handleInteractiveApprovalDecision(mockProvider, decision);

      expect(sendMessageSpy).toHaveBeenCalledTimes(1);
      expect(sendMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: agent.id,
          actor: expect.objectContaining({ id: user.id }),
        }),
      );
    } finally {
      sendMessageSpy.mockRestore();
    }
  });

  // The "AgentName > message" syntax routes a single message to a different
  // agent than the channel default. These tests pin both halves of that
  // behavior: a real switch must still strip the prefix, while a message that
  // merely contains ">" (no matching agent) must reach the agent intact.
  // Regression guard for the silent-truncation bug (issue #5747).
  describe("inline agent mention", () => {
    /** Spy on sendMessage and return the text of the first part it received. */
    function captureSentText(spy: ReturnType<typeof vi.spyOn>): string {
      const call = spy.mock.calls[0]?.[0] as
        | { request: { message: { parts: Array<{ text?: string }> } } }
        | undefined;
      return call?.request.message.parts[0]?.text ?? "";
    }

    test("keeps the full message when text contains '>' but no agent matches", async ({
      makeUser,
      makeOrganization,
      makeTeam,
      makeTeamMember,
      makeInternalAgent,
    }) => {
      const sendMessageSpy = vi
        .spyOn(A2AManager.prototype, "sendMessage")
        .mockResolvedValue({});

      const user = await makeUser({ email: "inline@example.com" });
      const org = await makeOrganization();
      const team = await makeTeam(org.id, user.id);
      await makeTeamMember(team.id, user.id);
      const agent = await makeInternalAgent({
        organizationId: org.id,
        teams: [team.id],
      });
      await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        provider: "ms-teams",
        channelId: "test-channel-id",
        workspaceId: "test-workspace-id",
        agentId: agent.id,
      });

      const mockProvider = createMockProvider({
        getUserEmail: async () => "inline@example.com",
      });
      const manager = new ChatOpsManager();
      (
        manager as unknown as { msTeamsProvider: ChatOpsProvider }
      ).msTeamsProvider = mockProvider;

      try {
        await manager.processMessage({
          message: createMockMessage({
            text: "Remember the secret word is BANANA > what was the secret word?",
          }),
          provider: mockProvider,
        });

        // Routed to the channel's default agent (no switch happened)...
        expect(sendMessageSpy).toHaveBeenCalledWith(
          expect.objectContaining({ agentId: agent.id }),
        );
        // ...and the whole message survived — nothing before ">" was dropped.
        const sentText = captureSentText(sendMessageSpy);
        expect(sentText).toContain(
          "Remember the secret word is BANANA > what was the secret word?",
        );
      } finally {
        sendMessageSpy.mockRestore();
      }
    });

    test("switches agent and strips the prefix when the prefix is a real agent", async ({
      makeUser,
      makeOrganization,
      makeTeam,
      makeTeamMember,
      makeInternalAgent,
    }) => {
      const sendMessageSpy = vi
        .spyOn(A2AManager.prototype, "sendMessage")
        .mockResolvedValue({});

      const user = await makeUser({ email: "switch@example.com" });
      const org = await makeOrganization();
      const team = await makeTeam(org.id, user.id);
      await makeTeamMember(team.id, user.id);

      const defaultAgent = await makeInternalAgent({
        organizationId: org.id,
        teams: [team.id],
        name: "Support",
      });
      const salesAgent = await makeInternalAgent({
        organizationId: org.id,
        teams: [team.id],
        name: "Sales",
      });
      await AgentTeamModel.assignTeamsToAgent(defaultAgent.id, [team.id]);
      await AgentTeamModel.assignTeamsToAgent(salesAgent.id, [team.id]);

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        provider: "ms-teams",
        channelId: "test-channel-id",
        workspaceId: "test-workspace-id",
        agentId: defaultAgent.id,
      });

      const mockProvider = createMockProvider({
        getUserEmail: async () => "switch@example.com",
      });
      const manager = new ChatOpsManager();
      (
        manager as unknown as { msTeamsProvider: ChatOpsProvider }
      ).msTeamsProvider = mockProvider;

      try {
        await manager.processMessage({
          message: createMockMessage({
            text: "Sales > what's the status?",
          }),
          provider: mockProvider,
        });

        // Routed to the named agent, not the channel default...
        expect(sendMessageSpy).toHaveBeenCalledWith(
          expect.objectContaining({ agentId: salesAgent.id }),
        );
        // ...with the "Sales >" prefix stripped from what the agent sees.
        const sentText = captureSentText(sendMessageSpy);
        expect(sentText).toContain("what's the status?");
        expect(sentText).not.toContain("Sales >");
      } finally {
        sendMessageSpy.mockRestore();
      }
    });
  });
});

describe("ChatOpsManager.getAccessibleChatopsAgents", () => {
  test("returns only agents the user has team access to", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeInternalAgent,
  }) => {
    const user = await makeUser({ email: "teamuser@example.com" });
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    await makeTeamMember(team.id, user.id);

    // Agent the user HAS access to
    const accessibleAgent = await makeInternalAgent({
      organizationId: org.id,
      name: "Accessible Agent",
      scope: "team",
    });
    await AgentTeamModel.assignTeamsToAgent(accessibleAgent.id, [team.id]);

    // Agent the user does NOT have access to (different team)
    const otherUser = await makeUser({ email: "other@example.com" });
    const otherTeam = await makeTeam(org.id, otherUser.id);
    const inaccessibleAgent = await makeInternalAgent({
      organizationId: org.id,
      name: "Inaccessible Agent",
      scope: "team",
    });
    await AgentTeamModel.assignTeamsToAgent(inaccessibleAgent.id, [
      otherTeam.id,
    ]);

    const manager = new ChatOpsManager();
    const agents = await manager.getAccessibleChatopsAgents({
      senderEmail: "teamuser@example.com",
      isDm: false,
    });

    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe(accessibleAgent.id);
    expect(agents[0].name).toBe("Accessible Agent");
  });

  test("returns all agents when senderEmail is not provided", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeInternalAgent,
  }) => {
    const user = await makeUser({ email: "admin@example.com" });
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);

    const agent = await makeInternalAgent({
      organizationId: org.id,
      name: "Some Agent",
    });
    await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);

    const manager = new ChatOpsManager();
    const agents = await manager.getAccessibleChatopsAgents({
      senderEmail: "admin@example.com",
      isDm: false,
    });

    expect(agents.length).toBeGreaterThanOrEqual(1);
    expect(agents.some((a) => a.id === agent.id)).toBe(true);
  });

  test("returns all agents when senderEmail does not match any user", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeInternalAgent,
  }) => {
    const user = await makeUser({ email: "admin@example.com" });
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);

    const agent = await makeInternalAgent({
      organizationId: org.id,
      name: "Some Agent",
    });
    await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);

    const manager = new ChatOpsManager();
    const agents = await manager.getAccessibleChatopsAgents({
      senderEmail: "nonexistent@example.com",
      isDm: false,
    });

    // Falls back to all agents when user can't be resolved
    expect(agents.length).toBeGreaterThanOrEqual(1);
    expect(agents.some((a) => a.id === agent.id)).toBe(true);
  });

  test("admin user sees all agents regardless of team membership", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeInternalAgent,
    makeMember,
  }) => {
    const adminUser = await makeUser({ email: "fulladmin@example.com" });
    const org = await makeOrganization();
    // Make user an admin (admins have all permissions including agent:admin)
    await makeMember(adminUser.id, org.id, { role: "admin" });

    // Agent NOT in any of admin's teams
    const agent = await makeInternalAgent({
      organizationId: org.id,
      name: "Unassigned Agent",
    });
    // Agent has a team but admin is NOT a member of it
    const otherUser = await makeUser({ email: "otheruser@example.com" });
    const otherTeam = await makeTeam(org.id, otherUser.id);
    await AgentTeamModel.assignTeamsToAgent(agent.id, [otherTeam.id]);

    const manager = new ChatOpsManager();
    const agents = await manager.getAccessibleChatopsAgents({
      senderEmail: "fulladmin@example.com",
      isDm: false,
    });

    // Admin should see all agents
    expect(agents.some((a) => a.id === agent.id)).toBe(true);
  });
});

describe("ChatOpsManager.getAccessibleChatopsAgents personal agent filtering", () => {
  test("excludes personal agents from channel (non-DM) context", async ({
    makeUser,
    makeOrganization,
    makeInternalAgent,
    makeMember,
  }) => {
    const user = await makeUser({ email: "channeluser@example.com" });
    const org = await makeOrganization();
    await makeMember(user.id, org.id, { role: "admin" });

    const orgAgent = await makeInternalAgent({
      organizationId: org.id,
      name: "Org Agent",
      scope: "org",
    });
    const personalAgent = await makeInternalAgent({
      organizationId: org.id,
      name: "Personal Agent",
      scope: "personal",
      authorId: user.id,
    });

    const manager = new ChatOpsManager();
    const agents = await manager.getAccessibleChatopsAgents({
      senderEmail: "channeluser@example.com",
      isDm: false,
    });

    expect(agents.some((a) => a.id === orgAgent.id)).toBe(true);
    expect(agents.some((a) => a.id === personalAgent.id)).toBe(false);
  });

  test("includes user's own personal agents in DM context", async ({
    makeUser,
    makeOrganization,
    makeInternalAgent,
    makeMember,
  }) => {
    const user = await makeUser({ email: "dmuser@example.com" });
    const org = await makeOrganization();
    await makeMember(user.id, org.id, { role: "admin" });

    const orgAgent = await makeInternalAgent({
      organizationId: org.id,
      name: "Org Agent",
      scope: "org",
    });
    const ownPersonalAgent = await makeInternalAgent({
      organizationId: org.id,
      name: "My Personal Agent",
      scope: "personal",
      authorId: user.id,
    });

    const manager = new ChatOpsManager();
    const agents = await manager.getAccessibleChatopsAgents({
      senderEmail: "dmuser@example.com",
      isDm: true,
    });

    expect(agents.some((a) => a.id === orgAgent.id)).toBe(true);
    expect(agents.some((a) => a.id === ownPersonalAgent.id)).toBe(true);
  });

  test("excludes other users' personal agents from DM context", async ({
    makeUser,
    makeOrganization,
    makeInternalAgent,
    makeMember,
  }) => {
    const user = await makeUser({ email: "dmuser2@example.com" });
    const otherUser = await makeUser({ email: "otherauthor@example.com" });
    const org = await makeOrganization();
    await makeMember(user.id, org.id, { role: "admin" });

    const otherPersonalAgent = await makeInternalAgent({
      organizationId: org.id,
      name: "Other Personal Agent",
      scope: "personal",
      authorId: otherUser.id,
    });

    const manager = new ChatOpsManager();
    const agents = await manager.getAccessibleChatopsAgents({
      senderEmail: "dmuser2@example.com",
      isDm: true,
    });

    expect(agents.some((a) => a.id === otherPersonalAgent.id)).toBe(false);
  });
});

describe("ChatOpsManager.handleIncomingMessage empty Slack mention", () => {
  test("replies once for empty app_mention and skips processMessage on retries", async ({
    makeUser,
    makeOrganization,
    makeInternalAgent,
  }) => {
    const user = await makeUser({ email: "slackuser@example.com" });
    const org = await makeOrganization();
    const agent = await makeInternalAgent({
      organizationId: org.id,
      name: "Slack Agent",
    });

    await ChatOpsChannelBindingModel.create({
      organizationId: org.id,
      provider: "slack",
      channelId: "C_TEST",
      workspaceId: "T_TEST",
      agentId: agent.id,
    });

    const sendReplySpy = vi.fn().mockResolvedValue("reply-id");
    const provider: ChatOpsProvider = {
      providerId: "slack",
      displayName: "Slack",
      isConfigured: () => true,
      initialize: async () => {},
      cleanup: async () => {},
      validateWebhookRequest: async () => true,
      handleValidationChallenge: () => null,
      parseWebhookNotification: async (payload) =>
        payload as IncomingChatMessage,
      sendReply: sendReplySpy,
      parseInteractivePayload: () => null,
      sendAgentSelectionCard: async () => {},
      getThreadHistory: async () => [],
      getUserEmail: async () => user.email,
      getChannelName: async () => "test-channel",
      getWorkspaceId: () => "T_TEST",
      getWorkspaceName: () => "Test Workspace",
      hasMissingScopes: () => false,
      notifyMissingScopes: async () => {},
      downloadFiles: async () => [],
      discoverChannels: async () => [],
      addApprovalRequestForm: async () => {},
      updateApprovalRequest: async () => {},
    };

    const manager = new ChatOpsManager();
    const processMessageSpy = vi
      .spyOn(manager, "processMessage")
      .mockResolvedValue({ success: true });

    const message: IncomingChatMessage = {
      messageId: "slack-empty-mention-1",
      channelId: "C_TEST",
      workspaceId: "T_TEST",
      threadId: "1772498106.893979",
      senderId: "U_TEST",
      senderName: "Slack User",
      text: "",
      rawText: "<@UBOT123>",
      timestamp: new Date(),
      isThreadReply: false,
      metadata: {
        eventType: "app_mention",
        channelType: "channel",
      },
    };

    // Initial event + retry with same messageId
    await manager.handleIncomingMessage(provider, message);
    await manager.handleIncomingMessage(provider, message);

    expect(sendReplySpy).toHaveBeenCalledTimes(1);
    expect(processMessageSpy).not.toHaveBeenCalled();
  });
});

describe("ChatOpsManager.handleIncomingMessage missing scope notification", () => {
  function createScopeTestProvider(
    overrides: {
      hasMissingScopes?: () => boolean;
      notifyMissingScopes?: (message: IncomingChatMessage) => Promise<void>;
      parseWebhookNotification?: (
        payload: unknown,
      ) => Promise<IncomingChatMessage | null>;
    } = {},
  ): ChatOpsProvider {
    return {
      providerId: "slack",
      displayName: "Slack",
      isConfigured: () => true,
      initialize: async () => {},
      cleanup: async () => {},
      validateWebhookRequest: async () => true,
      handleValidationChallenge: () => null,
      parseWebhookNotification:
        overrides.parseWebhookNotification ?? (async () => null),
      // getUserEmail returns null so handleIncomingMessage exits early
      // (after the scope notification check) with "Could not verify your identity"
      sendReply: async () => "reply-id",
      parseInteractivePayload: () => null,
      sendAgentSelectionCard: async () => {},
      getThreadHistory: async () => [],
      getUserEmail: async () => null,
      getChannelName: async () => null,
      getWorkspaceId: () => "T_TEST",
      getWorkspaceName: () => "Test Workspace",
      hasMissingScopes: overrides.hasMissingScopes ?? (() => false),
      notifyMissingScopes: overrides.notifyMissingScopes ?? (async () => {}),
      downloadFiles: async () => [],
      discoverChannels: async () => null,
      addApprovalRequestForm: async () => {},
      updateApprovalRequest: async () => {},
    };
  }

  const fakeMessage: IncomingChatMessage = {
    messageId: "scope-test-1",
    channelId: "C_TEST",
    workspaceId: "T_TEST",
    senderId: "U_SENDER",
    senderName: "Test",
    text: "hello",
    rawText: "hello",
    timestamp: new Date(),
    isThreadReply: false,
  };

  test("calls notifyMissingScopes when provider reports missing scopes", async () => {
    const notifySpy = vi.fn().mockResolvedValue(undefined);

    const provider = createScopeTestProvider({
      hasMissingScopes: () => true,
      notifyMissingScopes: notifySpy,
      parseWebhookNotification: async () => fakeMessage,
    });

    const manager = new ChatOpsManager();
    await manager.handleIncomingMessage(provider, fakeMessage);

    expect(notifySpy).toHaveBeenCalledWith(fakeMessage);
  });

  test("does not call notifyMissingScopes when no scopes are missing", async () => {
    const notifySpy = vi.fn().mockResolvedValue(undefined);

    const provider = createScopeTestProvider({
      hasMissingScopes: () => false,
      notifyMissingScopes: notifySpy,
      parseWebhookNotification: async () => fakeMessage,
    });

    const manager = new ChatOpsManager();
    await manager.handleIncomingMessage(provider, fakeMessage);

    expect(notifySpy).not.toHaveBeenCalled();
  });

  test("does not block message processing if notifyMissingScopes rejects", async () => {
    const provider = createScopeTestProvider({
      hasMissingScopes: () => true,
      notifyMissingScopes: async () => {
        throw new Error("notification failed");
      },
      parseWebhookNotification: async () => fakeMessage,
    });

    const manager = new ChatOpsManager();

    // Should not throw even though notifyMissingScopes rejects
    // (handleIncomingMessage continues to the email check, then exits
    // early because getUserEmail returns null — that's fine for this test)
    await expect(
      manager.handleIncomingMessage(provider, fakeMessage),
    ).resolves.not.toThrow();
  });
});

describe("ChatOpsManager.initialize — partial config", () => {
  // Clear all chatops env vars to prevent seed logic from running
  beforeEach(() => {
    vi.stubEnv("ARCHESTRA_CHATOPS_MS_TEAMS_ENABLED", "");
    vi.stubEnv("ARCHESTRA_CHATOPS_MS_TEAMS_APP_ID", "");
    vi.stubEnv("ARCHESTRA_CHATOPS_MS_TEAMS_APP_SECRET", "");
    vi.stubEnv("ARCHESTRA_CHATOPS_MS_TEAMS_TENANT_ID", "");
    vi.stubEnv("ARCHESTRA_CHATOPS_MS_TEAMS_GRAPH_TENANT_ID", "");
    vi.stubEnv("ARCHESTRA_CHATOPS_MS_TEAMS_GRAPH_CLIENT_ID", "");
    vi.stubEnv("ARCHESTRA_CHATOPS_MS_TEAMS_GRAPH_CLIENT_SECRET", "");
    vi.stubEnv("ARCHESTRA_CHATOPS_SLACK_ENABLED", "");
    vi.stubEnv("ARCHESTRA_CHATOPS_SLACK_BOT_TOKEN", "");
    vi.stubEnv("ARCHESTRA_CHATOPS_SLACK_SIGNING_SECRET", "");
    vi.stubEnv("ARCHESTRA_CHATOPS_SLACK_APP_ID", "");
    vi.stubEnv("ARCHESTRA_CHATOPS_SLACK_CONNECTION_MODE", "");
    vi.stubEnv("ARCHESTRA_CHATOPS_SLACK_APP_LEVEL_TOKEN", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("initializes Slack when only Slack config exists in DB", async () => {
    await ChatOpsConfigModel.saveSlackConfig({
      enabled: true,
      botToken: "xoxb-test",
      signingSecret: "test-secret",
      appId: "A123",
    });

    const manager = new ChatOpsManager();
    await manager.initialize();

    expect(manager.getMSTeamsProvider()).toBeNull();
    expect(manager.getSlackProvider()).not.toBeNull();
    expect(manager.getSlackProvider()?.isConfigured()).toBe(true);

    await manager.cleanup();
  });

  test("initializes MS Teams when only MS Teams config exists in DB", async () => {
    await ChatOpsConfigModel.saveMsTeamsConfig({
      enabled: true,
      appId: "test-app-id",
      appSecret: "test-secret",
      tenantId: "test-tenant",
      graphTenantId: "test-tenant",
      graphClientId: "test-app-id",
      graphClientSecret: "test-secret",
    });

    const manager = new ChatOpsManager();
    await manager.initialize();

    expect(manager.getSlackProvider()).toBeNull();
    expect(manager.getMSTeamsProvider()).not.toBeNull();
    expect(manager.getMSTeamsProvider()?.isConfigured()).toBe(true);

    await manager.cleanup();
  });

  test("handles no config in DB gracefully", async () => {
    const manager = new ChatOpsManager();
    await manager.initialize();

    expect(manager.getMSTeamsProvider()).toBeNull();
    expect(manager.getSlackProvider()).toBeNull();
    expect(manager.isAnyProviderConfigured()).toBe(false);

    await manager.cleanup();
  });
});

// =============================================================================
// seedConfigFromEnvVars (private, tested via cast)
// =============================================================================

describe("ChatOpsManager.seedConfigFromEnvVars", () => {
  // Clear all chatops env vars before each test to prevent real dev-env values from leaking
  beforeEach(() => {
    vi.stubEnv("ARCHESTRA_CHATOPS_MS_TEAMS_ENABLED", "");
    vi.stubEnv("ARCHESTRA_CHATOPS_MS_TEAMS_APP_ID", "");
    vi.stubEnv("ARCHESTRA_CHATOPS_MS_TEAMS_APP_SECRET", "");
    vi.stubEnv("ARCHESTRA_CHATOPS_MS_TEAMS_TENANT_ID", "");
    vi.stubEnv("ARCHESTRA_CHATOPS_MS_TEAMS_GRAPH_TENANT_ID", "");
    vi.stubEnv("ARCHESTRA_CHATOPS_MS_TEAMS_GRAPH_CLIENT_ID", "");
    vi.stubEnv("ARCHESTRA_CHATOPS_MS_TEAMS_GRAPH_CLIENT_SECRET", "");
    vi.stubEnv("ARCHESTRA_CHATOPS_SLACK_ENABLED", "");
    vi.stubEnv("ARCHESTRA_CHATOPS_SLACK_BOT_TOKEN", "");
    vi.stubEnv("ARCHESTRA_CHATOPS_SLACK_SIGNING_SECRET", "");
    vi.stubEnv("ARCHESTRA_CHATOPS_SLACK_APP_ID", "");
    vi.stubEnv("ARCHESTRA_CHATOPS_SLACK_CONNECTION_MODE", "");
    vi.stubEnv("ARCHESTRA_CHATOPS_SLACK_APP_LEVEL_TOKEN", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("seeds MS Teams config from env vars when DB is empty", async () => {
    vi.stubEnv("ARCHESTRA_CHATOPS_MS_TEAMS_ENABLED", "true");
    vi.stubEnv("ARCHESTRA_CHATOPS_MS_TEAMS_APP_ID", "env-app-id");
    vi.stubEnv("ARCHESTRA_CHATOPS_MS_TEAMS_APP_SECRET", "env-app-secret");
    vi.stubEnv("ARCHESTRA_CHATOPS_MS_TEAMS_TENANT_ID", "env-tenant-id");

    const manager = new ChatOpsManager();
    // biome-ignore lint/suspicious/noExplicitAny: test-only — invoke private method
    await (manager as any).seedConfigFromEnvVars();

    const config = await ChatOpsConfigModel.getMsTeamsConfig();
    expect(config).not.toBeNull();
    expect(config?.enabled).toBe(true);
    expect(config?.appId).toBe("env-app-id");
    expect(config?.appSecret).toBe("env-app-secret");
    expect(config?.tenantId).toBe("env-tenant-id");
  });

  test("seeds Slack config from env vars when DB is empty", async () => {
    vi.stubEnv("ARCHESTRA_CHATOPS_SLACK_ENABLED", "true");
    vi.stubEnv("ARCHESTRA_CHATOPS_SLACK_BOT_TOKEN", "xoxb-test-token");
    vi.stubEnv("ARCHESTRA_CHATOPS_SLACK_SIGNING_SECRET", "test-signing-secret");
    vi.stubEnv("ARCHESTRA_CHATOPS_SLACK_APP_ID", "A12345");

    const manager = new ChatOpsManager();
    // biome-ignore lint/suspicious/noExplicitAny: test-only — invoke private method
    await (manager as any).seedConfigFromEnvVars();

    const config = await ChatOpsConfigModel.getSlackConfig();
    expect(config).not.toBeNull();
    expect(config?.enabled).toBe(true);
    expect(config?.botToken).toBe("xoxb-test-token");
    expect(config?.signingSecret).toBe("test-signing-secret");
    expect(config?.appId).toBe("A12345");
  });

  test("does not overwrite existing MS Teams DB config", async () => {
    // Pre-seed DB
    await ChatOpsConfigModel.saveMsTeamsConfig({
      enabled: true,
      appId: "db-app-id",
      appSecret: "db-app-secret",
      tenantId: "db-tenant",
      graphTenantId: "db-tenant",
      graphClientId: "db-app-id",
      graphClientSecret: "db-app-secret",
    });

    // Set different env vars
    vi.stubEnv("ARCHESTRA_CHATOPS_MS_TEAMS_ENABLED", "true");
    vi.stubEnv("ARCHESTRA_CHATOPS_MS_TEAMS_APP_ID", "env-app-id");
    vi.stubEnv("ARCHESTRA_CHATOPS_MS_TEAMS_APP_SECRET", "env-app-secret");

    const manager = new ChatOpsManager();
    // biome-ignore lint/suspicious/noExplicitAny: test-only — invoke private method
    await (manager as any).seedConfigFromEnvVars();

    // DB config should be unchanged
    const config = await ChatOpsConfigModel.getMsTeamsConfig();
    expect(config?.appId).toBe("db-app-id");
  });

  test("does not overwrite existing Slack DB config", async () => {
    await ChatOpsConfigModel.saveSlackConfig({
      enabled: true,
      botToken: "xoxb-db-token",
      signingSecret: "db-signing-secret",
      appId: "DB_APP",
    });

    vi.stubEnv("ARCHESTRA_CHATOPS_SLACK_ENABLED", "true");
    vi.stubEnv("ARCHESTRA_CHATOPS_SLACK_BOT_TOKEN", "xoxb-env-token");
    vi.stubEnv("ARCHESTRA_CHATOPS_SLACK_SIGNING_SECRET", "env-signing-secret");

    const manager = new ChatOpsManager();
    // biome-ignore lint/suspicious/noExplicitAny: test-only — invoke private method
    await (manager as any).seedConfigFromEnvVars();

    const config = await ChatOpsConfigModel.getSlackConfig();
    expect(config?.botToken).toBe("xoxb-db-token");
  });

  test("no-op when no DB config and no env vars", async () => {
    const manager = new ChatOpsManager();
    // biome-ignore lint/suspicious/noExplicitAny: test-only — invoke private method
    await (manager as any).seedConfigFromEnvVars();

    const msTeams = await ChatOpsConfigModel.getMsTeamsConfig();
    const slack = await ChatOpsConfigModel.getSlackConfig();
    expect(msTeams).toBeNull();
    expect(slack).toBeNull();
  });

  test("MS Teams graph credentials fall back to bot credentials when not set", async () => {
    vi.stubEnv("ARCHESTRA_CHATOPS_MS_TEAMS_ENABLED", "true");
    vi.stubEnv("ARCHESTRA_CHATOPS_MS_TEAMS_APP_ID", "bot-app-id");
    vi.stubEnv("ARCHESTRA_CHATOPS_MS_TEAMS_APP_SECRET", "bot-app-secret");
    vi.stubEnv("ARCHESTRA_CHATOPS_MS_TEAMS_TENANT_ID", "bot-tenant-id");
    // Graph env vars NOT set — should fall back to bot values

    const manager = new ChatOpsManager();
    // biome-ignore lint/suspicious/noExplicitAny: test-only — invoke private method
    await (manager as any).seedConfigFromEnvVars();

    const config = await ChatOpsConfigModel.getMsTeamsConfig();
    expect(config?.graphTenantId).toBe("bot-tenant-id");
    expect(config?.graphClientId).toBe("bot-app-id");
    expect(config?.graphClientSecret).toBe("bot-app-secret");
  });

  test("does not seed MS Teams when only appId is set (missing appSecret)", async () => {
    vi.stubEnv("ARCHESTRA_CHATOPS_MS_TEAMS_APP_ID", "env-app-id");
    // appSecret not set

    const manager = new ChatOpsManager();
    // biome-ignore lint/suspicious/noExplicitAny: test-only — invoke private method
    await (manager as any).seedConfigFromEnvVars();

    const config = await ChatOpsConfigModel.getMsTeamsConfig();
    expect(config).toBeNull();
  });

  test("seeds Slack socket mode config from env vars when DB is empty", async () => {
    vi.stubEnv("ARCHESTRA_CHATOPS_SLACK_ENABLED", "true");
    vi.stubEnv("ARCHESTRA_CHATOPS_SLACK_BOT_TOKEN", "xoxb-socket-token");
    vi.stubEnv("ARCHESTRA_CHATOPS_SLACK_CONNECTION_MODE", "socket");
    vi.stubEnv("ARCHESTRA_CHATOPS_SLACK_APP_LEVEL_TOKEN", "xapp-test-token");
    vi.stubEnv("ARCHESTRA_CHATOPS_SLACK_APP_ID", "A_SOCKET");

    const manager = new ChatOpsManager();
    // biome-ignore lint/suspicious/noExplicitAny: test-only — invoke private method
    await (manager as any).seedConfigFromEnvVars();

    const config = await ChatOpsConfigModel.getSlackConfig();
    expect(config).not.toBeNull();
    expect(config?.enabled).toBe(true);
    expect(config?.botToken).toBe("xoxb-socket-token");
    expect(config?.connectionMode).toBe("socket");
    expect(config?.appLevelToken).toBe("xapp-test-token");
    expect(config?.appId).toBe("A_SOCKET");
  });

  test("does not seed Slack socket mode when appLevelToken is missing", async () => {
    vi.stubEnv("ARCHESTRA_CHATOPS_SLACK_CONNECTION_MODE", "socket");
    vi.stubEnv("ARCHESTRA_CHATOPS_SLACK_BOT_TOKEN", "xoxb-token");
    // No signing secret and no app-level token

    const manager = new ChatOpsManager();
    // biome-ignore lint/suspicious/noExplicitAny: test-only — invoke private method
    await (manager as any).seedConfigFromEnvVars();

    const config = await ChatOpsConfigModel.getSlackConfig();
    expect(config).toBeNull();
  });
});

// =============================================================================
// Slack Socket Mode — isConfigured validation
// =============================================================================

describe("ChatOpsManager.initialize — Slack socket mode", () => {
  beforeEach(() => {
    vi.stubEnv("ARCHESTRA_CHATOPS_MS_TEAMS_ENABLED", "");
    vi.stubEnv("ARCHESTRA_CHATOPS_MS_TEAMS_APP_ID", "");
    vi.stubEnv("ARCHESTRA_CHATOPS_MS_TEAMS_APP_SECRET", "");
    vi.stubEnv("ARCHESTRA_CHATOPS_MS_TEAMS_TENANT_ID", "");
    vi.stubEnv("ARCHESTRA_CHATOPS_MS_TEAMS_GRAPH_TENANT_ID", "");
    vi.stubEnv("ARCHESTRA_CHATOPS_MS_TEAMS_GRAPH_CLIENT_ID", "");
    vi.stubEnv("ARCHESTRA_CHATOPS_MS_TEAMS_GRAPH_CLIENT_SECRET", "");
    vi.stubEnv("ARCHESTRA_CHATOPS_SLACK_ENABLED", "");
    vi.stubEnv("ARCHESTRA_CHATOPS_SLACK_BOT_TOKEN", "");
    vi.stubEnv("ARCHESTRA_CHATOPS_SLACK_SIGNING_SECRET", "");
    vi.stubEnv("ARCHESTRA_CHATOPS_SLACK_APP_ID", "");
    vi.stubEnv("ARCHESTRA_CHATOPS_SLACK_CONNECTION_MODE", "");
    vi.stubEnv("ARCHESTRA_CHATOPS_SLACK_APP_LEVEL_TOKEN", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("socket mode config is configured when botToken and appLevelToken are set", async () => {
    await ChatOpsConfigModel.saveSlackConfig({
      enabled: true,
      botToken: "xoxb-test",
      signingSecret: "",
      appId: "A123",
      connectionMode: "socket",
      appLevelToken: "xapp-test-token",
    });

    const manager = new ChatOpsManager();
    await manager.initialize();

    const provider = manager.getSlackProvider();
    expect(provider).not.toBeNull();
    expect(provider?.isConfigured()).toBe(true);
    expect(provider?.isSocketMode()).toBe(true);
    expect(provider?.getConnectionMode()).toBe("socket");

    await manager.cleanup();
  });

  test("socket mode config is not configured when appLevelToken is missing", async () => {
    await ChatOpsConfigModel.saveSlackConfig({
      enabled: true,
      botToken: "xoxb-test",
      signingSecret: "",
      appId: "A123",
      connectionMode: "socket",
      // no appLevelToken
    });

    const manager = new ChatOpsManager();
    await manager.initialize();

    const provider = manager.getSlackProvider();
    expect(provider).not.toBeNull();
    expect(provider?.isConfigured()).toBe(false);

    await manager.cleanup();
  });

  test("webhook mode config is not configured when signingSecret is missing", async () => {
    await ChatOpsConfigModel.saveSlackConfig({
      enabled: true,
      botToken: "xoxb-test",
      signingSecret: "",
      appId: "A123",
      connectionMode: "webhook",
    });

    const manager = new ChatOpsManager();
    await manager.initialize();

    const provider = manager.getSlackProvider();
    expect(provider).not.toBeNull();
    expect(provider?.isConfigured()).toBe(false);
    expect(provider?.isSocketMode()).toBe(false);

    await manager.cleanup();
  });

  test("defaults to socket mode when connectionMode is not set", async () => {
    await ChatOpsConfigModel.saveSlackConfig({
      enabled: true,
      botToken: "xoxb-test",
      signingSecret: "",
      appId: "A123",
      appLevelToken: "xapp-test-token",
    });

    const manager = new ChatOpsManager();
    await manager.initialize();

    const provider = manager.getSlackProvider();
    expect(provider).not.toBeNull();
    expect(provider?.isSocketMode()).toBe(true);
    expect(provider?.getConnectionMode()).toBe("socket");

    await manager.cleanup();
  });
});

// =============================================================================
// Attachment passthrough to A2A executor
// =============================================================================

describe("ChatOpsManager attachment passthrough", () => {
  function createMockProvider(
    overrides: {
      getUserEmail?: (userId: string) => Promise<string | null>;
      sendReply?: (options: ChatReplyOptions) => Promise<string>;
    } = {},
  ): ChatOpsProvider {
    return {
      providerId: "ms-teams",
      displayName: "Microsoft Teams",
      isConfigured: () => true,
      initialize: async () => {},
      cleanup: async () => {},
      validateWebhookRequest: async () => true,
      handleValidationChallenge: () => null,
      parseWebhookNotification: async () => null,
      sendReply: overrides.sendReply ?? (async () => "reply-id"),
      parseInteractivePayload: () => null,
      sendAgentSelectionCard: async () => {},
      getThreadHistory: async () => [],
      getUserEmail: overrides.getUserEmail ?? (async () => null),
      getChannelName: async () => null,
      getWorkspaceId: () => null,
      getWorkspaceName: () => null,
      hasMissingScopes: () => false,
      notifyMissingScopes: async () => {},
      downloadFiles: async () => [],
      discoverChannels: async () => null,
      addApprovalRequestForm: async () => {},
      updateApprovalRequest: async () => {},
    };
  }

  function createMockMessage(
    overrides: Partial<IncomingChatMessage> = {},
  ): IncomingChatMessage {
    return {
      messageId: "test-attach-msg",
      channelId: "test-channel-id",
      workspaceId: "test-workspace-id",
      senderId: "test-sender-aad-id",
      senderName: "Test User",
      text: "Check this image",
      rawText: "@Bot Check this image",
      timestamp: new Date(),
      isThreadReply: false,
      ...overrides,
    };
  }

  test("passes attachments from message to executeA2AMessage", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeInternalAgent,
  }) => {
    const executorSpy = vi
      .spyOn(a2aExecutor, "executeA2AMessage")
      .mockResolvedValue({
        text: "I see the image",
        messageId: "msg-1",
        finishReason: "stop",
        responseUiMessage: {
          id: "msg-1",
          role: "assistant",
          parts: [{ type: "text", text: "response" }],
        },
      });

    const user = await makeUser({ email: "attach-user@example.com" });
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    await makeTeamMember(team.id, user.id);
    const agent = await makeInternalAgent({
      organizationId: org.id,
      teams: [team.id],
    });
    await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);

    await ChatOpsChannelBindingModel.create({
      organizationId: org.id,
      provider: "ms-teams",
      channelId: "test-channel-id",
      workspaceId: "test-workspace-id",
      agentId: agent.id,
    });

    const mockProvider = createMockProvider({
      getUserEmail: async () => "attach-user@example.com",
    });

    const manager = new ChatOpsManager();
    (
      manager as unknown as { msTeamsProvider: ChatOpsProvider }
    ).msTeamsProvider = mockProvider;

    const testAttachments = [
      {
        contentType: "image/png",
        contentBase64: Buffer.alloc(10_000).toString("base64"),
        name: "screenshot.png",
      },
      {
        contentType: "application/pdf",
        contentBase64: Buffer.alloc(10_000).toString("base64"),
        name: "report.pdf",
      },
    ];

    const message = createMockMessage({ attachments: testAttachments });
    const result = await manager.processMessage({
      message,
      provider: mockProvider,
    });

    expect(result.success).toBe(true);
    // The manager forwards the attachments to the executor via the `attachments`
    // param (preserving mime type + filename); model-capability gating and
    // provider normalization happen inside the executor.
    expect(executorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: expect.arrayContaining([
          expect.objectContaining({
            contentType: "image/png",
            name: "screenshot.png",
          }),
          expect.objectContaining({
            contentType: "application/pdf",
            name: "report.pdf",
          }),
        ]),
      }),
    );
  });

  test("omits attachments param when message has no attachments", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeInternalAgent,
  }) => {
    const executorSpy = vi
      .spyOn(a2aExecutor, "executeA2AMessage")
      .mockResolvedValue({
        text: "Plain response",
        messageId: "msg-2",
        finishReason: "stop",
        responseUiMessage: {
          id: "msg-2",
          role: "assistant",
          parts: [{ type: "text", text: "Plain response" }],
        },
      });

    const user = await makeUser({ email: "noattach@example.com" });
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    await makeTeamMember(team.id, user.id);
    const agent = await makeInternalAgent({
      organizationId: org.id,
      teams: [team.id],
    });
    await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);

    await ChatOpsChannelBindingModel.create({
      organizationId: org.id,
      provider: "ms-teams",
      channelId: "test-channel-id",
      workspaceId: "test-workspace-id",
      agentId: agent.id,
    });

    const mockProvider = createMockProvider({
      getUserEmail: async () => "noattach@example.com",
    });

    const manager = new ChatOpsManager();
    (
      manager as unknown as { msTeamsProvider: ChatOpsProvider }
    ).msTeamsProvider = mockProvider;

    const message = createMockMessage(); // no attachments
    await manager.processMessage({ message, provider: mockProvider });

    const callArg = executorSpy.mock.calls[0][0];
    expect(callArg.attachments).toBeUndefined();
  });

  test("tells the model about skipped attachments in the message text", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeInternalAgent,
  }) => {
    const executorSpy = vi
      .spyOn(a2aExecutor, "executeA2AMessage")
      .mockResolvedValue({
        text: "That file was too large.",
        messageId: "msg-skip",
        finishReason: "stop",
        responseUiMessage: {
          id: "msg-skip",
          role: "assistant",
          parts: [{ type: "text", text: "That file was too large." }],
        },
      });

    const user = await makeUser({ email: "skip-user@example.com" });
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    await makeTeamMember(team.id, user.id);
    const agent = await makeInternalAgent({
      organizationId: org.id,
      teams: [team.id],
    });
    await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);

    await ChatOpsChannelBindingModel.create({
      organizationId: org.id,
      provider: "ms-teams",
      channelId: "test-channel-id",
      workspaceId: "test-workspace-id",
      agentId: agent.id,
    });

    const mockProvider = createMockProvider({
      getUserEmail: async () => "skip-user@example.com",
    });

    const manager = new ChatOpsManager();
    (
      manager as unknown as { msTeamsProvider: ChatOpsProvider }
    ).msTeamsProvider = mockProvider;

    const message = createMockMessage({
      skippedAttachments: [
        { name: "IMG_0354.png", sizeBytes: 16_562_518, reason: "too_large" },
      ],
    });
    await manager.processMessage({ message, provider: mockProvider });

    // The dropped file is named in the text the model receives, so it can
    // explain it rather than denying the file existed.
    const callArg = executorSpy.mock.calls[0][0];
    expect(callArg.message).toContain("IMG_0354.png");
  });

  test("includes image attachments from thread history in follow-up messages", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeInternalAgent,
  }) => {
    const historyImageAttachment = {
      contentType: "image/png",
      contentBase64: Buffer.alloc(10_000).toString("base64"),
      name: "photo.png",
    };

    const executorSpy = vi
      .spyOn(a2aExecutor, "executeA2AMessage")
      .mockResolvedValue({
        text: "I can see the photo from earlier",
        messageId: "msg-3",
        finishReason: "stop",
        responseUiMessage: {
          id: "msg-1",
          role: "assistant",
          parts: [{ type: "text", text: "response" }],
        },
      });

    const user = await makeUser({ email: "history-attach@example.com" });
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    await makeTeamMember(team.id, user.id);
    const agent = await makeInternalAgent({
      organizationId: org.id,
      teams: [team.id],
    });
    await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);

    await ChatOpsChannelBindingModel.create({
      organizationId: org.id,
      provider: "ms-teams",
      channelId: "test-channel-id",
      workspaceId: "test-workspace-id",
      agentId: agent.id,
    });

    // Mock provider returns thread history with image files from a previous user message
    const mockProvider = createMockProvider({
      getUserEmail: async () => "history-attach@example.com",
    });
    mockProvider.getThreadHistory = async () => [
      {
        messageId: "earlier-msg",
        senderId: "test-sender-aad-id",
        senderName: "Test User",
        text: "Check out this photo",
        timestamp: new Date(Date.now() - 60_000),
        isFromBot: false,
        files: [
          {
            url: "https://files.slack.com/files-pri/T123/photo.png",
            mimetype: "image/png",
            name: "photo.png",
            size: 1024,
          },
        ],
      },
      {
        messageId: "bot-reply",
        senderId: "bot",
        senderName: "Bot",
        text: "I see a photo of a cat.",
        timestamp: new Date(Date.now() - 30_000),
        isFromBot: true,
      },
    ];
    // downloadFiles reports the base64-encoded image as delivered
    mockProvider.downloadFiles = async () => [
      { status: "delivered", attachment: historyImageAttachment },
    ];

    const manager = new ChatOpsManager();
    (
      manager as unknown as { msTeamsProvider: ChatOpsProvider }
    ).msTeamsProvider = mockProvider;

    // Follow-up message with no new attachments, but in the same thread
    const message = createMockMessage({
      threadId: "thread-123",
      isThreadReply: true,
      text: "What breed is the cat?",
    });

    const result = await manager.processMessage({
      message,
      provider: mockProvider,
    });

    expect(result.success).toBe(true);
    // The image from thread history should be forwarded to the executor via the
    // `attachments` param.
    expect(executorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: expect.arrayContaining([
          expect.objectContaining({
            contentType: historyImageAttachment.contentType,
          }),
        ]),
      }),
    );
  });

  test("includes non-image attachments (PDF) from thread history within budget", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeInternalAgent,
  }) => {
    const downloadedPdf = {
      contentType: "application/pdf",
      contentBase64: Buffer.alloc(10_000).toString("base64"),
      name: "history.pdf",
    };

    const executorSpy = vi
      .spyOn(a2aExecutor, "executeA2AMessage")
      .mockResolvedValue({
        text: "I read the PDF from earlier",
        messageId: "msg-3",
        finishReason: "stop",
        responseUiMessage: {
          id: "msg-1",
          role: "assistant",
          parts: [{ type: "text", text: "response" }],
        },
      });

    const user = await makeUser({ email: "pdf-history@example.com" });
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    await makeTeamMember(team.id, user.id);
    const agent = await makeInternalAgent({
      organizationId: org.id,
      teams: [team.id],
    });
    await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);

    await ChatOpsChannelBindingModel.create({
      organizationId: org.id,
      provider: "ms-teams",
      channelId: "test-channel-id",
      workspaceId: "test-workspace-id",
      agentId: agent.id,
    });

    const mockProvider = createMockProvider({
      getUserEmail: async () => "pdf-history@example.com",
    });
    mockProvider.getThreadHistory = async () => [
      {
        messageId: "earlier-msg",
        senderId: "test-sender-aad-id",
        senderName: "Test User",
        text: "Here is the report",
        timestamp: new Date(Date.now() - 60_000),
        isFromBot: false,
        files: [
          {
            url: "https://files.slack.com/files-pri/T123/report.pdf",
            mimetype: "application/pdf",
            name: "history.pdf",
            size: 1024,
          },
        ],
      },
    ];
    const downloadFilesSpy = vi
      .fn<ChatOpsProvider["downloadFiles"]>()
      .mockResolvedValue([{ status: "delivered", attachment: downloadedPdf }]);
    mockProvider.downloadFiles = downloadFilesSpy;

    const manager = new ChatOpsManager();
    (
      manager as unknown as { msTeamsProvider: ChatOpsProvider }
    ).msTeamsProvider = mockProvider;

    const message = createMockMessage({
      threadId: "thread-123",
      isThreadReply: true,
      text: "Summarize the report",
    });

    const result = await manager.processMessage({
      message,
      provider: mockProvider,
    });

    expect(result.success).toBe(true);
    // The PDF history file must be eligible for re-download (image-only filter removed)
    expect(downloadFilesSpy).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          mimetype: "application/pdf",
          name: "history.pdf",
        }),
      ]),
    );
    // And, being within budget, it must be forwarded to the executor.
    const forwardedAttachments =
      executorSpy.mock.calls[0]?.[0]?.attachments ?? [];
    expect(forwardedAttachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          contentType: "application/pdf",
          name: "history.pdf",
        }),
      ]),
    );
  });

  test("skips a non-image history attachment that exceeds the total budget", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeInternalAgent,
  }) => {
    // Current message already consumes almost the entire total budget, leaving
    // only a tiny remainder for thread-history replay.
    const currentPdf = {
      contentType: "application/pdf",
      contentBase64: Buffer.alloc(
        CHATOPS_ATTACHMENT_LIMITS.MAX_TOTAL_ATTACHMENTS_SIZE - 2000,
      ).toString("base64"),
      name: "current.pdf",
    };
    // The downloaded history file is well within the per-file size limit but
    // larger than the remaining total budget, so it must be trimmed.
    const downloadedHistoryPdf = {
      contentType: "application/pdf",
      contentBase64: Buffer.alloc(10_000).toString("base64"),
      name: "history.pdf",
    };

    const executorSpy = vi
      .spyOn(a2aExecutor, "executeA2AMessage")
      .mockResolvedValue({
        text: "ok",
        messageId: "msg-3",
        finishReason: "stop",
        responseUiMessage: {
          id: "msg-1",
          role: "assistant",
          parts: [{ type: "text", text: "response" }],
        },
      });

    const user = await makeUser({ email: "pdf-budget@example.com" });
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    await makeTeamMember(team.id, user.id);
    const agent = await makeInternalAgent({
      organizationId: org.id,
      teams: [team.id],
    });
    await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);

    await ChatOpsChannelBindingModel.create({
      organizationId: org.id,
      provider: "ms-teams",
      channelId: "test-channel-id",
      workspaceId: "test-workspace-id",
      agentId: agent.id,
    });

    const mockProvider = createMockProvider({
      getUserEmail: async () => "pdf-budget@example.com",
    });
    mockProvider.getThreadHistory = async () => [
      {
        messageId: "earlier-msg",
        senderId: "test-sender-aad-id",
        senderName: "Test User",
        text: "Here is the report",
        timestamp: new Date(Date.now() - 60_000),
        isFromBot: false,
        files: [
          {
            url: "https://files.slack.com/files-pri/T123/report.pdf",
            mimetype: "application/pdf",
            name: "history.pdf",
            size: 1024,
          },
        ],
      },
    ];
    const downloadFilesSpy = vi
      .fn<ChatOpsProvider["downloadFiles"]>()
      .mockResolvedValue([
        { status: "delivered", attachment: downloadedHistoryPdf },
      ]);
    mockProvider.downloadFiles = downloadFilesSpy;

    const manager = new ChatOpsManager();
    (
      manager as unknown as { msTeamsProvider: ChatOpsProvider }
    ).msTeamsProvider = mockProvider;

    const message = createMockMessage({
      threadId: "thread-123",
      isThreadReply: true,
      text: "Summarize both reports",
      attachments: [currentPdf],
    });

    const result = await manager.processMessage({
      message,
      provider: mockProvider,
    });

    expect(result.success).toBe(true);
    // It is still eligible (download happens before budget trimming)...
    expect(downloadFilesSpy).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          mimetype: "application/pdf",
          name: "history.pdf",
        }),
      ]),
    );
    // ...but it must NOT survive the total-budget trim, while the current
    // attachment is preserved.
    const forwardedAttachments =
      executorSpy.mock.calls[0]?.[0]?.attachments ?? [];
    expect(forwardedAttachments).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "history.pdf" }),
      ]),
    );
    expect(forwardedAttachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "current.pdf" }),
      ]),
    );
    // The trimmed file's turn carries a total_limit_reached note (built with
    // the decoded size of the downloaded attachment, mirroring the manager).
    const trimNote = buildHistorySkippedAttachmentsNote([
      {
        name: "history.pdf",
        sizeBytes: Math.ceil(
          (downloadedHistoryPdf.contentBase64.length * 3) / 4,
        ),
        reason: "total_limit_reached",
      },
    ]);
    expect(executorSpy.mock.calls[0][0].message.split("\n")).toContain(
      `Test User: Here is the report${trimNote}`,
    );
  });

  test("appends a provider-skip note to the history turn the file came from", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeInternalAgent,
  }) => {
    const deliveredDeck = {
      contentType: "application/pdf",
      contentBase64: Buffer.alloc(10_000).toString("base64"),
      name: "deck.pdf",
    };
    const deliveredSheet = {
      contentType: "application/vnd.ms-excel",
      contentBase64: Buffer.alloc(2_000).toString("base64"),
      name: "budget.xlsx",
    };
    const skippedSheet: SkippedAttachment = {
      name: "budget.xlsx",
      sizeBytes: 2048,
      reason: "download_failed",
    };

    const executorSpy = vi
      .spyOn(a2aExecutor, "executeA2AMessage")
      .mockResolvedValue({
        text: "ok",
        messageId: "msg-skip-turn",
        finishReason: "stop",
        responseUiMessage: {
          id: "msg-skip-turn",
          role: "assistant",
          parts: [{ type: "text", text: "ok" }],
        },
      });

    const user = await makeUser({ email: "history-skip@example.com" });
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    await makeTeamMember(team.id, user.id);
    const agent = await makeInternalAgent({
      organizationId: org.id,
      teams: [team.id],
    });
    await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);

    await ChatOpsChannelBindingModel.create({
      organizationId: org.id,
      provider: "ms-teams",
      channelId: "test-channel-id",
      workspaceId: "test-workspace-id",
      agentId: agent.id,
    });

    const mockProvider = createMockProvider({
      getUserEmail: async () => "history-skip@example.com",
    });
    mockProvider.getThreadHistory = async () => [
      {
        messageId: "turn-0",
        senderId: "u-alice",
        senderName: "Alice",
        text: "here is the deck",
        timestamp: new Date(Date.now() - 120_000),
        isFromBot: false,
        files: [
          {
            url: "https://files.slack.com/files-pri/T123/deck.pdf",
            mimetype: "application/pdf",
            name: "deck.pdf",
            size: 1024,
          },
        ],
      },
      {
        messageId: "turn-1",
        senderId: "u-bob",
        senderName: "Bob",
        text: "and the budget sheet",
        timestamp: new Date(Date.now() - 60_000),
        isFromBot: false,
        files: [
          {
            url: "https://files.slack.com/files-pri/T123/budget.xlsx",
            mimetype: "application/vnd.ms-excel",
            name: "budget.xlsx",
            size: 2048,
          },
        ],
      },
    ];
    // Outcomes are positionally aligned with the input files: the deck is
    // delivered, the sheet is skipped by the provider.
    mockProvider.downloadFiles = async () => [
      { status: "delivered", attachment: deliveredDeck },
      { status: "skipped", skipped: skippedSheet },
    ];

    const manager = new ChatOpsManager();
    (
      manager as unknown as { msTeamsProvider: ChatOpsProvider }
    ).msTeamsProvider = mockProvider;

    const result = await manager.processMessage({
      message: createMockMessage({
        threadId: "thread-123",
        isThreadReply: true,
        text: "summarize both files",
      }),
      provider: mockProvider,
    });

    expect(result.success).toBe(true);
    const skipRunLines = executorSpy.mock.calls[0][0].message.split("\n");
    // The note lands on the turn the skipped file came from...
    expect(skipRunLines).toContain(
      `Bob: and the budget sheet${buildHistorySkippedAttachmentsNote([skippedSheet])}`,
    );
    // ...while the delivered file's turn stays untouched.
    expect(skipRunLines).toContain("Alice: here is the deck");
    // Only the delivered attachment reaches the agent.
    expect(executorSpy.mock.calls[0][0].attachments).toEqual([
      expect.objectContaining({ name: "deck.pdf" }),
    ]);

    // Re-run the same thread with everything delivered: skips must not add
    // or remove any lines — the note attaches to an existing turn.
    mockProvider.downloadFiles = async () => [
      { status: "delivered", attachment: deliveredDeck },
      { status: "delivered", attachment: deliveredSheet },
    ];
    await manager.processMessage({
      message: createMockMessage({
        messageId: "test-attach-msg-2",
        threadId: "thread-123",
        isThreadReply: true,
        text: "summarize both files",
      }),
      provider: mockProvider,
    });
    const noSkipRunLines = executorSpy.mock.calls[1][0].message.split("\n");
    expect(skipRunLines.length).toBe(noSkipRunLines.length);
  });

  test("leaves history lines untouched when every file is delivered", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeInternalAgent,
  }) => {
    const executorSpy = vi
      .spyOn(a2aExecutor, "executeA2AMessage")
      .mockResolvedValue({
        text: "ok",
        messageId: "msg-no-skip",
        finishReason: "stop",
        responseUiMessage: {
          id: "msg-no-skip",
          role: "assistant",
          parts: [{ type: "text", text: "ok" }],
        },
      });

    const user = await makeUser({ email: "no-skip-history@example.com" });
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    await makeTeamMember(team.id, user.id);
    const agent = await makeInternalAgent({
      organizationId: org.id,
      teams: [team.id],
    });
    await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);

    await ChatOpsChannelBindingModel.create({
      organizationId: org.id,
      provider: "ms-teams",
      channelId: "test-channel-id",
      workspaceId: "test-workspace-id",
      agentId: agent.id,
    });

    const historyWithFiles: ChatThreadMessage[] = [
      {
        messageId: "turn-0",
        senderId: "u-alice",
        senderName: "Alice",
        text: "here is the deck",
        timestamp: new Date(Date.now() - 60_000),
        isFromBot: false,
        files: [
          {
            url: "https://files.slack.com/files-pri/T123/deck.pdf",
            mimetype: "application/pdf",
            name: "deck.pdf",
            size: 1024,
          },
        ],
      },
      {
        messageId: "turn-1",
        senderId: "bot",
        senderName: "Bot",
        text: "Got it.",
        timestamp: new Date(Date.now() - 30_000),
        isFromBot: true,
      },
    ];

    const mockProvider = createMockProvider({
      getUserEmail: async () => "no-skip-history@example.com",
    });
    mockProvider.getThreadHistory = async () => historyWithFiles;
    mockProvider.downloadFiles = async () => [
      {
        status: "delivered",
        attachment: {
          contentType: "application/pdf",
          contentBase64: Buffer.alloc(10_000).toString("base64"),
          name: "deck.pdf",
        },
      },
    ];

    const manager = new ChatOpsManager();
    (
      manager as unknown as { msTeamsProvider: ChatOpsProvider }
    ).msTeamsProvider = mockProvider;

    const result = await manager.processMessage({
      message: createMockMessage({
        threadId: "thread-123",
        isThreadReply: true,
        text: "what did Alice share?",
      }),
      provider: mockProvider,
    });
    expect(result.success).toBe(true);

    // The same thread without any files must produce the exact same prompt
    // text: fully delivered files add no notes and no guidance line.
    mockProvider.getThreadHistory = async () =>
      historyWithFiles.map(({ files: _files, ...msg }) => msg);
    await manager.processMessage({
      message: createMockMessage({
        messageId: "test-attach-msg-2",
        threadId: "thread-123",
        isThreadReply: true,
        text: "what did Alice share?",
      }),
      provider: mockProvider,
    });

    expect(executorSpy.mock.calls[0][0].message).toBe(
      executorSpy.mock.calls[1][0].message,
    );
  });

  test("renders a file-only history turn as an attachment line and appends its skip note there", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeInternalAgent,
  }) => {
    const executorSpy = vi
      .spyOn(a2aExecutor, "executeA2AMessage")
      .mockResolvedValue({
        text: "ok",
        messageId: "msg-file-only",
        finishReason: "stop",
        responseUiMessage: {
          id: "msg-file-only",
          role: "assistant",
          parts: [{ type: "text", text: "ok" }],
        },
      });

    const user = await makeUser({ email: "file-only-turn@example.com" });
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    await makeTeamMember(team.id, user.id);
    const agent = await makeInternalAgent({
      organizationId: org.id,
      teams: [team.id],
    });
    await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);

    await ChatOpsChannelBindingModel.create({
      organizationId: org.id,
      provider: "ms-teams",
      channelId: "test-channel-id",
      workspaceId: "test-workspace-id",
      agentId: agent.id,
    });

    const mockProvider = createMockProvider({
      getUserEmail: async () => "file-only-turn@example.com",
    });
    mockProvider.getThreadHistory = async () => [
      {
        messageId: "file-only-msg",
        senderId: "u-alice",
        senderName: "Alice",
        text: "",
        timestamp: new Date(Date.now() - 60_000),
        isFromBot: false,
        files: [
          {
            url: "https://files.slack.com/files-pri/T123/photo.png",
            mimetype: "image/png",
            name: "photo.png",
            size: 1024,
          },
        ],
      },
    ];
    mockProvider.downloadFiles = async () => [
      {
        status: "delivered",
        attachment: {
          contentType: "image/png",
          contentBase64: Buffer.alloc(5_000).toString("base64"),
          name: "photo.png",
        },
      },
    ];

    const manager = new ChatOpsManager();
    (
      manager as unknown as { msTeamsProvider: ChatOpsProvider }
    ).msTeamsProvider = mockProvider;

    const result = await manager.processMessage({
      message: createMockMessage({
        threadId: "thread-123",
        isThreadReply: true,
        text: "what is in the photo?",
      }),
      provider: mockProvider,
    });
    expect(result.success).toBe(true);

    // The file-only turn renders as an Alice line naming its attachment
    // (sender and file name are data, not pinned wording; capture the line
    // instead of hardcoding the prose around them).
    const fileOnlyLine = executorSpy.mock.calls[0][0].message
      .split("\n")
      .find(
        (line: string) =>
          line.startsWith("Alice:") && line.includes("photo.png"),
      );
    expect(fileOnlyLine).toBeDefined();

    // When the provider skips that file, the note lands on the same line.
    const skippedPhoto: SkippedAttachment = {
      name: "photo.png",
      sizeBytes: 1024,
      reason: "download_failed",
    };
    mockProvider.downloadFiles = async () => [
      { status: "skipped", skipped: skippedPhoto },
    ];
    await manager.processMessage({
      message: createMockMessage({
        messageId: "test-attach-msg-2",
        threadId: "thread-123",
        isThreadReply: true,
        text: "what is in the photo?",
      }),
      provider: mockProvider,
    });
    expect(executorSpy.mock.calls[1][0].message.split("\n")).toContain(
      `${fileOnlyLine}${buildHistorySkippedAttachmentsNote([skippedPhoto])}`,
    );
  });

  test("does not fetch thread history for a top-level message with a root thread id", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeInternalAgent,
  }) => {
    const executorSpy = vi
      .spyOn(a2aExecutor, "executeA2AMessage")
      .mockResolvedValue({
        text: "Fresh thread response",
        messageId: "msg-fresh",
        finishReason: "stop",
        responseUiMessage: {
          id: "msg-fresh",
          role: "assistant",
          parts: [{ type: "text", text: "Fresh thread response" }],
        },
      });

    const user = await makeUser({ email: "fresh-thread@example.com" });
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    await makeTeamMember(team.id, user.id);
    const agent = await makeInternalAgent({
      organizationId: org.id,
      teams: [team.id],
    });
    await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);

    await ChatOpsChannelBindingModel.create({
      organizationId: org.id,
      provider: "ms-teams",
      channelId: "test-channel-id",
      workspaceId: "test-workspace-id",
      agentId: agent.id,
    });

    const mockProvider = createMockProvider({
      getUserEmail: async () => "fresh-thread@example.com",
    });
    const getThreadHistorySpy = vi.fn().mockResolvedValue([
      {
        messageId: "old-msg",
        senderId: "other-user",
        senderName: "Other User",
        text: "Old context that must not be replayed",
        timestamp: new Date(Date.now() - 60_000),
        isFromBot: false,
      },
    ]);
    mockProvider.getThreadHistory = getThreadHistorySpy;

    const manager = new ChatOpsManager();
    (
      manager as unknown as { msTeamsProvider: ChatOpsProvider }
    ).msTeamsProvider = mockProvider;

    const message = createMockMessage({
      threadId: "root-message-id",
      isThreadReply: false,
      text: "Start a new task",
    });

    const result = await manager.processMessage({
      message,
      provider: mockProvider,
    });

    expect(result.success).toBe(true);
    expect(getThreadHistorySpy).not.toHaveBeenCalled();
    expect(JSON.stringify(executorSpy.mock.calls[0][0].message)).not.toContain(
      "Conversation so far:",
    );
  });

  test("frames thread history as the agent's own, accessible memory", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeInternalAgent,
  }) => {
    const executorSpy = vi
      .spyOn(a2aExecutor, "executeA2AMessage")
      .mockResolvedValue({
        text: "ok",
        messageId: "m",
        finishReason: "stop",
        responseUiMessage: {
          id: "m",
          role: "assistant",
          parts: [{ type: "text", text: "ok" }],
        },
      });

    const user = await makeUser({ email: "thread-history@example.com" });
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    await makeTeamMember(team.id, user.id);
    const agent = await makeInternalAgent({
      organizationId: org.id,
      teams: [team.id],
    });
    await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);
    await ChatOpsChannelBindingModel.create({
      organizationId: org.id,
      provider: "ms-teams",
      channelId: "test-channel-id",
      workspaceId: "test-workspace-id",
      agentId: agent.id,
    });

    const mockProvider = createMockProvider({
      getUserEmail: async () => "thread-history@example.com",
    });
    mockProvider.getThreadHistory = vi.fn().mockResolvedValue([
      {
        messageId: "old-1",
        senderId: "u1",
        senderName: "Joey",
        text: "what's 2+2?",
        timestamp: new Date(Date.now() - 60_000),
        isFromBot: false,
      },
    ]);

    const manager = new ChatOpsManager();
    (
      manager as unknown as { msTeamsProvider: ChatOpsProvider }
    ).msTeamsProvider = mockProvider;

    await manager.processMessage({
      message: createMockMessage({
        threadId: "root-message-id",
        isThreadReply: true,
        text: "what was the math from earlier?",
      }),
      provider: mockProvider,
    });

    const sent = JSON.stringify(executorSpy.mock.calls[0][0].message);
    expect(sent).toContain("Conversation so far:");
    expect(sent).toContain("what's 2+2?");
    // The directive that stops an empty-prompt agent denying it has context.
    expect(sent).toContain("you DO have access to it and remember it");
  });

  test("hands off to swapped chatops agent in the same turn", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeInternalAgent,
  }) => {
    const user = await makeUser({ email: "swap-handoff@example.com" });
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    await makeTeamMember(team.id, user.id);

    const routerAgent = await makeInternalAgent({
      organizationId: org.id,
      name: "Router Agent",
      teams: [team.id],
    });
    await AgentTeamModel.assignTeamsToAgent(routerAgent.id, [team.id]);

    const specialistAgent = await makeInternalAgent({
      organizationId: org.id,
      name: "Specialist Agent",
      teams: [team.id],
    });
    await AgentTeamModel.assignTeamsToAgent(specialistAgent.id, [team.id]);

    const binding = await ChatOpsChannelBindingModel.create({
      organizationId: org.id,
      provider: "ms-teams",
      channelId: "test-channel-id",
      workspaceId: "test-workspace-id",
      agentId: routerAgent.id,
    });

    const executorSpy = vi
      .spyOn(a2aExecutor, "executeA2AMessage")
      .mockImplementation(async (params) => {
        if (params.agentId === routerAgent.id) {
          if (!params.chatOpsThreadId) {
            throw new Error("Expected chatOpsThreadId");
          }
          // Simulate swap_agent creating a thread override
          await ChatOpsThreadAgentOverrideModel.upsert(
            binding.id,
            params.chatOpsThreadId,
            specialistAgent.id,
          );
          return {
            text: "",
            messageId: "router-msg",
            finishReason: "stop",
            responseUiMessage: {
              id: "router-msg",
              role: "assistant",
              parts: [{ type: "text", text: "" }],
            },
          };
        }

        if (params.agentId === specialistAgent.id) {
          return {
            text: "Specialist response",
            messageId: "specialist-msg",
            finishReason: "stop",
            responseUiMessage: {
              id: "specialist-msg",
              role: "assistant",
              parts: [{ type: "text", text: "Specialist response" }],
            },
          };
        }

        throw new Error(`Unexpected agentId: ${params.agentId}`);
      });

    const sendReplySpy = vi.fn().mockResolvedValue("reply-id");
    const mockProvider = createMockProvider({
      getUserEmail: async () => "swap-handoff@example.com",
      sendReply: sendReplySpy,
    });

    const manager = new ChatOpsManager();
    (
      manager as unknown as { msTeamsProvider: ChatOpsProvider }
    ).msTeamsProvider = mockProvider;

    const message = createMockMessage({
      text: "Please route this to the right expert",
    });

    const result = await manager.processMessage({
      message,
      provider: mockProvider,
    });

    expect(result.success).toBe(true);
    expect(result.agentResponse).toBe("Specialist response");

    expect(executorSpy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        agentId: routerAgent.id,
        chatOpsBindingId: binding.id,
      }),
    );
    expect(executorSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        agentId: specialistAgent.id,
        chatOpsBindingId: binding.id,
      }),
    );

    expect(sendReplySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Specialist response",
        footer: `🤖 ${specialistAgent.name}`,
      }),
    );
  });

  test("does not replay swap request into new agent when router replies", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeInternalAgent,
  }) => {
    const user = await makeUser({ email: "swap-reply@example.com" });
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    await makeTeamMember(team.id, user.id);

    const routerAgent = await makeInternalAgent({
      organizationId: org.id,
      name: "Router Agent",
      teams: [team.id],
    });
    await AgentTeamModel.assignTeamsToAgent(routerAgent.id, [team.id]);

    const specialistAgent = await makeInternalAgent({
      organizationId: org.id,
      name: "French Agent",
      teams: [team.id],
    });
    await AgentTeamModel.assignTeamsToAgent(specialistAgent.id, [team.id]);

    const binding = await ChatOpsChannelBindingModel.create({
      organizationId: org.id,
      provider: "ms-teams",
      channelId: "test-channel-id",
      workspaceId: "test-workspace-id",
      agentId: routerAgent.id,
    });

    const executorSpy = vi
      .spyOn(a2aExecutor, "executeA2AMessage")
      .mockImplementation(async (params) => {
        if (params.agentId === routerAgent.id) {
          if (!params.chatOpsThreadId) {
            throw new Error("Expected chatOpsThreadId");
          }
          // Simulate swap_agent creating a thread override
          await ChatOpsThreadAgentOverrideModel.upsert(
            binding.id,
            params.chatOpsThreadId,
            specialistAgent.id,
          );
          return {
            text: "Switched to French Agent. Bonjour!",
            messageId: "router-msg",
            finishReason: "stop",
            responseUiMessage: {
              id: "router-msg",
              role: "assistant",
              parts: [
                { type: "text", text: "Switched to French Agent. Bonjour!" },
              ],
            },
          };
        }

        throw new Error(`Unexpected handoff to agentId: ${params.agentId}`);
      });

    const sendReplySpy = vi.fn().mockResolvedValue("reply-id");
    const mockProvider = createMockProvider({
      getUserEmail: async () => "swap-reply@example.com",
      sendReply: sendReplySpy,
    });

    const manager = new ChatOpsManager();
    (
      manager as unknown as { msTeamsProvider: ChatOpsProvider }
    ).msTeamsProvider = mockProvider;

    const result = await manager.processMessage({
      message: createMockMessage({ text: "switch me to french agent" }),
      provider: mockProvider,
    });

    expect(result.success).toBe(true);
    expect(result.agentResponse).toBe("Switched to French Agent. Bonjour!");
    expect(executorSpy).toHaveBeenCalledTimes(1);

    // Channel binding should NOT be mutated (swap is thread-scoped)
    const updatedBinding = await ChatOpsChannelBindingModel.findById(
      binding.id,
    );
    expect(updatedBinding?.agentId).toBe(routerAgent.id);

    expect(sendReplySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Switched to French Agent. Bonjour!",
        footer: `🤖 ${specialistAgent.name}`,
      }),
    );
  });

  test("thread override persists across turns — second message uses swapped agent", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeInternalAgent,
  }) => {
    const user = await makeUser({ email: "persist-turn@example.com" });
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    await makeTeamMember(team.id, user.id);

    const routerAgent = await makeInternalAgent({
      organizationId: org.id,
      name: "Router Agent",
      teams: [team.id],
    });
    await AgentTeamModel.assignTeamsToAgent(routerAgent.id, [team.id]);

    const specialistAgent = await makeInternalAgent({
      organizationId: org.id,
      name: "Specialist Agent",
      teams: [team.id],
    });
    await AgentTeamModel.assignTeamsToAgent(specialistAgent.id, [team.id]);

    const binding = await ChatOpsChannelBindingModel.create({
      organizationId: org.id,
      provider: "ms-teams",
      channelId: "test-channel-id",
      workspaceId: "test-workspace-id",
      agentId: routerAgent.id,
    });

    // Pre-create a thread override (simulates a swap_agent call in a prior turn)
    await ChatOpsThreadAgentOverrideModel.upsert(
      binding.id,
      "test-channel-id", // effectiveThreadId for a top-level MS Teams message
      specialistAgent.id,
    );

    const executorSpy = vi
      .spyOn(a2aExecutor, "executeA2AMessage")
      .mockResolvedValue({
        text: "Specialist second-turn response",
        messageId: "msg-turn2",
        finishReason: "stop",
        responseUiMessage: {
          id: "msg-turn2",
          role: "assistant",
          parts: [{ type: "text", text: "Specialist second-turn response" }],
        },
      });

    const mockProvider = createMockProvider({
      getUserEmail: async () => "persist-turn@example.com",
    });

    const manager = new ChatOpsManager();
    (
      manager as unknown as { msTeamsProvider: ChatOpsProvider }
    ).msTeamsProvider = mockProvider;

    // Second message in the same thread — no swap, just a follow-up
    const message = createMockMessage({
      text: "follow up question",
    });

    const result = await manager.processMessage({
      message,
      provider: mockProvider,
    });

    expect(result.success).toBe(true);

    // The A2A call should use the specialist agent (from the thread override),
    // not the router agent (channel binding default)
    expect(executorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: specialistAgent.id,
        chatOpsBindingId: binding.id,
      }),
    );

    // Channel binding should still point to the router
    const unchangedBinding = await ChatOpsChannelBindingModel.findById(
      binding.id,
    );
    expect(unchangedBinding?.agentId).toBe(routerAgent.id);
  });
});

describe("buildChatOpsSessionId", () => {
  test("uses threadId when provided", () => {
    expect(buildChatOpsSessionId("slack", "C123", "T456")).toBe(
      "chatops:slack:T456",
    );
  });

  test("falls back to channelId when threadId is undefined", () => {
    expect(buildChatOpsSessionId("slack", "C123")).toBe("chatops:slack:C123");
  });

  test("uses ms-teams provider ID", () => {
    expect(buildChatOpsSessionId("ms-teams", "CH1", "TH1")).toBe(
      "chatops:ms-teams:TH1",
    );
  });

  test("uses channelId for non-threaded ms-teams message", () => {
    expect(buildChatOpsSessionId("ms-teams", "CH1")).toBe(
      "chatops:ms-teams:CH1",
    );
  });

  test("hashes long MS Teams DM channel IDs to stay within exemplar budget", () => {
    const longChannelId =
      "a:15T7kNVP8YbByYGI_Fpc-Ci4cqqlrOfJiumEhUcnvNEZtyranEbXyAUqrNC9jGpSyulMgLurq6nD51ASEEq7sXfK3zetvCvC_XYj37IVz-tFUihy9HjP6YdqWnMw0URwu";
    const result = buildChatOpsSessionId("ms-teams", longChannelId);

    expect(result).toMatch(/^chatops:ms-teams:[a-f0-9]{16}$/);
    expect(result.length).toBeLessThanOrEqual(58);
  });

  test("hashes the same long channel ID to a stable session ID", () => {
    const longChannelId =
      "a:15T7kNVP8YbByYGI_Fpc-Ci4cqqlrOfJiumEhUcnvNEZtyranEbXyAUqrNC9jGpSyulMgLurq6nD51ASEEq7sXfK3zetvCvC_XYj37IVz-tFUihy9HjP6YdqWnMw0URwu";
    expect(buildChatOpsSessionId("ms-teams", longChannelId)).toBe(
      buildChatOpsSessionId("ms-teams", longChannelId),
    );
  });
});
