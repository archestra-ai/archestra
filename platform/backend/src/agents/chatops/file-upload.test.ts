import { Activity } from "@microsoft/agents-activity";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import { ChatOpsChannelBindingModel } from "@/models";
import { afterEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { useMswServer } from "@/test/msw";
import { chatOpsManager } from "./chatops-manager";
import {
  getFileDeliveryContext,
  rememberFileDeliveryContext,
} from "./file-delivery-context";
import MSTeamsProvider from "./ms-teams-provider";
import TelegramProvider from "./telegram-provider";

describe("provider file uploads", () => {
  setupTestCacheManager();
  const server = useMswServer();
  afterEach(() => vi.restoreAllMocks());
  const bytes = Buffer.from([0, 255, 128, 42]);
  const appId = "22222222-2222-4222-8222-222222222222";
  const teamId = "33333333-3333-4333-8333-333333333333";
  const tenantId = "11111111-1111-4111-8111-111111111111";
  const channelId = "19:channel@thread.tacv2";
  const serviceUrl = "https://smba.trafficmanager.net/amer/";
  const fileUrl = "https://example.sharepoint.com/channel/report.pdf";

  async function telegramBinding(organizationId: string, chatId = "-100123") {
    const binding = await ChatOpsChannelBindingModel.create({
      organizationId,
      provider: "telegram",
      channelId: chatId,
    });
    vi.spyOn(chatOpsManager, "getChatOpsProvider").mockReturnValue(
      new TelegramProvider({ enabled: true, botToken: "123:test-token" }),
    );
    return binding;
  }

  describe("Telegram file delivery through the shared manager", () => {
    for (const [filename, method, field, threadId] of [
      ["video.MP4", "sendVideo", "video", "42"],
      ["report.pdf", "sendDocument", "document", "-100123"],
      ["image.png", "sendDocument", "document", "-100123"],
    ]) {
      test(`posts ${filename} with exact bytes and the correct topic`, async ({
        makeOrganization,
      }) => {
        const org = await makeOrganization();
        const binding = await telegramBinding(org.id);
        let delivered = false;
        server.use(
          http.post(
            `https://api.telegram.org/bot123:test-token/${method}`,
            async ({ request }) => {
              const form = await request.formData();
              expect(form.get("chat_id")).toBe(binding.channelId);
              expect(form.get("message_thread_id")).toBe(
                threadId === "42" ? "42" : null,
              );
              expect(form.get("caption")).toBe("Deliverable");
              const file = form.get(field) as File;
              expect(file.name).toBe(filename);
              expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes);
              expect(form.get("supports_streaming")).toBe(
                field === "video" ? "true" : null,
              );
              delivered = true;
              return HttpResponse.json({
                ok: true,
                result: { message_id: 123 },
              });
            },
          ),
        );
        await chatOpsManager.uploadFileToBindingThread({
          bindingId: binding.id,
          threadId,
          filename,
          data: bytes,
          comment: "Deliverable",
        });
        expect(delivered).toBe(true);
      });
    }

    test("rejects long captions before uploading and does not retry a refused upload", async ({
      makeOrganization,
    }) => {
      const binding = await telegramBinding(
        (await makeOrganization()).id,
        "555",
      );
      const upload = vi.fn(() =>
        HttpResponse.json(
          { ok: false, description: "Forbidden", error_code: 403 },
          { status: 403 },
        ),
      );
      server.use(
        http.post(
          "https://api.telegram.org/bot123:test-token/sendDocument",
          upload,
        ),
      );
      const params = {
        bindingId: binding.id,
        threadId: "555",
        filename: "report.pdf",
        data: bytes,
      };
      await expect(
        chatOpsManager.uploadFileToBindingThread({
          ...params,
          comment: "x".repeat(1025),
        }),
      ).rejects.toThrow("1024");
      expect(upload).not.toHaveBeenCalled();
      await expect(
        chatOpsManager.uploadFileToBindingThread(params),
      ).rejects.toThrow("403");
      expect(upload).toHaveBeenCalledTimes(1);
    });

    test("requires a Telegram message ID before confirming delivery", async ({
      makeOrganization,
    }) => {
      const binding = await telegramBinding((await makeOrganization()).id);
      server.use(
        http.post(
          "https://api.telegram.org/bot123:test-token/sendDocument",
          () => HttpResponse.json({ ok: true }),
        ),
      );
      await expect(
        chatOpsManager.uploadFileToBindingThread({
          bindingId: binding.id,
          threadId: binding.channelId,
          filename: "report.pdf",
          data: bytes,
        }),
      ).rejects.toThrow("did not confirm file delivery");
    });
  });

  async function teamsBinding(
    organizationId: string,
    conversationType = "channel",
  ) {
    const binding = await ChatOpsChannelBindingModel.create({
      organizationId,
      provider: "ms-teams",
      channelId,
      workspaceId: teamId,
    });
    const bot = new MSTeamsProvider({
      enabled: true,
      appId,
      appSecret: "test-secret",
      tenantId,
      graphTenantId: tenantId,
      graphClientId: appId,
      graphClientSecret: "test-secret",
    });
    await bot.initialize();
    vi.spyOn(chatOpsManager, "getChatOpsProvider").mockReturnValue(bot);
    const activity = Activity.fromObject({
      type: "message",
      id: "incoming",
      channelId: "msteams",
      serviceUrl,
      from: { id: "sender" },
      recipient: { id: appId },
      conversation: { id: `${channelId};messageid=root`, conversationType },
    });
    const message = {
      channelId,
      threadId: "root",
      metadata: {
        conversationReference: activity.getConversationReference(),
        authHeader: "do-not-store",
        text: "do-not-store",
      },
    };
    await rememberFileDeliveryContext(binding.id, message);
    return binding;
  }

  function stubMicrosoft() {
    const uploads: { url: string; bytes: Buffer }[] = [];
    const messages: Record<string, unknown>[] = [];
    server.use(
      http.get(
        "https://login.microsoftonline.com/:tenant/v2.0/.well-known/openid-configuration",
        ({ params }) =>
          HttpResponse.json({
            authorization_endpoint: `https://login.microsoftonline.com/${params.tenant}/oauth2/v2.0/authorize`,
            token_endpoint: `https://login.microsoftonline.com/${params.tenant}/oauth2/v2.0/token`,
            issuer: `https://login.microsoftonline.com/${params.tenant}/v2.0`,
          }),
      ),
      http.post(
        "https://login.microsoftonline.com/:tenant/oauth2/v2.0/token",
        () =>
          HttpResponse.json({
            token_type: "Bearer",
            access_token: "test-token",
            expires_in: 3600,
          }),
      ),
      http.get(
        "https://graph.microsoft.com/v1.0/teams/:team/channels/:channel/filesFolder",
        ({ params }) => {
          expect(params.team).toBe(teamId);
          expect(params.channel).toBe(channelId);
          return HttpResponse.json({
            id: "channel-folder",
            parentReference: { driveId: "channel-drive" },
          });
        },
      ),
      http.put(
        "https://graph.microsoft.com/v1.0/drives/:drive/items/:folder/:filename/content",
        async ({ request, params }) => {
          expect(params.drive).toBe("channel-drive");
          expect(params.folder).toBe("channel-folder:");
          uploads.push({
            url: request.url,
            bytes: Buffer.from(await request.arrayBuffer()),
          });
          return HttpResponse.json(
            { id: "uploaded", webUrl: fileUrl },
            { status: 201 },
          );
        },
      ),
      http.post(
        "https://smba.trafficmanager.net/amer/v3/conversations/:chat/activities/:replyId",
        async ({ request, params }) => {
          expect(params.chat).toBe(`${channelId};messageid=root`);
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-token",
          );
          messages.push((await request.json()) as Record<string, unknown>);
          return HttpResponse.json({ id: "posted" });
        },
      ),
    );
    return { uploads, messages };
  }

  describe("Teams file delivery through the shared manager", () => {
    test("keeps initial channel posts separate when their files finish out of order", async ({
      makeOrganization,
    }) => {
      stubMicrosoft();
      const binding = await teamsBinding((await makeOrganization()).id);
      const bot = chatOpsManager.getChatOpsProvider("ms-teams");
      if (!bot) throw new Error("Expected Teams provider");
      const roots = ["1710000000001", "1710000000002"];
      for (const id of roots) {
        const message = await bot.parseWebhookNotification(
          {
            type: "message",
            id,
            text: "Create a report",
            channelId: "msteams",
            serviceUrl,
            from: { id: "sender" },
            recipient: { id: appId },
            conversation: { id: channelId, conversationType: "channel" },
            channelData: {
              team: { aadGroupId: teamId },
              channel: { id: channelId },
            },
          },
          {},
        );
        if (!message) throw new Error("Expected a parsed channel post");
        expect(message.threadId).toBe(id);
        expect(message.isThreadReply).toBe(false);
        await rememberFileDeliveryContext(binding.id, message);
      }
      const destinations: unknown[] = [];
      server.use(
        http.post(
          "https://smba.trafficmanager.net/amer/v3/conversations/:chat/activities/:replyId",
          ({ params }) => {
            expect(params.chat).toBe(channelId);
            destinations.push(params.replyId);
            return HttpResponse.json({ id: "posted" });
          },
        ),
      );
      for (const threadId of [...roots].reverse()) {
        await chatOpsManager.uploadFileToBindingThread({
          bindingId: binding.id,
          threadId,
          filename: "report.pdf",
          data: bytes,
        });
      }
      expect(destinations).toEqual([...roots].reverse());
    });

    test("uploads into the channel folder and posts a card through the bot without replacing earlier files", async ({
      makeOrganization,
    }) => {
      const { uploads, messages } = stubMicrosoft();
      const binding = await teamsBinding((await makeOrganization()).id);
      const params = {
        bindingId: binding.id,
        threadId: "root",
        filename: "report.pdf",
        data: bytes,
        comment: "Deliverable",
      };
      await chatOpsManager.uploadFileToBindingThread(params);
      await chatOpsManager.uploadFileToBindingThread(params);
      expect(uploads).toHaveLength(2);
      expect(uploads[0].bytes).toEqual(bytes);
      expect(uploads[0].url).not.toBe(uploads[1].url);
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({
        type: "message",
        text: "Deliverable",
        from: { id: appId },
        attachments: [
          {
            contentType: "application/vnd.microsoft.card.adaptive",
            content: { actions: [{ type: "Action.OpenUrl", url: fileUrl }] },
          },
        ],
      });
      const stored = await getFileDeliveryContext(binding.id, "root");
      expect(JSON.stringify(stored)).not.toContain("do-not-store");
      await expect(
        chatOpsManager.uploadFileToBindingThread({
          ...params,
          threadId: "another-thread",
        }),
      ).rejects.toThrow("recent message");
      expect(uploads).toHaveLength(2);
    });

    for (const type of ["personal", "groupChat"]) {
      test(`refuses ${type} before writing to channel storage`, async ({
        makeOrganization,
      }) => {
        const { uploads, messages } = stubMicrosoft();
        const binding = await teamsBinding((await makeOrganization()).id, type);
        await expect(
          chatOpsManager.uploadFileToBindingThread({
            bindingId: binding.id,
            threadId: "root",
            filename: "report.pdf",
            data: bytes,
          }),
        ).rejects.toThrow("channel threads only");
        expect(uploads).toHaveLength(0);
        expect(messages).toHaveLength(0);
      });
    }

    test("reports missing file permissions without posting a success card", async ({
      makeOrganization,
    }) => {
      const { messages } = stubMicrosoft();
      const binding = await teamsBinding((await makeOrganization()).id);
      server.use(
        http.put(
          "https://graph.microsoft.com/v1.0/drives/:drive/items/:folder/:filename/content",
          () =>
            HttpResponse.json(
              { error: { message: "sensitive details" } },
              { status: 403 },
            ),
        ),
      );
      await expect(
        chatOpsManager.uploadFileToBindingThread({
          bindingId: binding.id,
          threadId: "root",
          filename: "report.pdf",
          data: bytes,
        }),
      ).rejects.toThrow("Grant the configured Graph application write access");
      expect(messages).toHaveLength(0);
    });

    test("surfaces a denied channel folder lookup before uploading", async ({
      makeOrganization,
    }) => {
      const { uploads, messages } = stubMicrosoft();
      const binding = await teamsBinding((await makeOrganization()).id);
      server.use(
        http.get(
          "https://graph.microsoft.com/v1.0/teams/:team/channels/:channel/filesFolder",
          () =>
            HttpResponse.json(
              { error: { code: "accessDenied", message: "sensitive details" } },
              { status: 403 },
            ),
        ),
      );
      await expect(
        chatOpsManager.uploadFileToBindingThread({
          bindingId: binding.id,
          threadId: "root",
          filename: "report.pdf",
          data: bytes,
        }),
      ).rejects.toThrow(
        "Check the configured Graph application's file permissions",
      );
      expect(uploads).toHaveLength(0);
      expect(messages).toHaveLength(0);
    });

    test("reports a saved file separately from uncertain card delivery without reuploading", async ({
      makeOrganization,
    }) => {
      const { uploads } = stubMicrosoft();
      const binding = await teamsBinding((await makeOrganization()).id);
      server.use(
        http.post(
          "https://smba.trafficmanager.net/amer/v3/conversations/:chat/activities/:replyId",
          () =>
            HttpResponse.json(
              { error: { message: "Forbidden" } },
              { status: 403 },
            ),
        ),
      );
      await expect(
        chatOpsManager.uploadFileToBindingThread({
          bindingId: binding.id,
          threadId: "root",
          filename: "report.pdf",
          data: bytes,
        }),
      ).rejects.toThrow(`Existing file: ${fileUrl}`);
      expect(uploads).toHaveLength(1);
    });
  });
});
