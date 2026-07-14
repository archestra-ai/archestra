import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { CacheKey, cacheManager } from "@/cache-manager";
import config from "@/config";
import { ChatOpsChannelBindingModel } from "@/models";
import { createFastifyInstance } from "@/server";
import { beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import chatopsRoutes from "./chatops";

vi.mock("@/cache-manager");

const { sendDirectMessageMock } = vi.hoisted(() => ({
  sendDirectMessageMock: vi.fn(async () => {}),
}));

vi.mock("@/agents/chatops/chatops-manager", () => ({
  chatOpsManager: {
    reinitialize: vi.fn(),
    getMSTeamsProvider: vi.fn(() => null),
    getSlackProvider: vi.fn(() => null),
    getTelegramProvider: vi.fn(() => ({
      sendDirectMessage: sendDirectMessageMock,
      getBotUsername: () => "archestra_bot",
    })),
    processMessage: vi.fn(),
    getAccessibleChatopsAgents: vi.fn(),
  },
}));

describe("POST /api/chatops/telegram/link", () => {
  let organizationId: string;
  let user: User;
  let userEmail: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    vi.clearAllMocks();
    config.chatops.telegramEnabled = true;
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();
    userEmail = user.email;
  });

  async function makeApp() {
    const app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
      (request as typeof request & { user: User }).user = user;
    });
    await app.register(chatopsRoutes);
    return app;
  }

  async function seedLinkCode(chatId: string): Promise<string> {
    const code = randomUUID();
    await cacheManager.set(
      `${CacheKey.TelegramLinkCode}-${code}`,
      { chatId },
      60_000,
    );
    return code;
  }

  test("links the Telegram chat to the signed-in user and confirms in Telegram", async () => {
    const app = await makeApp();
    const code = await seedLinkCode("555");

    const response = await app.inject({
      method: "POST",
      url: "/api/chatops/telegram/link",
      payload: { code },
    });

    expect(response.statusCode).toBe(200);
    const binding = await ChatOpsChannelBindingModel.findByChannel({
      provider: "telegram",
      channelId: "555",
      workspaceId: null,
    });
    expect(binding).toMatchObject({ isDm: true, dmOwnerEmail: userEmail });
    expect(sendDirectMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "555" }),
    );

    // The code is one-shot
    const replay = await app.inject({
      method: "POST",
      url: "/api/chatops/telegram/link",
      payload: { code },
    });
    expect(replay.statusCode).toBe(400);

    await app.close();
  });

  test("fulfills an existing pending DM binding instead of creating a duplicate", async () => {
    const pending = await ChatOpsChannelBindingModel.create({
      organizationId,
      provider: "telegram",
      channelId: `dm:pending:${userEmail}`,
      isDm: true,
      dmOwnerEmail: userEmail,
      channelName: `Direct Message - ${userEmail}`,
      agentId: null,
    });

    const app = await makeApp();
    const code = await seedLinkCode("777");

    const response = await app.inject({
      method: "POST",
      url: "/api/chatops/telegram/link",
      payload: { code },
    });

    expect(response.statusCode).toBe(200);
    const fulfilled = await ChatOpsChannelBindingModel.findById(pending.id);
    expect(fulfilled?.channelId).toBe("777");

    await app.close();
  });

  test("refuses a Telegram chat already linked to another user", async () => {
    await ChatOpsChannelBindingModel.create({
      organizationId,
      provider: "telegram",
      channelId: "888",
      isDm: true,
      dmOwnerEmail: "someone-else@example.com",
      channelName: "Direct Message - someone-else@example.com",
      agentId: null,
    });

    const app = await makeApp();
    const code = await seedLinkCode("888");

    const response = await app.inject({
      method: "POST",
      url: "/api/chatops/telegram/link",
      payload: { code },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("another user");

    await app.close();
  });

  test("rejects an unknown or expired code", async () => {
    const app = await makeApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/chatops/telegram/link",
      payload: { code: randomUUID() },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("expired");

    await app.close();
  });

  test("rejects a web-minted code (email payload) — those are redeemed by the bot", async () => {
    const app = await makeApp();
    const code = randomUUID();
    await cacheManager.set(
      `${CacheKey.TelegramLinkCode}-${code}`,
      { email: userEmail },
      60_000,
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/chatops/telegram/link",
      payload: { code },
    });

    expect(response.statusCode).toBe(400);

    await app.close();
  });

  test("mints a one-shot code bound to the signed-in user for the t.me deep link", async () => {
    const app = await makeApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/chatops/telegram/link-code",
    });

    expect(response.statusCode).toBe(200);
    const { code, botUsername } = response.json();
    expect(botUsername).toBe("archestra_bot");
    await expect(
      cacheManager.get(`${CacheKey.TelegramLinkCode}-${code}`),
    ).resolves.toEqual({ email: userEmail });

    await app.close();
  });

  test("rejects linking when the Telegram feature flag is off", async () => {
    config.chatops.telegramEnabled = false;
    const app = await makeApp();
    const code = await seedLinkCode("555");

    const response = await app.inject({
      method: "POST",
      url: "/api/chatops/telegram/link",
      payload: { code },
    });

    expect(response.statusCode).toBe(400);

    await app.close();
  });
});
