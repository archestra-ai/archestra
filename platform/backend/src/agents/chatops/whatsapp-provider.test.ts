import { createHmac } from "node:crypto";
import { vi } from "vitest";
import { beforeEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import type { IncomingChatMessage } from "@/types";
import { normalizePhoneNumber, WhatsAppProvider } from "./whatsapp-provider";

setupTestCacheManager();

const PHONE_NUMBER_ID = "phone-123456";
const ACCESS_TOKEN = "test-access-token-wa";
const VERIFY_TOKEN = "my-verify-token-xyz";
const APP_SECRET = "whatsapp-app-secret-test";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function makeProvider(
  overrides: Record<string, unknown> = {},
): WhatsAppProvider {
  return new WhatsAppProvider({
    enabled: true,
    phoneNumberId: PHONE_NUMBER_ID,
    accessToken: ACCESS_TOKEN,
    verifyToken: VERIFY_TOKEN,
    appSecret: APP_SECRET,
    phoneEmailMappings: [
      { phone: "+1 (555) 123-4567", email: "alice@example.com" },
      { phone: "447123456789", email: "bob@example.com" },
    ],
    ...overrides,
  });
}

describe("WhatsAppProvider", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  describe("Configuration & Identity", () => {
    test("isConfigured returns true when required fields are present", () => {
      const provider = makeProvider();
      expect(provider.isConfigured()).toBe(true);
      expect(provider.providerId).toBe("whatsapp");
      expect(provider.displayName).toBe("WhatsApp");
      expect(provider.usesServerSideSessions).toBe(true);
    });

    test("isConfigured returns false when disabled or missing credentials", () => {
      expect(makeProvider({ enabled: false }).isConfigured()).toBe(false);
      expect(makeProvider({ phoneNumberId: undefined }).isConfigured()).toBe(
        false,
      );
      expect(makeProvider({ accessToken: undefined }).isConfigured()).toBe(
        false,
      );
      expect(makeProvider({ verifyToken: undefined }).isConfigured()).toBe(
        false,
      );
    });

    test("normalizePhoneNumber normalizes different phone formats and suffixes", () => {
      expect(normalizePhoneNumber("+1 (555) 123-4567")).toBe("15551234567");
      expect(normalizePhoneNumber("15551234567@s.whatsapp.net")).toBe(
        "15551234567",
      );
      expect(normalizePhoneNumber("44-7123-456789@c.us")).toBe("447123456789");
      expect(normalizePhoneNumber("12345@g.us")).toBe("12345");
      expect(normalizePhoneNumber("")).toBe("");
    });

    test("getUserEmail resolves user email from phone mappings", async () => {
      const provider = makeProvider();
      expect(await provider.getUserEmail("15551234567")).toBe(
        "alice@example.com",
      );
      expect(await provider.getUserEmail("+15551234567")).toBe(
        "alice@example.com",
      );
      expect(await provider.getUserEmail("15551234567@s.whatsapp.net")).toBe(
        "alice@example.com",
      );
      expect(await provider.getUserEmail("447123456789")).toBe(
        "bob@example.com",
      );
      expect(await provider.getUserEmail("999999999")).toBeNull();
    });

    test("identityVerificationFailureText returns helpful guidance", () => {
      const provider = makeProvider();
      expect(provider.identityVerificationFailureText()).toContain(
        "phone number is not linked",
      );
    });
  });

  describe("Webhook Challenge & Verification", () => {
    test("handleValidationChallenge returns hub.challenge when token matches", () => {
      const provider = makeProvider();
      const challenge = "test-challenge-12345";
      const result = provider.handleValidationChallenge({
        "hub.mode": "subscribe",
        "hub.verify_token": VERIFY_TOKEN,
        "hub.challenge": challenge,
      });
      expect(result).toBe(challenge);
    });

    test("handleValidationChallenge rejects mismatched token or mode", () => {
      const provider = makeProvider();
      expect(
        provider.handleValidationChallenge({
          "hub.mode": "subscribe",
          "hub.verify_token": "wrong-token",
          "hub.challenge": "123",
        }),
      ).toBeNull();

      expect(
        provider.handleValidationChallenge({
          "hub.mode": "other",
          "hub.verify_token": VERIFY_TOKEN,
          "hub.challenge": "123",
        }),
      ).toBeNull();
    });

    test("validateWebhookRequest verifies valid HMAC SHA-256 signature", async () => {
      const provider = makeProvider();
      const rawBody = JSON.stringify({ entry: [] });
      const hash = createHmac("sha256", APP_SECRET)
        .update(rawBody)
        .digest("hex");
      const headers = { "x-hub-signature-256": `sha256=${hash}` };

      const isValid = await provider.validateWebhookRequest(rawBody, headers);
      expect(isValid).toBe(true);
    });

    test("validateWebhookRequest rejects invalid signature or missing header", async () => {
      const provider = makeProvider();
      const rawBody = JSON.stringify({ entry: [] });

      expect(
        await provider.validateWebhookRequest(rawBody, {
          "x-hub-signature-256": "sha256=invalidhash123",
        }),
      ).toBe(false);

      expect(await provider.validateWebhookRequest(rawBody, {})).toBe(false);
      expect(
        await provider.validateWebhookRequest(rawBody, {
          "x-hub-signature-256": "malformed",
        }),
      ).toBe(false);
    });
  });

  describe("Message Parsing", () => {
    test("parseWebhookNotification extracts 1:1 text message and maps sender email", async () => {
      const provider = makeProvider();
      const payload = {
        object: "whatsapp_business_account",
        entry: [
          {
            id: "WABA_ID",
            changes: [
              {
                field: "messages",
                value: {
                  messaging_product: "whatsapp",
                  metadata: {
                    phone_number_id: PHONE_NUMBER_ID,
                    display_phone_number: "15550001111",
                  },
                  contacts: [
                    {
                      profile: { name: "Alice Smith" },
                      wa_id: "15551234567",
                    },
                  ],
                  messages: [
                    {
                      from: "15551234567",
                      id: "wamid.ABC123XYZ",
                      timestamp: "1700000000",
                      type: "text",
                      text: { body: "Can you analyze this report?" },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const message = await provider.parseWebhookNotification(payload);
      expect(message).not.toBeNull();
      expect(message?.messageId).toBe("wamid.ABC123XYZ");
      expect(message?.channelId).toBe("15551234567");
      expect(message?.workspaceId).toBe("whatsapp");
      expect(message?.senderId).toBe("15551234567");
      expect(message?.senderName).toBe("Alice Smith");
      expect(message?.senderEmail).toBe("alice@example.com");
      expect(message?.text).toBe("Can you analyze this report?");
      expect(message?.isThreadReply).toBe(false);
      expect(message?.metadata?.whatsappMessageId).toBe("wamid.ABC123XYZ");
    });

    test("parseWebhookNotification ignores empty or non-message payloads", async () => {
      const provider = makeProvider();
      expect(await provider.parseWebhookNotification({})).toBeNull();
      expect(
        await provider.parseWebhookNotification({
          entry: [
            { changes: [{ field: "messages", value: { messages: [] } }] },
          ],
        }),
      ).toBeNull();
    });
  });

  describe("Outbound Replies", () => {
    test("sendReply formats and sends message via Meta Graph API", async () => {
      const provider = makeProvider();
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            messaging_product: "whatsapp",
            messages: [{ id: "wamid.OUTBOUND123" }],
          }),
          { status: 200 },
        ),
      );

      const originalMessage: IncomingChatMessage = {
        messageId: "wamid.IN1",
        channelId: "15551234567",
        workspaceId: "whatsapp",
        senderId: "15551234567",
        senderName: "Alice",
        text: "hello",
        rawText: "hello",
        timestamp: new Date(),
        isThreadReply: false,
      };

      const messageId = await provider.sendReply({
        originalMessage,
        text: "Here is the answer.",
        footer: "🤖 Research Agent",
      });

      expect(messageId).toBe("wamid.OUTBOUND123");
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [url, req] = fetchMock.mock.calls[0];
      expect(url).toBe(
        `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      );
      expect(req.headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);

      const body = JSON.parse(req.body);
      expect(body.messaging_product).toBe("whatsapp");
      expect(body.to).toBe("15551234567");
      expect(body.type).toBe("text");
      expect(body.text.body).toContain("Here is the answer.");
      expect(body.text.body).toContain("🤖 Research Agent");
    });

    test("sendReply throws when Graph API returns error", async () => {
      const provider = makeProvider();
      fetchMock.mockResolvedValueOnce(
        new Response("Invalid OAuth access token", { status: 401 }),
      );

      const originalMessage: IncomingChatMessage = {
        messageId: "wamid.IN1",
        channelId: "15551234567",
        workspaceId: "whatsapp",
        senderId: "15551234567",
        senderName: "Alice",
        text: "hello",
        rawText: "hello",
        timestamp: new Date(),
        isThreadReply: false,
      };

      await expect(
        provider.sendReply({
          originalMessage,
          text: "hello",
        }),
      ).rejects.toThrow("WhatsApp API responded with status 401");
    });
  });

  describe("HITL Approvals", () => {
    test("addApprovalRequestForm caches payload and sends interactive button message", async () => {
      const provider = makeProvider();
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ messages: [{ id: "wamid.APP1" }] }), {
          status: 200,
        }),
      );

      const originalMessage: IncomingChatMessage = {
        messageId: "wamid.IN1",
        channelId: "15551234567",
        workspaceId: "whatsapp",
        senderId: "15551234567",
        senderName: "Alice",
        senderEmail: "alice@example.com",
        text: "Run tool",
        rawText: "Run tool",
        timestamp: new Date(),
        isThreadReply: false,
      };

      await provider.addApprovalRequestForm({
        channelId: "15551234567",
        approvalId: "approval-xyz",
        taskId: "task-abc",
        toolName: "deploy_service",
        originalMessage,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, req] = fetchMock.mock.calls[0];
      expect(url).toContain(PHONE_NUMBER_ID);

      const body = JSON.parse(req.body);
      expect(body.type).toBe("interactive");
      expect(body.interactive.type).toBe("button");
      expect(body.interactive.action.buttons).toHaveLength(2);
      expect(body.interactive.action.buttons[0].reply.title).toBe("Approve");
      expect(body.interactive.action.buttons[1].reply.title).toBe("Decline");
    });

    test("updateApprovalRequest sends status update message", async () => {
      const provider = makeProvider();
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ messages: [{ id: "wamid.UPD1" }] }), {
          status: 200,
        }),
      );

      await provider.updateApprovalRequest({
        channelId: "15551234567",
        messageKey: "msg-123",
        toolName: "deploy_service",
        approved: true,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [_url, req] = fetchMock.mock.calls[0];
      const body = JSON.parse(req.body);
      expect(body.type).toBe("text");
      expect(body.text.body).toContain("Approved");
      expect(body.text.body).toContain("deploy_service");
    });
  });

  describe("Typing Status", () => {
    test("setTypingStatus sends reaction indicator", async () => {
      const provider = makeProvider();
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true }), { status: 200 }),
      );

      await provider.setTypingStatus("15551234567", "wamid.M1");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.type).toBe("reaction");
      expect(body.reaction.emoji).toBe("💭");
      expect(body.reaction.message_id).toBe("wamid.M1");
    });

    test("clearTypingStatus removes reaction indicator", async () => {
      const provider = makeProvider();
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true }), { status: 200 }),
      );

      await provider.clearTypingStatus("15551234567", "wamid.M1");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.type).toBe("reaction");
      expect(body.reaction.emoji).toBe("");
    });
  });
});
