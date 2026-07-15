import fastifyFormbody from "@fastify/formbody";
import { vi } from "vitest";
import { ChatOpsChannelBindingModel } from "@/models";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import chatopsRoutes from "./chatops";

// =============================================================================
// Mocks — only the network seams (Slack provider I/O) and the rate-limit gate.
// The real SlackProvider.handleSlashCommand runs against the real PGlite DB,
// real models, and the real ensureProvisionedUser provisioning path.
// =============================================================================

const {
  getUserEmailMock,
  getUserNameMock,
  sendReplyMock,
  sendAgentSelectionCardMock,
  sendDirectMessageMock,
  validateWebhookRequestMock,
} = vi.hoisted(() => ({
  getUserEmailMock: vi.fn(),
  getUserNameMock: vi.fn(),
  sendReplyMock: vi.fn(),
  sendAgentSelectionCardMock: vi.fn(),
  sendDirectMessageMock: vi.fn(),
  validateWebhookRequestMock: vi.fn(),
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
    sendEphemeralMessage: vi.fn().mockResolvedValue(undefined),
    sendDirectMessage: sendDirectMessageMock,
    getUserName: getUserNameMock,
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

// =============================================================================
// Helpers
// =============================================================================

const REGISTERED_EMAIL = "user@test.com";

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
    validateWebhookRequestMock.mockResolvedValue(true);
    getUserEmailMock.mockResolvedValue(REGISTERED_EMAIL);
    getUserNameMock.mockResolvedValue("Test User");
    sendDirectMessageMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("/archestra-help returns ephemeral help message", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser({ email: REGISTERED_EMAIL });
    await makeMember(user.id, org.id);

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

  test("slugified app-name slash commands are accepted", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser({ email: REGISTERED_EMAIL });
    await makeMember(user.id, org.id);

    const app = await createApp();

    const response = await injectSlashCommand(app, "/archestra-staging-help");

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.response_type).toBe("ephemeral");
    expect(json.text).toContain("/archestra-staging-select-agent");
    expect(json.text).toContain("/archestra-staging-status");
    expect(json.text).toContain("/archestra-staging-help");

    await app.close();
  });

  test("/archestra-status returns ephemeral status when no binding", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser({ email: REGISTERED_EMAIL });
    await makeMember(user.id, org.id);

    const app = await createApp();

    const response = await injectSlashCommand(app, "/archestra-status");

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.response_type).toBe("ephemeral");
    expect(json.text).toContain("No agent is assigned");

    await app.close();
  });

  test("/archestra-status returns agent name when binding exists", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser({ email: REGISTERED_EMAIL });
    await makeMember(user.id, org.id);
    const agent = await makeAgent({
      organizationId: org.id,
      name: "Test Agent",
    });
    await ChatOpsChannelBindingModel.create({
      organizationId: org.id,
      provider: "slack",
      channelId: "C12345",
      workspaceId: "T12345",
      agentId: agent.id,
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

  test("unknown command returns ephemeral error", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser({ email: REGISTERED_EMAIL });
    await makeMember(user.id, org.id);

    const app = await createApp();

    const response = await injectSlashCommand(app, "/archestra-unknown");

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.response_type).toBe("ephemeral");
    expect(json.text).toContain("Unknown command");

    await app.close();
  });

  test("unregistered user is auto-provisioned and can use commands", async ({
    makeOrganization,
  }) => {
    // Org exists but the sender has no user/member row yet — the real
    // ensureProvisionedUser must create them so the command succeeds.
    const org = await makeOrganization();
    getUserEmailMock.mockResolvedValue("newcomer@example.com");

    const app = await createApp();

    const response = await injectSlashCommand(app, "/archestra-help");

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.response_type).toBe("ephemeral");
    // Should get the help text, not a rejection
    expect(json.text).toContain("Available commands");

    // The provisioning path created a real user + member in the org.
    const { UserModel, MemberModel } = await import("@/models");
    const provisioned = await UserModel.findByEmail("newcomer@example.com");
    if (!provisioned) throw new Error("expected a provisioned user");
    const membership = await MemberModel.getByUserId(provisioned.id, org.id);
    expect(membership).toBeDefined();

    await app.close();
  });

  test("unresolvable email gets ephemeral rejection", async ({
    makeOrganization,
  }) => {
    await makeOrganization();
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
