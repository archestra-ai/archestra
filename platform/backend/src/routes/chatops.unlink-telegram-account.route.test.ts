import { eq } from "drizzle-orm";
import { vi } from "vitest";
import TelegramProvider from "@/agents/chatops/telegram-provider";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { ChatOpsChannelBindingModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import chatopsRoutes from "./chatops";

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

describe("DELETE /api/chatops/telegram/link", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    vi.clearAllMocks();
    organizationId = (await makeOrganization()).id;
    user = await makeUser();

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    registerAuditLogHook(app);
    await app.register(chatopsRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  function linkTelegram(params: { chatId: string; email: string }) {
    return ChatOpsChannelBindingModel.create({
      organizationId,
      provider: "telegram",
      channelId: params.chatId,
      isDm: true,
      dmOwnerEmail: params.email,
      channelName: `Direct Message - ${params.email}`,
      agentId: null,
    });
  }

  function unlink() {
    return app.inject({ method: "DELETE", url: "/api/chatops/telegram/link" });
  }

  test("removes only the caller's own Telegram link and records an audit entry", async () => {
    const own = await linkTelegram({ chatId: "1001", email: user.email });
    const other = await linkTelegram({
      chatId: "2002",
      email: "someone-else@example.com",
    });

    const response = await unlink();

    expect(response.statusCode).toBe(200);
    expect(await ChatOpsChannelBindingModel.findById(own.id)).toBeNull();
    expect(await ChatOpsChannelBindingModel.findById(other.id)).not.toBeNull();
    expect(sendDirectMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "1001" }),
    );

    const [row] = await db
      .select()
      .from(schema.auditLogsTable)
      .where(eq(schema.auditLogsTable.resourceId, own.id));
    expect(row).toMatchObject({
      action: "chatOpsBinding.deleted",
      resourceType: "chatOpsBinding",
      outcome: "success",
      after: null,
    });
    expect(row.before).toMatchObject({
      channelId: "1001",
      dmOwnerEmail: user.email,
      provider: "telegram",
    });
  });

  test("the bot no longer resolves the unlinked Telegram user to the account", async () => {
    await linkTelegram({ chatId: "1001", email: user.email });
    const provider = new TelegramProvider({ enabled: true, botToken: "test" });
    expect(await provider.getUserEmail("1001")).toBe(user.email);

    expect((await unlink()).statusCode).toBe(200);

    expect(await provider.getUserEmail("1001")).toBeNull();
  });

  test("returns 404 when the caller has no linked Telegram account", async () => {
    const other = await linkTelegram({
      chatId: "2002",
      email: "someone-else@example.com",
    });
    // A pending DM binding (agent pre-assigned, never linked) is not a link
    await ChatOpsChannelBindingModel.create({
      organizationId,
      provider: "telegram",
      channelId: ChatOpsChannelBindingModel.pendingDmChannelId({
        organizationId,
        dmOwnerEmail: user.email,
      }),
      workspaceId: "dm:pending",
      isDm: true,
      dmOwnerEmail: user.email,
      channelName: `Direct Message - ${user.email}`,
      agentId: null,
    });

    const response = await unlink();

    expect(response.statusCode).toBe(404);
    expect(await ChatOpsChannelBindingModel.findById(other.id)).not.toBeNull();
  });
});
