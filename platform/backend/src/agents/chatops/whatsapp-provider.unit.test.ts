import { createHmac } from "node:crypto";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WhatsAppDbConfig } from "@/types";

const {
  mockFindByChannel,
  mockHandleIncomingMessage,
  mockHandleInteractiveSelection,
  mockGetWhatsAppProvider,
  mockIsRateLimited,
} = vi.hoisted(() => ({
  mockFindByChannel: vi.fn(),
  mockHandleIncomingMessage: vi.fn(),
  mockHandleInteractiveSelection: vi.fn(),
  mockGetWhatsAppProvider: vi.fn(),
  mockIsRateLimited: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/models", () => ({
  AgentModel: {},
  ChatOpsChannelBindingModel: {
    findByChannel: mockFindByChannel,
  },
  ChatOpsConfigModel: {},
  InvitationModel: {},
  OrganizationModel: {},
  UserModel: {},
}));

vi.mock("@/agents/chatops/chatops-manager", () => ({
  chatOpsManager: {
    getWhatsAppProvider: mockGetWhatsAppProvider,
    handleIncomingMessage: mockHandleIncomingMessage,
    handleInteractiveSelection: mockHandleInteractiveSelection,
  },
}));

vi.mock("@/agents/utils", () => ({
  isRateLimited: mockIsRateLimited,
}));

import { whatsappWebhookRoutes } from "@/routes/chatops";
import WhatsAppProvider from "./whatsapp-provider";

const TEST_CONFIG: WhatsAppDbConfig = {
  enabled: true,
  accessToken: "test-access-token",
  phoneNumberId: "109876543210",
  verifyToken: "my-secret-verify-token",
  appSecret: "my-meta-app-secret",
  businessAccountId: "998877665544",
};

function signPayload(rawBody: string, secret = TEST_CONFIG.appSecret): string {
  const hex = createHmac("sha256", secret).update(rawBody).digest("hex");
  return `sha256=${hex}`;
}

