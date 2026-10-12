import { slackHandleFor } from "@archestra/shared";
import sharp from "sharp";
import { beforeAll, vi } from "vitest";
import { AgentModel, ChatOpsConfigModel, OrganizationModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import { slackAppFactory } from "./slack-app-factory";

// Slack's Web API is the process boundary.
const slack = vi.hoisted(() => ({
  rotate: vi.fn(),
  exportManifest: vi.fn(),
  update: vi.fn(),
  apiCall: vi.fn(),
}));
vi.mock("@slack/web-api", () => ({
  WebClient: class {
    tooling = { tokens: { rotate: slack.rotate } };
    apps = {
      manifest: { export: slack.exportManifest, update: slack.update },
    };
    apiCall = slack.apiCall;
  },
}));

// A small, wide icon: Slack wants a 512–2000 px square.
let PNG_ICON = "";
beforeAll(async () => {
  const png = await sharp({
    create: { width: 100, height: 40, channels: 4, background: "#d97757" },
  })
    .png()
    .toBuffer();
  PNG_ICON = `data:image/png;base64,${png.toString("base64")}`;
});

beforeEach(async () => {
  vi.clearAllMocks();
  slack.rotate.mockImplementation(async ({ refresh_token }) => ({
    ok: true,
    token: `xoxe.xoxp-${refresh_token}`,
    refresh_token: `${refresh_token}-next`,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
  }));
  slack.exportManifest.mockResolvedValue({
    ok: true,
    manifest: {
      display_information: { name: "old", background_color: "#000000" },
      features: { bot_user: { display_name: "old", always_online: true } },
    },
  });
  slack.update.mockResolvedValue({ ok: true });
  slack.apiCall.mockResolvedValue({ ok: true });
  await slackAppFactory.saveConfigToken({
    accessToken: "xoxe.xoxp-pasted",
    refreshToken: "xoxe-1",
  });
});

async function connectManagedBot(
  agentId: string,
  overrides: { handleFollowsAgent?: boolean; syncedAgentName?: string } = {},
) {
  await ChatOpsConfigModel.saveSlackAgentBot({
    agentId,
    enabled: true,
    botToken: "xoxb-bot",
    signingSecret: "s",
    appId: "A_BOT",
    managed: true,
    handleFollowsAgent: true,
    ...overrides,
  });
}

describe("SlackAppFactory.syncAgentIdentity", () => {
  test("renaming the agent renames its bot, keeping the rest of the app", async ({
    makeOrganization,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeInternalAgent({
      organizationId: org.id,
      name: "Marketing",
    });
    await connectManagedBot(agent.id, { syncedAgentName: "Marketing" });
    await AgentModel.update(agent.id, { name: "Growth Team" });

    await slackAppFactory.syncAgentIdentity(agent.id);

    const handle = slackHandleFor(
      await OrganizationModel.getAppName(),
      "Growth Team",
    );
    const { manifest } = slack.update.mock.calls[0][0];
    expect(manifest.display_information).toEqual({
      name: handle,
      background_color: "#000000",
    });
    expect(manifest.features.bot_user).toEqual({
      display_name: handle,
      always_online: true,
    });
    expect(await ChatOpsConfigModel.getSlackAgentBots()).toEqual([
      expect.objectContaining({ syncedAgentName: "Growth Team" }),
    ]);

    // Nothing changed since: no further Slack calls.
    await slackAppFactory.syncAgentIdentity(agent.id);
    expect(slack.update).toHaveBeenCalledTimes(1);
  });

  test("a handle someone picked stays when the agent is renamed", async ({
    makeOrganization,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeInternalAgent({ organizationId: org.id });
    await connectManagedBot(agent.id, {
      handleFollowsAgent: false,
      syncedAgentName: "Before",
    });

    await slackAppFactory.syncAgentIdentity(agent.id);

    expect(slack.update).not.toHaveBeenCalled();
  });

  test("an image icon becomes the app icon, once per change", async ({
    makeOrganization,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeInternalAgent({ organizationId: org.id });
    await AgentModel.update(agent.id, { icon: PNG_ICON });
    await connectManagedBot(agent.id, { syncedAgentName: agent.name });

    await slackAppFactory.syncAgentIdentity(agent.id);
    await slackAppFactory.syncAgentIdentity(agent.id);

    expect(slack.apiCall).toHaveBeenCalledTimes(1);
    const [method, args] = slack.apiCall.mock.calls[0];
    expect(method).toBe("apps.icon.set");
    expect(args.app_id).toBe("A_BOT");
    const uploaded = await sharp(args.file).metadata();
    expect(uploaded).toMatchObject({ format: "png", width: 512, height: 512 });
  });

  test("an emoji icon is left alone: Slack app icons are images", async ({
    makeOrganization,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeInternalAgent({ organizationId: org.id });
    await AgentModel.update(agent.id, { icon: "🚀" });
    await connectManagedBot(agent.id, { syncedAgentName: agent.name });

    await slackAppFactory.syncAgentIdentity(agent.id);

    expect(slack.apiCall).not.toHaveBeenCalled();
  });

  test("a refusal from Slack is kept on the bot and cleared by a later success", async ({
    makeOrganization,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeInternalAgent({ organizationId: org.id });
    await AgentModel.update(agent.id, { icon: PNG_ICON });
    await connectManagedBot(agent.id, { syncedAgentName: agent.name });
    slack.apiCall.mockResolvedValueOnce({
      ok: false,
      error: "invalid_image_dimensions",
    });

    await slackAppFactory.syncAgentIdentity(agent.id);
    expect(await ChatOpsConfigModel.getSlackAgentBots()).toEqual([
      expect.objectContaining({
        identitySyncError: "Icon: invalid_image_dimensions",
      }),
    ]);

    await slackAppFactory.syncAgentIdentity(agent.id);
    const [bot] = await ChatOpsConfigModel.getSlackAgentBots();
    expect(bot.identitySyncError).toBeUndefined();
  });

  test("a bot set up by hand is never changed", async ({
    makeOrganization,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeInternalAgent({ organizationId: org.id });
    await AgentModel.update(agent.id, { icon: PNG_ICON });
    await ChatOpsConfigModel.saveSlackAgentBot({
      agentId: agent.id,
      enabled: true,
      botToken: "xoxb-bot",
      signingSecret: "s",
      appId: "A_HANDMADE",
      handleFollowsAgent: true,
    });

    await slackAppFactory.syncAgentIdentity(agent.id);

    expect(slack.update).not.toHaveBeenCalled();
    expect(slack.apiCall).not.toHaveBeenCalled();
  });
});
