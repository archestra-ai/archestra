import { createHmac, randomUUID } from "node:crypto";
import { vi } from "vitest";
import { CacheKey, cacheManager } from "@/cache-manager";
import { ChatOpsChannelBindingModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import type { ChatOpsEventHandler, IncomingChatMessage } from "@/types";
import { CHATOPS_ATTACHMENT_LIMITS } from "./constants";
import WhatsAppProvider from "./whatsapp-provider";

setupTestCacheManager();

const ACCESS_TOKEN = "EAAB-test-access-token";
const PHONE_NUMBER_ID = "109876543210";
const APP_SECRET = "whatsapp-test-app-secret";
const VERIFY_TOKEN = "whatsapp-test-verify-token";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function signPayload(rawBody: string, secret = APP_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
}

function makeProvider(eventHandler?: ChatOpsEventHandler): WhatsAppProvider {
  const provider = new WhatsAppProvider({
    enabled: true,
    accessToken: ACCESS_TOKEN,
    phoneNumberId: PHONE_NUMBER_ID,
    appSecret: APP_SECRET,
    verifyToken: VERIFY_TOKEN,
    displayPhoneNumber: "+1 (555) 010-9999",
  });
  if (eventHandler) provider.setEventHandler(eventHandler);
  return provider;
}

function makeEventHandler(): ChatOpsEventHandler {
  return {
    handleIncomingMessage: vi.fn(async () => {}),
    handleInteractiveApprovalDecision: vi.fn(async () => {}),
    handleInteractiveSelection: vi.fn(async () => {}),
    getAccessibleChatopsAgents: vi.fn(async () => []),
  };
}

function webhookEnvelope(
  message: Record<string, unknown>,
  options?: { phoneNumberId?: string; contactName?: string },
) {
  const from = String(message.from ?? "15551234567");
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "15550109999",
                phone_number_id: options?.phoneNumberId ?? PHONE_NUMBER_ID,
              },
              contacts: [
                {
                  wa_id: from,
                  profile: { name: options?.contactName ?? "Alice Rivera" },
                },
              ],
              messages: [
                {
                  id: "wamid.msg-1",
                  from,
                  timestamp: "1700000000",
                  type: "text",
                  text: { body: "Hello agent" },
                  ...message,
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

describe("WhatsAppProvider webhook security", () => {
  test("validates X-Hub-Signature-256 HMAC-SHA256 signatures in constant time", async () => {
    const provider = makeProvider();
    const raw = JSON.stringify(webhookEnvelope({}));

    expect(
      await provider.validateWebhookRequest(raw, {
        "x-hub-signature-256": signPayload(raw),
      }),
    ).toBe(true);

    expect(
      await provider.validateWebhookRequest(`${raw} `, {
        "x-hub-signature-256": signPayload(raw),
      }),
    ).toBe(false);

    expect(
      await provider.validateWebhookRequest(raw, {
        "x-hub-signature-256": signPayload(raw, "wrong-secret"),
      }),
    ).toBe(false);

    expect(await provider.validateWebhookRequest(raw, {})).toBe(false);
  });

  test("verifies hub.verify_token challenge on GET subscription setup", () => {
    const provider = makeProvider();

    expect(
      provider.handleValidationChallenge({
        "hub.mode": "subscribe",
        "hub.verify_token": VERIFY_TOKEN,
        "hub.challenge": "challenge-98765",
      }),
    ).toBe("challenge-98765");

    expect(
      provider.handleValidationChallenge({
        "hub.mode": "subscribe",
        "hub.verify_token": "wrong-token",
        "hub.challenge": "challenge-98765",
      }),
    ).toBeNull();
  });
});

describe("WhatsAppProvider message parsing and attachments", () => {
  test("parses inbound text and quoted reply context", async () => {
    const provider = makeProvider();
    const parsed = await provider.parseWebhookNotification(
      webhookEnvelope({
        id: "wamid.reply-2",
        context: { id: "wamid.root-1" },
        text: { body: "Follow up question" },
      }),
    );

    expect(parsed).toMatchObject({
      messageId: "whatsapp:15551234567:wamid.reply-2",
      channelId: "15551234567",
      workspaceId: null,
      senderId: "15551234567",
      senderName: "Alice Rivera",
      text: "[Replying to message wamid.root-1]\n\nFollow up question",
      rawText: "Follow up question",
      isThreadReply: true,
      metadata: {
        channelType: "im",
        conversationType: "personal",
        whatsappMessageId: "wamid.reply-2",
      },
    });
    expect(parsed?.timestamp).toEqual(new Date(1_700_000_000 * 1000));
  });

  test("ignores events addressed to a different phone_number_id", async () => {
    const provider = makeProvider();
    const parsed = await provider.parseWebhookNotification(
      webhookEnvelope({}, { phoneNumberId: "999999999" }),
    );
    expect(parsed).toBeNull();
  });

  test("downloads media attachments and skips files above MAX_ATTACHMENT_SIZE", async () => {
    const provider = makeProvider();
    const fileBytes = Buffer.from("pdf-binary-content");

    fetchMock.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes("lookaside.fbsbx.com")) {
        return new Response(fileBytes);
      }
      if (u.endsWith("/media-ok")) {
        return new Response(
          JSON.stringify({
            url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/media-ok",
            mime_type: "application/pdf",
            file_size: fileBytes.length,
          }),
        );
      }
      if (u.endsWith("/media-huge")) {
        return new Response(
          JSON.stringify({
            url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/media-huge",
            mime_type: "image/jpeg",
            file_size: CHATOPS_ATTACHMENT_LIMITS.MAX_ATTACHMENT_SIZE + 1024,
          }),
        );
      }
      throw new Error(`Unexpected URL: ${u}`);
    });

    const parsed = await provider.parseWebhookNotification(
      webhookEnvelope({
        type: "document",
        text: undefined,
        document: {
          id: "media-ok",
          filename: "invoice.pdf",
          mime_type: "application/pdf",
          caption: "Please review",
        },
        image: {
          id: "media-huge",
          mime_type: "image/jpeg",
        },
      }),
    );

    expect(parsed?.text).toBe("Please review");
    expect(parsed?.attachments).toEqual([
      {
        name: "invoice.pdf",
        contentType: "application/pdf",
        contentBase64: fileBytes.toString("base64"),
      },
    ]);
    expect(parsed?.skippedAttachments).toEqual([
      {
        name: "image.jpg",
        sizeBytes: CHATOPS_ATTACHMENT_LIMITS.MAX_ATTACHMENT_SIZE + 1024,
        reason: "too_large",
      },
    ]);
  });
});

