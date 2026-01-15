import { vi } from "vitest";
import { describe, expect, test } from "@/test";
import type { IncomingEmail } from "@/types";
import { OutlookEmailProvider } from "./outlook-provider";

const validConfig = {
  tenantId: "test-tenant-id",
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  mailboxAddress: "agents@example.com",
};

describe("OutlookEmailProvider", () => {
  describe("isConfigured", () => {
    test("returns true when all required config is provided", () => {
      const provider = new OutlookEmailProvider(validConfig);
      expect(provider.isConfigured()).toBe(true);
    });

    test("returns false when tenantId is missing", () => {
      const provider = new OutlookEmailProvider({
        ...validConfig,
        tenantId: "",
      });
      expect(provider.isConfigured()).toBe(false);
    });

    test("returns false when clientId is missing", () => {
      const provider = new OutlookEmailProvider({
        ...validConfig,
        clientId: "",
      });
      expect(provider.isConfigured()).toBe(false);
    });

    test("returns false when clientSecret is missing", () => {
      const provider = new OutlookEmailProvider({
        ...validConfig,
        clientSecret: "",
      });
      expect(provider.isConfigured()).toBe(false);
    });

    test("returns false when mailboxAddress is missing", () => {
      const provider = new OutlookEmailProvider({
        ...validConfig,
        mailboxAddress: "",
      });
      expect(provider.isConfigured()).toBe(false);
    });
  });

  describe("getEmailDomain", () => {
    test("extracts domain from mailbox address", () => {
      const provider = new OutlookEmailProvider(validConfig);
      expect(provider.getEmailDomain()).toBe("example.com");
    });

    test("uses custom emailDomain when provided", () => {
      const provider = new OutlookEmailProvider({
        ...validConfig,
        emailDomain: "custom-domain.com",
      });
      expect(provider.getEmailDomain()).toBe("custom-domain.com");
    });

    test("throws error for invalid mailbox address format", () => {
      const provider = new OutlookEmailProvider({
        ...validConfig,
        mailboxAddress: "invalid-email-no-at-symbol",
      });
      expect(() => provider.getEmailDomain()).toThrow(
        "Invalid mailbox address format",
      );
    });
  });

  describe("generateEmailAddress", () => {
    test("generates email with plus-addressing pattern", () => {
      const provider = new OutlookEmailProvider(validConfig);
      const promptId = "12345678-1234-1234-1234-123456789012";

      const email = provider.generateEmailAddress(promptId);

      // Dashes removed from UUID: 12345678123412341234123456789012
      expect(email).toBe(
        "agents+agent-12345678123412341234123456789012@example.com",
      );
    });

    test("uses custom emailDomain when provided", () => {
      const provider = new OutlookEmailProvider({
        ...validConfig,
        emailDomain: "custom.org",
      });
      const promptId = "12345678-1234-1234-1234-123456789012";

      const email = provider.generateEmailAddress(promptId);

      expect(email).toContain("@custom.org");
    });

    test("throws error for invalid mailbox address format", () => {
      const provider = new OutlookEmailProvider({
        ...validConfig,
        mailboxAddress: "invalid",
      });

      expect(() =>
        provider.generateEmailAddress("12345678-1234-1234-1234-123456789012"),
      ).toThrow("Invalid mailbox address format");
    });
  });

  describe("extractPromptIdFromEmail", () => {
    test("extracts promptId from valid agent email address", () => {
      const provider = new OutlookEmailProvider(validConfig);
      const email = "agents+agent-12345678123412341234123456789012@example.com";

      const promptId = provider.extractPromptIdFromEmail(email);

      expect(promptId).toBe("12345678-1234-1234-1234-123456789012");
    });

    test("returns null for email without agent prefix", () => {
      const provider = new OutlookEmailProvider(validConfig);
      const email = "agents@example.com";

      const promptId = provider.extractPromptIdFromEmail(email);

      expect(promptId).toBeNull();
    });

    test("returns null for email with invalid promptId length", () => {
      const provider = new OutlookEmailProvider(validConfig);
      const email = "agents+agent-123456@example.com"; // Too short

      const promptId = provider.extractPromptIdFromEmail(email);

      expect(promptId).toBeNull();
    });

    test("returns null for email without plus addressing", () => {
      const provider = new OutlookEmailProvider(validConfig);
      const email = "random-email@example.com";

      const promptId = provider.extractPromptIdFromEmail(email);

      expect(promptId).toBeNull();
    });

    test("roundtrip: generateEmailAddress and extractPromptIdFromEmail", () => {
      const provider = new OutlookEmailProvider(validConfig);
      const originalPromptId = "c4791501-5ce2-4f89-a26f-00a86e0cdf76";

      const email = provider.generateEmailAddress(originalPromptId);
      const extractedPromptId = provider.extractPromptIdFromEmail(email);

      expect(extractedPromptId).toBe(originalPromptId);
    });
  });

  describe("handleValidationChallenge", () => {
    test("returns validation token when present in payload", () => {
      const provider = new OutlookEmailProvider(validConfig);
      const payload = { validationToken: "test-token-123" };

      const result = provider.handleValidationChallenge(payload);

      expect(result).toBe("test-token-123");
    });

    test("returns null for payload without validationToken", () => {
      const provider = new OutlookEmailProvider(validConfig);
      const payload = { someOtherField: "value" };

      const result = provider.handleValidationChallenge(payload);

      expect(result).toBeNull();
    });

    test("returns null for null payload", () => {
      const provider = new OutlookEmailProvider(validConfig);

      const result = provider.handleValidationChallenge(null);

      expect(result).toBeNull();
    });

    test("returns null for non-object payload", () => {
      const provider = new OutlookEmailProvider(validConfig);

      expect(provider.handleValidationChallenge("string")).toBeNull();
      expect(provider.handleValidationChallenge(123)).toBeNull();
      expect(provider.handleValidationChallenge(undefined)).toBeNull();
    });
  });

  describe("providerId and displayName", () => {
    test("has correct providerId", () => {
      const provider = new OutlookEmailProvider(validConfig);
      expect(provider.providerId).toBe("outlook");
    });

    test("has correct displayName", () => {
      const provider = new OutlookEmailProvider(validConfig);
      expect(provider.displayName).toBe("Microsoft Outlook");
    });
  });

  describe("sendReply", () => {
    const mockGraphClient = {
      api: vi.fn().mockReturnThis(),
      post: vi.fn(),
    };

    test("sends reply with plain text body", async () => {
      const provider = new OutlookEmailProvider(validConfig);
      // Access the private graphClient through the provider
      // @ts-expect-error - accessing private property for testing
      provider.graphClient = mockGraphClient;

      mockGraphClient.post.mockResolvedValueOnce({});

      const originalEmail: IncomingEmail = {
        messageId: "original-msg-123",
        toAddress: "agents+agent-abc123@example.com",
        fromAddress: "sender@example.com",
        subject: "Test Subject",
        body: "Original message",
        receivedAt: new Date(),
      };

      const replyId = await provider.sendReply({
        originalEmail,
        body: "This is the agent response",
      });

      expect(mockGraphClient.api).toHaveBeenCalledWith(
        "/users/agents@example.com/messages/original-msg-123/reply",
      );
      expect(mockGraphClient.post).toHaveBeenCalledWith({
        message: {
          body: {
            contentType: "Text",
            content: "This is the agent response",
          },
        },
        comment: "This is the agent response",
      });
      expect(replyId).toContain("reply-original-msg-123-");
    });

    test("sends reply with HTML body when provided", async () => {
      const provider = new OutlookEmailProvider(validConfig);
      // @ts-expect-error - accessing private property for testing
      provider.graphClient = mockGraphClient;

      mockGraphClient.post.mockResolvedValueOnce({});

      const originalEmail: IncomingEmail = {
        messageId: "original-msg-456",
        toAddress: "agents+agent-abc123@example.com",
        fromAddress: "sender@example.com",
        subject: "Test Subject",
        body: "Original message",
        receivedAt: new Date(),
      };

      const replyId = await provider.sendReply({
        originalEmail,
        body: "Plain text version",
        htmlBody: "<p>This is <strong>formatted</strong> response</p>",
      });

      expect(mockGraphClient.post).toHaveBeenCalledWith({
        message: {
          body: {
            contentType: "HTML",
            content: "<p>This is <strong>formatted</strong> response</p>",
          },
        },
        comment: "Plain text version",
      });
      expect(replyId).toContain("reply-original-msg-456-");
    });

    test("throws error when Graph API fails", async () => {
      const provider = new OutlookEmailProvider(validConfig);
      // @ts-expect-error - accessing private property for testing
      provider.graphClient = mockGraphClient;

      mockGraphClient.post.mockRejectedValueOnce(new Error("Graph API error"));

      const originalEmail: IncomingEmail = {
        messageId: "original-msg-789",
        toAddress: "agents+agent-abc123@example.com",
        fromAddress: "sender@example.com",
        subject: "Test Subject",
        body: "Original message",
        receivedAt: new Date(),
      };

      await expect(
        provider.sendReply({
          originalEmail,
          body: "Response",
        }),
      ).rejects.toThrow("Graph API error");
    });

    test("generates unique reply tracking ID", async () => {
      const provider = new OutlookEmailProvider(validConfig);
      // @ts-expect-error - accessing private property for testing
      provider.graphClient = mockGraphClient;

      mockGraphClient.post.mockResolvedValue({});

      const originalEmail: IncomingEmail = {
        messageId: "unique-msg-test",
        toAddress: "agents+agent-abc123@example.com",
        fromAddress: "sender@example.com",
        subject: "Test",
        body: "Test",
        receivedAt: new Date(),
      };

      const replyId1 = await provider.sendReply({
        originalEmail,
        body: "Response 1",
      });

      // Small delay to ensure different timestamp
      await new Promise((resolve) => setTimeout(resolve, 10));

      const replyId2 = await provider.sendReply({
        originalEmail,
        body: "Response 2",
      });

      expect(replyId1).not.toBe(replyId2);
      expect(replyId1).toMatch(/^reply-unique-msg-test-\d+$/);
      expect(replyId2).toMatch(/^reply-unique-msg-test-\d+$/);
    });
  });
});