function createTextWebhookPayload(overrides?: {
  phoneNumberId?: string;
  from?: string;
  messageId?: string;
  text?: string;
  name?: string;
}) {
  const from = overrides?.from ?? "905551234567";
  const phoneNumberId = overrides?.phoneNumberId ?? TEST_CONFIG.phoneNumberId;
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "998877665544",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "+15550001234",
                phone_number_id: phoneNumberId,
              },
              contacts: [
                {
                  profile: { name: overrides?.name ?? "Ada Lovelace" },
                  wa_id: from,
                },
              ],
              messages: [
                {
                  from,
                  id: overrides?.messageId ?? "wamid.HBgMOTA1NTUxMjM0NTY3",
                  timestamp: "1700000000",
                  type: "text",
                  text: {
                    body: overrides?.text ?? "Hello agent!",
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe("WhatsAppProvider", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsRateLimited.mockResolvedValue(false);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("configuration", () => {
    it("returns true when enabled and all required credentials are set", () => {
      const provider = new WhatsAppProvider(TEST_CONFIG);
      expect(provider.isConfigured()).toBe(true);
      expect(provider.providerId).toBe("whatsapp");
      expect(provider.usesServerSideSessions).toBe(true);
      expect(provider.getWorkspaceId()).toBe(TEST_CONFIG.phoneNumberId);
    });

    it("returns false when disabled or any required credential is missing", () => {
      expect(
        new WhatsAppProvider({ ...TEST_CONFIG, enabled: false }).isConfigured(),
      ).toBe(false);
      expect(
        new WhatsAppProvider({
          ...TEST_CONFIG,
          accessToken: "",
        }).isConfigured(),
      ).toBe(false);
      expect(
        new WhatsAppProvider({
          ...TEST_CONFIG,
          phoneNumberId: "",
        }).isConfigured(),
      ).toBe(false);
      expect(
        new WhatsAppProvider({
          ...TEST_CONFIG,
          verifyToken: "",
        }).isConfigured(),
      ).toBe(false);
      expect(
        new WhatsAppProvider({ ...TEST_CONFIG, appSecret: "" }).isConfigured(),
      ).toBe(false);
    });
  });

  describe("webhook verification challenge", () => {
    it("returns hub.challenge when hub.mode is subscribe and verify_token matches", () => {
      const provider = new WhatsAppProvider(TEST_CONFIG);
      const result = provider.handleValidationChallenge({
        "hub.mode": "subscribe",
        "hub.verify_token": TEST_CONFIG.verifyToken,
        "hub.challenge": "1158201444",
      });
      expect(result).toBe("1158201444");
    });

    it("returns null on token mismatch or invalid mode", () => {
      const provider = new WhatsAppProvider(TEST_CONFIG);
      expect(
        provider.handleValidationChallenge({
          "hub.mode": "subscribe",
          "hub.verify_token": "wrong-token",
          "hub.challenge": "1158201444",
        }),
      ).toBeNull();
      expect(
        provider.handleValidationChallenge({
          "hub.mode": "unsubscribe",
          "hub.verify_token": TEST_CONFIG.verifyToken,
          "hub.challenge": "1158201444",
        }),
      ).toBeNull();
    });
  });

  describe("X-Hub-Signature-256 verification", () => {
    it("accepts a valid HMAC-SHA256 signature over the raw body", async () => {
      const provider = new WhatsAppProvider(TEST_CONFIG);
      const rawBody = JSON.stringify(createTextWebhookPayload());
      const signature = signPayload(rawBody);

      const valid = await provider.validateWebhookRequest(rawBody, {
        "x-hub-signature-256": signature,
      });
      expect(valid).toBe(true);
    });

    it("rejects missing, malformed, or tampered signatures", async () => {
      const provider = new WhatsAppProvider(TEST_CONFIG);
      const rawBody = JSON.stringify(createTextWebhookPayload());

      expect(await provider.validateWebhookRequest(rawBody, {})).toBe(false);
      expect(
        await provider.validateWebhookRequest(rawBody, {
          "x-hub-signature-256": "md5=1234",
        }),
      ).toBe(false);
      expect(
        await provider.validateWebhookRequest(rawBody, {
          "x-hub-signature-256": signPayload(rawBody, "wrong-secret"),
        }),
      ).toBe(false);
      expect(
        await provider.validateWebhookRequest(`${rawBody} `, {
          "x-hub-signature-256": signPayload(rawBody),
        }),
      ).toBe(false);
    });
  });

  describe("parseWebhookNotification", () => {
    it("parses an incoming WhatsApp text message", async () => {
      const provider = new WhatsAppProvider(TEST_CONFIG);
      const payload = createTextWebhookPayload({
        text: "Summarize today's alerts",
      });

      const parsed = await provider.parseWebhookNotification(payload, {});
      expect(parsed).not.toBeNull();
      expect(parsed).toMatchObject({
        messageId: "wamid.HBgMOTA1NTUxMjM0NTY3",
        channelId: "905551234567",
        workspaceId: TEST_CONFIG.phoneNumberId,
        threadId: "905551234567",
        senderId: "905551234567",
        senderName: "Ada Lovelace",
        text: "Summarize today's alerts",
        metadata: {
          channelType: "im",
          conversationType: "personal",
          whatsappMessageId: "wamid.HBgMOTA1NTUxMjM0NTY3",
        },
      });
    });

    it("ignores status-only webhooks and mismatched phone_number_id events", async () => {
      const provider = new WhatsAppProvider(TEST_CONFIG);

      const statusOnly = {
        object: "whatsapp_business_account",
        entry: [
          {
            id: "waba",
            changes: [
              {
                field: "messages",
                value: {
                  messaging_product: "whatsapp",
                  metadata: { phone_number_id: TEST_CONFIG.phoneNumberId },
                  statuses: [{ id: "wamid.1", status: "delivered" }],
                },
              },
            ],
          },
        ],
      };
      expect(
        await provider.parseWebhookNotification(statusOnly, {}),
      ).toBeNull();

      const otherNumber = createTextWebhookPayload({
        phoneNumberId: "000000000000",
      });
      expect(
        await provider.parseWebhookNotification(otherNumber, {}),
      ).toBeNull();
    });
  });

  describe("sendReply & interactive flows", () => {
    it("sends reply via Meta Graph API with reply context and splits long messages", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ messages: [{ id: "wamid.reply.1" }] }),
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const provider = new WhatsAppProvider(TEST_CONFIG);
      const longText = `${"A".repeat(4000)} ${"B".repeat(200)}`;
      const sentId = await provider.sendReply({
        text: longText,
        originalMessage: {
          messageId: "wamid.incoming.1",
          channelId: "905551234567",
          workspaceId: TEST_CONFIG.phoneNumberId,
          senderId: "905551234567",
          senderName: "Ada",
          text: "Hi",
          rawText: "Hi",
          timestamp: new Date(),
          isThreadReply: false,
          metadata: { whatsappMessageId: "wamid.incoming.1" },
        },
      });

      expect(sentId).toBe("wamid.reply.1");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [firstUrl, firstInit] = fetchMock.mock.calls[0];
      expect(firstUrl).toBe(
        `https://graph.facebook.com/v21.0/${TEST_CONFIG.phoneNumberId}/messages`,
      );
      expect(firstInit.headers.Authorization).toBe(
        `Bearer ${TEST_CONFIG.accessToken}`,
      );
      const firstBody = JSON.parse(firstInit.body);
      expect(firstBody.to).toBe("905551234567");
      expect(firstBody.context).toEqual({ message_id: "wamid.incoming.1" });
      expect(firstBody.text.body.length).toBeLessThanOrEqual(4096);
    });

    it("parses agent selection interactive replies and resolves user email from DM binding", async () => {
      const provider = new WhatsAppProvider(TEST_CONFIG);
      const interactivePayload = {
        object: "whatsapp_business_account",
        entry: [
          {
            id: "waba",
            changes: [
              {
                field: "messages",
                value: {
                  messaging_product: "whatsapp",
                  metadata: { phone_number_id: TEST_CONFIG.phoneNumberId },
                  contacts: [
                    { profile: { name: "Ada" }, wa_id: "905551234567" },
                  ],
                  messages: [
                    {
                      from: "905551234567",
                      id: "wamid.interactive.1",
                      timestamp: "1700000001",
                      type: "interactive",
                      interactive: {
                        type: "button_reply",
                        button_reply: {
                          id: "agent_select|agent-uuid-123",
                          title: "Support Agent",
                        },
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const selection = provider.parseInteractivePayload(interactivePayload);
      expect(selection).toEqual({
        agentId: "agent-uuid-123",
        channelId: "905551234567",
        workspaceId: TEST_CONFIG.phoneNumberId,
        threadTs: "905551234567",
        userId: "905551234567",
        userName: "Ada",
        responseUrl: "",
        isDm: true,
      });

      mockFindByChannel.mockResolvedValueOnce({
        isDm: true,
        dmOwnerEmail: "ada@example.com",
      });
      await expect(provider.getUserEmail("905551234567")).resolves.toBe(
        "ada@example.com",
      );
    });
  });

  describe("whatsappWebhookRoutes integration", () => {
    it("verifies GET challenge and validates POST X-Hub-Signature-256 before triggering ChatOpsManager", async () => {
      const provider = new WhatsAppProvider(TEST_CONFIG);
      mockGetWhatsAppProvider.mockReturnValue(provider);

      const app = Fastify();
      app.setValidatorCompiler(validatorCompiler);
      app.setSerializerCompiler(serializerCompiler);
      app.setErrorHandler((err, _req, reply) => {
        const statusCode =
          typeof (err as { statusCode?: unknown }).statusCode === "number"
            ? (err as { statusCode: number }).statusCode
            : 500;
        return reply.status(statusCode).send({
          error: {
            message: err instanceof Error ? err.message : String(err),
            type: "api_error",
          },
        });
      });
      await app.register(whatsappWebhookRoutes);

      // 1. Valid GET challenge
      const validChallengeRes = await app.inject({
        method: "GET",
        url: `/api/webhooks/chatops/whatsapp?hub.mode=subscribe&hub.verify_token=${TEST_CONFIG.verifyToken}&hub.challenge=challenge_123`,
      });
      expect(validChallengeRes.statusCode).toBe(200);
      expect(validChallengeRes.body).toBe("challenge_123");

      // 2. Invalid GET challenge
      const invalidChallengeRes = await app.inject({
        method: "GET",
        url: "/api/webhooks/chatops/whatsapp?hub.mode=subscribe&hub.verify_token=bad&hub.challenge=challenge_123",
      });
      expect(invalidChallengeRes.statusCode).toBe(403);

      // 3. Invalid POST signature
      const rawBody = JSON.stringify(
        createTextWebhookPayload({ messageId: "wamid.route.1" }),
      );
      const badSigRes = await app.inject({
        method: "POST",
        url: "/api/webhooks/chatops/whatsapp",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": "sha256=deadbeef",
        },
        payload: rawBody,
      });
      expect(badSigRes.statusCode).toBe(401);
      expect(mockHandleIncomingMessage).not.toHaveBeenCalled();

      // 4. Valid POST signature triggers handleIncomingMessage once (dedup on replay)
      const validSig = signPayload(rawBody);
      const okRes = await app.inject({
        method: "POST",
        url: "/api/webhooks/chatops/whatsapp",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": validSig,
        },
        payload: rawBody,
      });
      expect(okRes.statusCode).toBe(200);
      expect(okRes.json()).toEqual({ status: "ok" });
      expect(mockHandleIncomingMessage).toHaveBeenCalledTimes(1);

      const replayRes = await app.inject({
        method: "POST",
        url: "/api/webhooks/chatops/whatsapp",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": validSig,
        },
        payload: rawBody,
      });
      expect(replayRes.statusCode).toBe(200);
      expect(mockHandleIncomingMessage).toHaveBeenCalledTimes(1);

      await app.close();
    });
  });
});
