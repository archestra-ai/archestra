import { randomUUID } from "node:crypto";
import fastifyFormbody from "@fastify/formbody";
import { vi } from "vitest";
import { createFastifyInstance } from "@/fastify-instance";
import { ChatOpsChannelBindingModel } from "@/models";
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
  slackProviders,
} = vi.hoisted(() => ({
  getUserEmailMock: vi.fn(),
  getUserNameMock: vi.fn(),
  sendReplyMock: vi.fn(),
  sendAgentSelectionCardMock: vi.fn(),
  sendDirectMessageMock: vi.fn(),
  validateWebhookRequestMock: vi.fn(),
  // The mocked manager's registry of Slack providers, one per bot row. Tests
  // fill it through `registerSlackBot` below.
  slackProviders: {
    byBotId: new Map<string, unknown>(),
    defaultBotId: null as string | null,
    build: null as null | ((botId: string) => unknown),
  },
}));

vi.mock("@/agents/chatops/chatops-manager", async () => {
  // Use the real SlackProvider.handleSlashCommand so tests exercise actual logic
  const SlackProviderClass = (await import("@/agents/chatops/slack-provider"))
    .default;

  // One provider per bot. The real handleSlashCommand is bound to each so the
  // bot id it filters bindings by is the provider's own.
  slackProviders.build = (botId: string) => {
    const provider = {
      botId,
      providerId: "slack",
      displayName: "Slack",
      isConfigured: () => true,
      isSocketMode: () => false,
      validateWebhookRequest: validateWebhookRequestMock,
      handleValidationChallenge: (body: {
        type?: string;
        challenge?: string;
      }) =>
        body.type === "url_verification"
          ? { challenge: `${botId}:${body.challenge}` }
          : null,
      handleSlashCommand: null as unknown,
      getUserEmail: getUserEmailMock,
      sendReply: sendReplyMock,
      sendAgentSelectionCard: sendAgentSelectionCardMock,
      sendEphemeralMessage: vi.fn().mockResolvedValue(undefined),
      sendDirectMessage: sendDirectMessageMock,
      getUserName: getUserNameMock,
      eventHandler: null,
    };
    provider.handleSlashCommand =
      SlackProviderClass.prototype.handleSlashCommand.bind(provider);
    return provider;
  };

  return {
    chatOpsManager: {
      getSlackProvider: (botId: string) =>
        slackProviders.byBotId.get(botId) ?? null,
      getDefaultSlackProvider: () =>
        (slackProviders.defaultBotId &&
          slackProviders.byBotId.get(slackProviders.defaultBotId)) ||
        null,
      getMSTeamsProvider: vi.fn(() => null),
      getProviderForBot: vi.fn(() => null),
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

/** Stands up a mocked Slack provider for a bot row; the first one is Slack App #1. */
function registerSlackBot(botId: string) {
  slackProviders.byBotId.set(botId, slackProviders.build?.(botId));
  slackProviders.defaultBotId ??= botId;
}

async function injectSlashCommand(
  app: ReturnType<typeof createFastifyInstance>,
  command: string,
  url = "/api/webhooks/chatops/slack/slash-command",
) {
  return app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: makeSlashCommandBody(command),
  });
}

// =============================================================================
// Tests
// =============================================================================

describe("POST /api/webhooks/chatops/slack/slash-command", () => {
  let organizationId: string;
  let botId: string;

  beforeEach(async ({ makeOrganization, makeChatOpsBot }) => {
    slackProviders.byBotId.clear();
    slackProviders.defaultBotId = null;
    organizationId = (await makeOrganization()).id;
    botId = (await makeChatOpsBot(organizationId)).id;
    registerSlackBot(botId);

    validateWebhookRequestMock.mockResolvedValue(true);
    getUserEmailMock.mockResolvedValue(REGISTERED_EMAIL);
    getUserNameMock.mockResolvedValue("Test User");
    sendDirectMessageMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("/archestra-help returns ephemeral help message", async ({
    makeUser,
    makeMember,
  }) => {
    const user = await makeUser({ email: REGISTERED_EMAIL });
    await makeMember(user.id, organizationId);

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
    makeUser,
    makeMember,
  }) => {
    const user = await makeUser({ email: REGISTERED_EMAIL });
    await makeMember(user.id, organizationId);

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
    makeUser,
    makeMember,
  }) => {
    const user = await makeUser({ email: REGISTERED_EMAIL });
    await makeMember(user.id, organizationId);

    const app = await createApp();

    const response = await injectSlashCommand(app, "/archestra-status");

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.response_type).toBe("ephemeral");
    expect(json.text).toContain("No agent is assigned");

    await app.close();
  });

  test("/archestra-status returns agent name when binding exists", async ({
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const user = await makeUser({ email: REGISTERED_EMAIL });
    await makeMember(user.id, organizationId);
    const agent = await makeAgent({
      organizationId,
      name: "Test Agent",
    });
    await ChatOpsChannelBindingModel.create({
      organizationId,
      provider: "slack",
      botId,
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
    makeUser,
    makeMember,
  }) => {
    const user = await makeUser({ email: REGISTERED_EMAIL });
    await makeMember(user.id, organizationId);

    const app = await createApp();

    const response = await injectSlashCommand(app, "/archestra-unknown");

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.response_type).toBe("ephemeral");
    expect(json.text).toContain("Unknown command");

    await app.close();
  });

  test("unregistered user is auto-provisioned and can use commands", async () => {
    // Org exists but the sender has no user/member row yet — the real
    // ensureProvisionedUser must create them so the command succeeds.
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
    const membership = await MemberModel.getByUserId(
      provisioned.id,
      organizationId,
    );
    expect(membership).toBeDefined();

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

  test("the legacy URL serves Slack App #1 while a bot URL serves that bot's own bindings", async ({
    makeAgent,
    makeChatOpsBot,
    makeMember,
    makeUser,
  }) => {
    const user = await makeUser({ email: REGISTERED_EMAIL });
    await makeMember(user.id, organizationId);
    const secondBot = await makeChatOpsBot(organizationId);
    registerSlackBot(secondBot.id);
    const firstAppAgent = await makeAgent({
      organizationId,
      name: "First App Agent",
    });
    const secondAppAgent = await makeAgent({
      organizationId,
      name: "Second App Agent",
    });
    // The same Slack channel is bound independently under each app.
    for (const [bindingBotId, agentId] of [
      [botId, firstAppAgent.id],
      [secondBot.id, secondAppAgent.id],
    ]) {
      await ChatOpsChannelBindingModel.create({
        organizationId,
        provider: "slack",
        botId: bindingBotId,
        channelId: "C12345",
        workspaceId: "T12345",
        agentId,
      });
    }

    const app = await createApp();

    const legacy = await injectSlashCommand(app, "/archestra-status");
    const first = await injectSlashCommand(
      app,
      "/archestra-status",
      `/api/webhooks/chatops/slack/bots/${botId}/slash-command`,
    );
    const second = await injectSlashCommand(
      app,
      "/archestra-status",
      `/api/webhooks/chatops/slack/bots/${secondBot.id}/slash-command`,
    );

    expect(legacy.json().text).toContain("First App Agent");
    expect(first.json().text).toContain("First App Agent");
    expect(second.statusCode).toBe(200);
    expect(second.json().text).toContain("Second App Agent");
    expect(second.json().text).not.toContain("First App Agent");

    await app.close();
  });

  test("the Events API URL of a bot resolves that bot's provider", async ({
    makeChatOpsBot,
  }) => {
    const secondBot = await makeChatOpsBot(organizationId);
    registerSlackBot(secondBot.id);
    const app = await createApp();
    const challenge = (url: string) =>
      app.inject({
        method: "POST",
        url,
        payload: { type: "url_verification", challenge: "abc" },
      });

    const legacy = await challenge("/api/webhooks/chatops/slack");
    const bySecondBot = await challenge(
      `/api/webhooks/chatops/slack/bots/${secondBot.id}`,
    );

    // The mocked provider echoes its bot id in the challenge.
    expect(legacy.json()).toEqual({ challenge: `${botId}:abc` });
    expect(bySecondBot.json()).toEqual({ challenge: `${secondBot.id}:abc` });

    await app.close();
  });

  test("an unknown bot id is rejected as not configured on every Slack webhook URL", async () => {
    const app = await createApp();
    const unknownBotId = randomUUID();

    for (const path of ["", "/interactive", "/slash-command"]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/webhooks/chatops/slack/bots/${unknownBotId}${path}`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: makeSlashCommandBody("/archestra-help"),
      });

      expect(response.statusCode, path).toBe(400);
      expect(response.json().error.message).toContain("not configured");
    }
    expect(validateWebhookRequestMock).not.toHaveBeenCalled();

    await app.close();
  });
});
