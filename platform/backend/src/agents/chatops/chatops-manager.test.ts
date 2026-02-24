import * as a2aExecutor from "@/agents/a2a-executor";
import {
  AgentTeamModel,
  ChatOpsChannelBindingModel,
  ChatOpsConfigModel,
} from "@/models";
import { afterEach, beforeEach, describe, expect, test, vi } from "@/test";
import type {
  ChatOpsProvider,
  ChatReplyOptions,
  IncomingChatMessage,
} from "@/types/chatops";
import {
  ChatOpsManager,
  findTolerantMatchLength,
  matchesAgentName,
} from "./chatops-manager";

describe("findTolerantMatchLength", () => {
  describe("exact matches", () => {
    test("matches exact name with same case", () => {
      expect(findTolerantMatchLength("Agent Peter hello", "Agent Peter")).toBe(
        11,
      );
    });

    test("matches exact name case-insensitively", () => {
      expect(findTolerantMatchLength("agent peter hello", "Agent Peter")).toBe(
        11,
      );
    });

    test("matches at end of string", () => {
      expect(findTolerantMatchLength("Agent Peter", "Agent Peter")).toBe(11);
    });

    test("matches with newline after", () => {
      expect(
        findTolerantMatchLength("Agent Peter\nsome message", "Agent Peter"),
      ).toBe(11);
    });
  });

  describe("space-tolerant matches", () => {
    test("matches name without spaces in text", () => {
      expect(findTolerantMatchLength("AgentPeter hello", "Agent Peter")).toBe(
        10,
      );
    });

    test("matches name without spaces case-insensitively", () => {
      expect(findTolerantMatchLength("agentpeter hello", "Agent Peter")).toBe(
        10,
      );
    });

    test("matches with extra spaces in text", () => {
      expect(findTolerantMatchLength("Agent  Peter hello", "Agent Peter")).toBe(
        12,
      );
    });

    test("matches single word agent name", () => {
      expect(findTolerantMatchLength("Sales hello", "Sales")).toBe(5);
    });
  });

  describe("non-matches", () => {
    test("returns null when name not at start", () => {
      expect(findTolerantMatchLength("Hello Agent Peter", "Agent Peter")).toBe(
        null,
      );
    });

    test("returns null for partial match without word boundary", () => {
      expect(findTolerantMatchLength("AgentPeterX hello", "Agent Peter")).toBe(
        null,
      );
    });

    test("returns null for completely different text", () => {
      expect(findTolerantMatchLength("Hello World", "Agent Peter")).toBe(null);
    });

    test("returns null for partial name match", () => {
      expect(findTolerantMatchLength("Agent hello", "Agent Peter")).toBe(null);
    });

    test("returns null when text is shorter than name", () => {
      expect(findTolerantMatchLength("Age", "Agent Peter")).toBe(null);
    });
  });

  describe("edge cases", () => {
    test("handles empty text", () => {
      expect(findTolerantMatchLength("", "Agent")).toBe(null);
    });

    test("handles single character agent name", () => {
      expect(findTolerantMatchLength("A hello", "A")).toBe(1);
    });

    test("handles agent name with multiple spaces", () => {
      expect(findTolerantMatchLength("John  Doe hello", "John Doe")).toBe(9);
    });

    test("handles mixed case input", () => {
      expect(findTolerantMatchLength("AGENTPETER hello", "Agent Peter")).toBe(
        10,
      );
    });

    test("handles text that is exactly the agent name", () => {
      expect(findTolerantMatchLength("Sales", "Sales")).toBe(5);
    });
  });
});

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

  test("matches with spaces in both", () => {
    expect(matchesAgentName("Agent Peter", "Agent Peter")).toBe(true);
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
      sendAgentSelectionCard: async () => {},
      getThreadHistory: async () => [],
      getUserEmail: overrides.getUserEmail ?? (async () => null),
      getWorkspaceId: () => null,
      getWorkspaceName: () => null,
      discoverChannels: async () => null,
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

  test("rejects when user email not found in Archestra", async ({
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

    expect(result.success).toBe(false);
    expect(result.error).toContain("not a registered Archestra user");
    // Should send error reply with the email address
    expect(sendReplySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("unknown@external.com"),
      }),
    );
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
    });
    await AgentTeamModel.assignTeamsToAgent(accessibleAgent.id, [team.id]);

    // Agent the user does NOT have access to (different team)
    const otherUser = await makeUser({ email: "other@example.com" });
    const otherTeam = await makeTeam(org.id, otherUser.id);
    const inaccessibleAgent = await makeInternalAgent({
      organizationId: org.id,
      name: "Inaccessible Agent",
    });
    await AgentTeamModel.assignTeamsToAgent(inaccessibleAgent.id, [
      otherTeam.id,
    ]);

    const manager = new ChatOpsManager();
    const agents = await manager.getAccessibleChatopsAgents({
      senderEmail: "teamuser@example.com",
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
    const agents = await manager.getAccessibleChatopsAgents({});

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
    });

    // Admin should see all agents
    expect(agents.some((a) => a.id === agent.id)).toBe(true);
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
});
