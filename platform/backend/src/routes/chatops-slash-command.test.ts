import fastifyFormbody from "@fastify/formbody";
import { vi } from "vitest";
import { SLACK_SLASH_COMMANDS } from "@/agents/chatops/constants";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import chatopsRoutes from "./chatops";

// =============================================================================
// Mocks — only mock what the route handler directly calls
// =============================================================================

const {
  getUserEmailMock,
  sendReplyMock,
  sendAgentSelectionCardMock,
  validateWebhookRequestMock,
  findByChannelMock,
  findByEmailMock,
  findByIdMock,
} = vi.hoisted(() => ({
  getUserEmailMock: vi.fn(),
  sendReplyMock: vi.fn(),
  sendAgentSelectionCardMock: vi.fn(),
  validateWebhookRequestMock: vi.fn(),
  findByChannelMock: vi.fn(),
  findByEmailMock: vi.fn(),
  findByIdMock: vi.fn(),
}));

vi.mock("@/agents/chatops/chatops-manager", async () => {
  // Use the real SlackProvider.handleSlashCommand so tests exercise actual logic
  const SlackProviderClass = (await import("@/agents/chatops/slack-provider"))
    .default;

  const mockProvider = {
    providerId: "slack",
    displayName: "Slack",
    isConfigured: () => true,
    isSocketMode: () => false,
    validateWebhookRequest: validateWebhookRequestMock,
    handleSlashCommand:
      SlackProviderClass.prototype.handleSlashCommand.bind(null),
    getUserEmail: getUserEmailMock,
    sendReply: sendReplyMock,
    sendAgentSelectionCard: sendAgentSelectionCardMock,
    eventHandler: null,
  };
  // Bind handleSlashCommand so `this` refers to mockProvider
  mockProvider.handleSlashCommand =
    SlackProviderClass.prototype.handleSlashCommand.bind(mockProvider);

  return {
    chatOpsManager: {
      getSlackProvider: vi.fn(() => mockProvider),
      getMSTeamsProvider: vi.fn(() => null),
      getChatOpsProvider: vi.fn(() => null),
      getAccessibleChatopsAgents: vi.fn(() => []),
      processMessage: vi.fn(),
      reinitialize: vi.fn(),
      discoverChannels: vi.fn(),
    },
  };
});

vi.mock("@/agents/utils", () => ({
  isRateLimited: vi.fn(() => false),
}));

vi.mock("@/models", () => ({
  AgentModel: { findById: findByIdMock },
  ChatOpsChannelBindingModel: {
    findByChannel: findByChannelMock,
    upsertByChannel: vi.fn(),
    findByOrganization: vi.fn(() => []),
    deleteByIdAndOrganization: vi.fn(),
    findByIdAndOrganization: vi.fn(),
    update: vi.fn(),
    updateNames: vi.fn(),
    deleteDuplicateBindings: vi.fn(),
  },
  OrganizationModel: { getFirst: vi.fn(() => ({ id: "org-1" })) },
  UserModel: { findByEmail: findByEmailMock },
}));

// =============================================================================
// Helpers
// =============================================================================

function makeSlashCommandBody(
  command: string,
  overrides: Record<string, string> = {},
): string {
  const params = new URLSearchParams({
    command,
    text: "",
    user_id: "U_SENDER",
    user_name: "testuser",
    channel_id: "C12345",
    channel_name: "general",
    team_id: "T12345",
    response_url: "https://hooks.slack.com/commands/T12345/response",
    trigger_id: "trigger123",
    ...overrides,
  });
  return params.toString();
}

async function createApp() {
  const app = createFastifyInstance();
  await app.register(fastifyFormbody);
  await app.register(chatopsRoutes);
  return app;
}

async function injectSlashCommand(
  app: ReturnType<typeof createFastifyInstance>,
  command: string,
) {
  return app.inject({
    method: "POST",
    url: "/api/webhooks/chatops/slack/slash-command",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: makeSlashCommandBody(command),
  });
}

// =============================================================================
// Tests
// =============================================================================

describe("POST /api/webhooks/chatops/slack/slash-command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    validateWebhookRequestMock.mockResolvedValue(true);
    getUserEmailMock.mockResolvedValue("user@test.com");
    findByEmailMock.mockResolvedValue({ id: "user-1", email: "user@test.com" });
    findByChannelMock.mockResolvedValue(null);
    findByIdMock.mockResolvedValue({ id: "agent-1", name: "Test Agent" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("SLACK_SLASH_COMMANDS has expected command names", () => {
    expect(SLACK_SLASH_COMMANDS.SELECT_AGENT).toBe("/archestra-select-agent");
    expect(SLACK_SLASH_COMMANDS.STATUS).toBe("/archestra-status");
    expect(SLACK_SLASH_COMMANDS.HELP).toBe("/archestra-help");
  });

  test("/archestra-help returns ephemeral help message", async () => {
    const app = await createApp();

    const response = await injectSlashCommand(app, "/archestra-help");

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.response_type).toBe("ephemeral");
    expect(json.text).toContain("/archestra-select-agent");
    expect(json.text).toContain("/archestra-status");
    expect(json.text).toContain("/archestra-help");

    await app.close();
  });

  test("/archestra-status returns ephemeral status when no binding", async () => {
    const app = await createApp();

    const response = await injectSlashCommand(app, "/archestra-status");

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.response_type).toBe("ephemeral");
    expect(json.text).toContain("No agent is bound");

    await app.close();
  });

  test("/archestra-status returns agent name when binding exists", async () => {
    findByChannelMock.mockResolvedValueOnce({
      id: "binding-1",
      organizationId: "org-1",
      provider: "slack",
      channelId: "C12345",
      workspaceId: "T12345",
      agentId: "agent-1",
      channelName: null,
      workspaceName: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const app = await createApp();

    const response = await injectSlashCommand(app, "/archestra-status");

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.response_type).toBe("ephemeral");
    expect(json.text).toContain("Test Agent");

    await app.close();
  });

  test("rejects request with invalid signature", async () => {
    validateWebhookRequestMock.mockResolvedValueOnce(false);

    const app = await createApp();

    const response = await injectSlashCommand(app, "/archestra-help");

    expect(response.statusCode).toBe(400);
    const json = response.json();
    expect(json.error.message).toBe("Invalid request signature");

    await app.close();
  });

  test("unknown command returns ephemeral error", async () => {
    const app = await createApp();

    const response = await injectSlashCommand(app, "/archestra-unknown");

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.response_type).toBe("ephemeral");
    expect(json.text).toContain("Unknown command");

    await app.close();
  });

  test("unregistered user gets ephemeral rejection", async () => {
    findByEmailMock.mockResolvedValueOnce(undefined);

    const app = await createApp();

    const response = await injectSlashCommand(app, "/archestra-help");

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.response_type).toBe("ephemeral");
    expect(json.text).toContain("not a registered Archestra user");

    await app.close();
  });

  test("unresolvable email gets ephemeral rejection", async () => {
    getUserEmailMock.mockResolvedValueOnce(null);

    const app = await createApp();

    const response = await injectSlashCommand(app, "/archestra-help");

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.response_type).toBe("ephemeral");
    expect(json.text).toContain("Could not verify your identity");

    await app.close();
  });
});