describe("WhatsAppProvider account linking, interactive selection, and approvals", () => {
  test("links a WhatsApp number via web-minted /start code and resolves user email", async ({
    makeOrganization,
    makeUser,
  }) => {
    await makeOrganization();
    const user = await makeUser({ email: "alice@example.com" });
    const handler = makeEventHandler();
    const provider = makeProvider(handler);

    const sentMessages: Record<string, unknown>[] = [];
    fetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      sentMessages.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({ messages: [{ id: "wamid.out-1" }] }),
      );
    });

    const linkCode = randomUUID();
    await cacheManager.set(
      `${CacheKey.WhatsAppLinkCode}-${linkCode}`,
      { email: user.email },
      60_000,
    );

    await provider.handleWebhookPayload(
      webhookEnvelope({
        from: "15558887777",
        text: { body: `/start ${linkCode}` },
      }),
    );

    expect(await provider.getUserEmail("15558887777")).toBe(user.email);
    expect(sentMessages).toHaveLength(1);
    expect((sentMessages[0].text as { body: string }).body).toContain(
      `Linked to ${user.email}`,
    );

    const binding = await ChatOpsChannelBindingModel.findByChannel({
      provider: "whatsapp",
      channelId: "15558887777",
      workspaceId: null,
    });
    expect(binding?.isDm).toBe(true);
    expect(binding?.dmOwnerEmail).toBe(user.email);
  });

  test("renders button picker for <=3 agents, list picker for >3 agents, and routes selection", async () => {
    const handler = makeEventHandler();
    const provider = makeProvider(handler);
    const payloads: Record<string, unknown>[] = [];

    fetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ messages: [{ id: "wamid.sel" }] }));
    });

    const baseMessage: IncomingChatMessage = {
      messageId: "whatsapp:15551234567:wamid.1",
      channelId: "15551234567",
      workspaceId: null,
      senderId: "15551234567",
      senderName: "Alice Rivera",
      text: "",
      rawText: "",
      timestamp: new Date(),
      isThreadReply: false,
      metadata: { channelType: "im", conversationType: "personal" },
    };

    await provider.sendAgentSelectionCard({
      message: baseMessage,
      agents: [
        { id: "a1", name: "Support Bot" },
        { id: "a2", name: "Finance Bot" },
      ],
      isWelcome: true,
    });
    expect((payloads[0].interactive as { type: string }).type).toBe("button");

    await provider.sendAgentSelectionCard({
      message: baseMessage,
      agents: [
        { id: "a1", name: "Agent 1" },
        { id: "a2", name: "Agent 2" },
        { id: "a3", name: "Agent 3" },
        { id: "a4", name: "Agent 4" },
      ],
      isWelcome: false,
    });
    expect((payloads[1].interactive as { type: string }).type).toBe("list");

    await provider.handleWebhookPayload(
      webhookEnvelope({
        type: "interactive",
        text: undefined,
        interactive: {
          type: "button_reply",
          button_reply: { id: "agent_select|a2", title: "Finance Bot" },
        },
      }),
    );

    expect(handler.handleInteractiveSelection).toHaveBeenCalledTimes(1);
    const parsed = provider.parseInteractivePayload(
      vi.mocked(handler.handleInteractiveSelection).mock.calls[0][1],
    );
    expect(parsed).toMatchObject({
      agentId: "a2",
      channelId: "15551234567",
      userId: "15551234567",
      isDm: true,
    });
  });

  test("enforces requester-only approval guard and dispatches valid approval decisions", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser({ email: "owner@example.com" });
    const intruder = await makeUser({ email: "intruder@example.com" });

    await ChatOpsChannelBindingModel.create({
      organizationId: org.id,
      provider: "whatsapp",
      channelId: "15550001111",
      isDm: true,
      dmOwnerEmail: owner.email,
      channelName: "Direct Message",
      agentId: null,
    });
    await ChatOpsChannelBindingModel.create({
      organizationId: org.id,
      provider: "whatsapp",
      channelId: "15550002222",
      isDm: true,
      dmOwnerEmail: intruder.email,
      channelName: "Direct Message",
      agentId: null,
    });

    const handler = makeEventHandler();
    const provider = makeProvider(handler);
    const outbound: Record<string, unknown>[] = [];

    fetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ messages: [{ id: "wamid.apr" }] }));
    });

    await provider.addApprovalRequestForm({
      taskId: "task-123",
      approvalId: "approval-456",
      toolName: "transfer_funds",
      toolArgs: { amount: 100 },
      senderEmail: owner.email,
      originalMessage: {
        messageId: "whatsapp:15550001111:wamid.orig",
        channelId: "15550001111",
        workspaceId: null,
        senderId: "15550001111",
        senderName: "Owner",
        text: "transfer 100",
        rawText: "transfer 100",
        timestamp: new Date(),
        isThreadReply: false,
        metadata: { channelType: "im", conversationType: "personal" },
      },
    });

    const interactive = outbound[0].interactive as {
      action: { buttons: Array<{ reply: { id: string } }> };
    };
    const approveId = interactive.action.buttons[0].reply.id;

    // Intruder click is rejected without consuming the approval token
    await provider.handleWebhookPayload(
      webhookEnvelope({
        from: "15550002222",
        type: "interactive",
        text: undefined,
        interactive: {
          type: "button_reply",
          button_reply: { id: approveId, title: "Approve" },
        },
      }),
    );
    expect(handler.handleInteractiveApprovalDecision).not.toHaveBeenCalled();

    // Original requester click succeeds
    await provider.handleWebhookPayload(
      webhookEnvelope({
        from: "15550001111",
        type: "interactive",
        text: undefined,
        interactive: {
          type: "button_reply",
          button_reply: { id: approveId, title: "Approve" },
        },
      }),
    );
    expect(handler.handleInteractiveApprovalDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-123",
        approvalId: "approval-456",
        decision: "approved",
        toolName: "transfer_funds",
        approverEmail: owner.email,
      }),
    );
  });

  test("splits long replies across sequential Cloud API text messages and quotes original message", async () => {
    const provider = makeProvider();
    const sent: Record<string, unknown>[] = [];
    let counter = 0;

    fetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      counter += 1;
      return new Response(
        JSON.stringify({ messages: [{ id: `wamid.chunk-${counter}` }] }),
      );
    });

    const longBody = `${"A".repeat(3800)}\n${"B".repeat(500)}`;
    const firstId = await provider.sendReply({
      originalMessage: {
        messageId: "whatsapp:15551234567:wamid.in-9",
        channelId: "15551234567",
        workspaceId: null,
        senderId: "15551234567",
        senderName: "Alice",
        text: "hi",
        rawText: "hi",
        timestamp: new Date(),
        isThreadReply: true,
        metadata: { whatsappMessageId: "wamid.in-9" },
      },
      text: longBody,
      replyInThread: true,
      footer: "🤖 Ops Agent",
    });

    expect(firstId).toBe("wamid.chunk-1");
    expect(sent.length).toBe(2);
    expect(sent[0].context).toEqual({ message_id: "wamid.in-9" });
    expect(sent[1].context).toBeUndefined();
  });
});
