import { createHmac } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { IncomingChatMessage } from "@/types";
import WhatsAppProvider from "./whatsapp-provider";

const APP_SECRET = "test-app-secret";
const VERIFY_TOKEN = "test-verify-token";
const PHONE_NUMBER_ID = "1234567890";
const ACCESS_TOKEN = "test-access-token";

function createProvider(): WhatsAppProvider {
  return new WhatsAppProvider({
    enabled: true,
    accessToken: ACCESS_TOKEN,
    appSecret: APP_SECRET,
    businessAccountId: "waba-123",
    graphApiVersion: "v21.0",
    phoneNumberId: PHONE_NUMBER_ID,
    verifyToken: VERIFY_TOKEN,
    phoneUserMappings: [
      { phoneNumber: "+1 (555) 123-4567", email: "user@example.com" },
    ],
  });
}

function computeMetaSignature(body: string, secret = APP_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function makeTextWebhookPayload(overrides: Record<string, unknown> = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-123",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "15550000000",
                phone_number_id: PHONE_NUMBER_ID,
              },
              contacts: [
                {
                  profile: { name: "Arthur Morgan" },
                  wa_id: "15551234567",
                },
              ],
              messages: [
                {
                  from: "15551234567",
                  id: "wamid.inbound",
                  timestamp: "1779299105",
                  text: { body: "hello from whatsapp" },
                  type: "text",
                },
              ],
              ...overrides,
            },
          },
        ],
      },
    ],
  };
}

function makeOriginalMessage(
  overrides: Partial<IncomingChatMessage> = {},
): IncomingChatMessage {
  return {
    channelId: "15551234567",
    isThreadReply: false,
    messageId: "wamid.inbound",
    rawText: "hello",
    senderId: "15551234567",
    senderName: "Arthur Morgan",
    text: "hello",
    timestamp: new Date("2026-05-20T17:45:05.000Z"),
    workspaceId: "waba-123",
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("WhatsAppProvider.validateWebhookRequest", () => {
  test("valid X-Hub-Signature-256 returns true", async () => {
    const provider = createProvider();
    const body = JSON.stringify(makeTextWebhookPayload());

    const result = await provider.validateWebhookRequest(body, {
      "x-hub-signature-256": computeMetaSignature(body),
    });

    expect(result).toBe(true);
  });

  test("invalid X-Hub-Signature-256 returns false", async () => {
    const provider = createProvider();
    const body = JSON.stringify(makeTextWebhookPayload());

    const result = await provider.validateWebhookRequest(body, {
      "x-hub-signature-256": computeMetaSignature(body, "wrong-secret"),
    });

    expect(result).toBe(false);
  });

  test("missing signature header returns false", async () => {
    const provider = createProvider();

    await expect(provider.validateWebhookRequest("{}", {})).resolves.toBe(
      false,
    );
  });
});

describe("WhatsAppProvider.handleValidationChallenge", () => {
  test("returns Meta challenge when verify token matches", () => {
    const provider = createProvider();

    const result = provider.handleValidationChallenge({
      "hub.challenge": "challenge-token",
      "hub.mode": "subscribe",
      "hub.verify_token": VERIFY_TOKEN,
    });

    expect(result).toBe("challenge-token");
  });

  test("returns null when verify token does not match", () => {
    const provider = createProvider();

    const result = provider.handleValidationChallenge({
      "hub.challenge": "challenge-token",
      "hub.mode": "subscribe",
      "hub.verify_token": "wrong-token",
    });

    expect(result).toBeNull();
  });
});

describe("WhatsAppProvider.parseWebhookNotification", () => {
  test("parses an inbound text message into IncomingChatMessage", async () => {
    const provider = createProvider();

    const result = await provider.parseWebhookNotification(
      makeTextWebhookPayload(),
      {},
    );

    expect(result).toMatchObject({
      channelId: "15551234567",
      isThreadReply: false,
      messageId: "wamid.inbound",
      rawText: "hello from whatsapp",
      senderId: "15551234567",
      senderName: "Arthur Morgan",
      text: "hello from whatsapp",
      workspaceId: "waba-123",
    });
    expect(result?.timestamp.toISOString()).toBe("2026-05-20T17:45:05.000Z");
    expect(result?.metadata).toEqual({
      channelType: "im",
      displayPhoneNumber: "15550000000",
      messageType: "text",
      phoneNumberId: PHONE_NUMBER_ID,
    });
  });

  test("ignores delivery status webhook payloads", async () => {
    const provider = createProvider();
    const payload = makeTextWebhookPayload({
      contacts: undefined,
      messages: undefined,
      statuses: [{ id: "wamid.reply", status: "delivered" }],
    });

    await expect(provider.parseWebhookNotification(payload, {})).resolves.toBe(
      null,
    );
  });
});

describe("WhatsAppProvider.getUserEmail", () => {
  test("resolves sender phone number through configured mappings", async () => {
    const provider = createProvider();

    await expect(provider.getUserEmail("15551234567")).resolves.toBe(
      "user@example.com",
    );
  });

  test("returns null when sender phone number is not mapped", async () => {
    const provider = createProvider();

    await expect(provider.getUserEmail("15550009999")).resolves.toBeNull();
  });
});

describe("WhatsAppProvider.sendReply", () => {
  test("sends a text reply through the Meta Graph API", async () => {
    const provider = createProvider();
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ messages: [{ id: "wamid.reply" }] }),
      ok: true,
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await provider.sendReply({
      originalMessage: makeOriginalMessage(),
      text: "agent response",
    });

    expect(result).toBe("wamid.reply");
    expect(fetchMock).toHaveBeenCalledWith(
      `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
      {
        body: JSON.stringify({
          messaging_product: "whatsapp",
          text: {
            body: "agent response",
            preview_url: false,
          },
          to: "15551234567",
          type: "text",
        }),
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        method: "POST",
      },
    );
  });
});
