import { vi } from "vitest";
import { describe, expect, test } from "@/test";
import type { IncomingEmail } from "@/types";
import {
  MAX_ATTACHMENT_SIZE,
  MAX_ATTACHMENTS_PER_EMAIL,
  MAX_TOTAL_ATTACHMENTS_SIZE,
} from "./constants";
import {
  OutlookEmailProvider,
  shouldFetchAttachments,
} from "./outlook-provider";

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
    const createMockGraphClient = () => ({
      api: vi.fn().mockReturnThis(),
      post: vi.fn(),
    });

    test("sends reply with from field set to agent email (Send As)", async () => {
      const mockGraphClient = createMockGraphClient();
      const provider = new OutlookEmailProvider(validConfig);
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
        agentName: "Test Agent",
      });

      expect(mockGraphClient.api).toHaveBeenCalledWith(
        "/users/agents@example.com/messages/original-msg-123/reply",
      );
      expect(mockGraphClient.post).toHaveBeenCalledWith({
        message: {
          from: {
            emailAddress: {
              address: "agents+agent-abc123@example.com",
              name: "Test Agent",
            },
          },
          body: {
            contentType: "Text",
            content: "This is the agent response",
          },
        },
      });
      expect(replyId).toContain("reply-original-msg-123-");
    });

    test("uses default agent name when agentName not provided", async () => {
      const mockGraphClient = createMockGraphClient();
      const provider = new OutlookEmailProvider(validConfig);
      // @ts-expect-error - accessing private property for testing
      provider.graphClient = mockGraphClient;

      mockGraphClient.post.mockResolvedValueOnce({});

      const originalEmail: IncomingEmail = {
        messageId: "original-msg-default-name",
        toAddress: "agents+agent-abc123@example.com",
        fromAddress: "sender@example.com",
        subject: "Test",
        body: "Test",
        receivedAt: new Date(),
      };

      await provider.sendReply({
        originalEmail,
        body: "Response",
      });

      expect(mockGraphClient.post).toHaveBeenCalledWith({
        message: {
          from: {
            emailAddress: {
              address: "agents+agent-abc123@example.com",
              name: "Archestra Agent",
            },
          },
          body: {
            contentType: "Text",
            content: "Response",
          },
        },
      });
    });

    test("sends reply with HTML body when provided", async () => {
      const mockGraphClient = createMockGraphClient();
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
        agentName: "HTML Agent",
      });

      expect(mockGraphClient.post).toHaveBeenCalledWith({
        message: {
          from: {
            emailAddress: {
              address: "agents+agent-abc123@example.com",
              name: "HTML Agent",
            },
          },
          body: {
            contentType: "HTML",
            content: "<p>This is <strong>formatted</strong> response</p>",
          },
        },
      });
      expect(replyId).toContain("reply-original-msg-456-");
    });

    test("falls back to replyTo when Send As permission fails", async () => {
      const mockGraphClient = createMockGraphClient();
      const provider = new OutlookEmailProvider(validConfig);
      // @ts-expect-error - accessing private property for testing
      provider.graphClient = mockGraphClient;

      // First call fails with "Send As" permission error, second succeeds
      mockGraphClient.post
        .mockRejectedValueOnce(
          new Error(
            "The user account which was used to submit this request does not have the right to send mail on behalf of the specified sending account.",
          ),
        )
        .mockResolvedValueOnce({});

      const originalEmail: IncomingEmail = {
        messageId: "original-msg-fallback",
        toAddress: "agents+agent-abc123@example.com",
        fromAddress: "sender@example.com",
        subject: "Test Subject",
        body: "Original message",
        receivedAt: new Date(),
      };

      const replyId = await provider.sendReply({
        originalEmail,
        body: "Fallback response",
        agentName: "Fallback Agent",
      });

      // Should have been called twice - first with from, then with replyTo
      expect(mockGraphClient.post).toHaveBeenCalledTimes(2);

      // First call attempts with 'from' field
      expect(mockGraphClient.post).toHaveBeenNthCalledWith(1, {
        message: {
          from: {
            emailAddress: {
              address: "agents+agent-abc123@example.com",
              name: "Fallback Agent",
            },
          },
          body: {
            contentType: "Text",
            content: "Fallback response",
          },
        },
      });

      // Second call uses 'replyTo' fallback
      expect(mockGraphClient.post).toHaveBeenNthCalledWith(2, {
        message: {
          replyTo: [
            {
              emailAddress: {
                address: "agents+agent-abc123@example.com",
                name: "Fallback Agent",
              },
            },
          ],
          body: {
            contentType: "Text",
            content: "Fallback response",
          },
        },
      });

      expect(replyId).toContain("reply-original-msg-fallback-");
    });

    test("throws error when Graph API fails with non-permission error", async () => {
      const mockGraphClient = createMockGraphClient();
      const provider = new OutlookEmailProvider(validConfig);
      // @ts-expect-error - accessing private property for testing
      provider.graphClient = mockGraphClient;

      mockGraphClient.post.mockRejectedValueOnce(
        new Error("Network error: Unable to connect"),
      );

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
      ).rejects.toThrow("Network error: Unable to connect");
    });

    test("generates unique reply tracking ID", async () => {
      const mockGraphClient = createMockGraphClient();
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

      const replyId2 = await provider.sendReply({
        originalEmail,
        body: "Response 2",
      });

      expect(replyId1).not.toBe(replyId2);
      // UUID format: 8-4-4-4-12 hex characters
      expect(replyId1).toMatch(
        /^reply-unique-msg-test-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
      );
      expect(replyId2).toMatch(
        /^reply-unique-msg-test-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
      );
    });
  });

  describe("getConversationHistory", () => {
    const createMockGraphClient = () => ({
      api: vi.fn().mockReturnThis(),
      filter: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      orderby: vi.fn().mockReturnThis(),
      top: vi.fn().mockReturnThis(),
      get: vi.fn(),
    });

    test("fetches conversation messages excluding current message", async () => {
      const mockGraphClient = createMockGraphClient();
      const provider = new OutlookEmailProvider(validConfig);
      // @ts-expect-error - accessing private property for testing
      provider.graphClient = mockGraphClient;

      mockGraphClient.get.mockResolvedValueOnce({
        value: [
          {
            id: "msg-1",
            from: {
              emailAddress: { address: "user@example.com", name: "User" },
            },
            body: { contentType: "text", content: "First message" },
            receivedDateTime: "2024-01-15T10:00:00Z",
          },
          {
            id: "msg-2",
            from: {
              emailAddress: { address: "agents@example.com", name: "Agent" },
            },
            body: { contentType: "text", content: "Agent response" },
            receivedDateTime: "2024-01-15T10:05:00Z",
          },
          {
            id: "current-msg",
            from: {
              emailAddress: { address: "user@example.com", name: "User" },
            },
            body: { contentType: "text", content: "Current message" },
            receivedDateTime: "2024-01-15T10:10:00Z",
          },
        ],
      });

      const history = await provider.getConversationHistory(
        "conv-123",
        "current-msg",
      );

      expect(history).toHaveLength(2);
      expect(history[0]).toEqual({
        messageId: "msg-1",
        fromAddress: "user@example.com",
        fromName: "User",
        body: "First message",
        receivedAt: new Date("2024-01-15T10:00:00Z"),
        isAgentMessage: false,
      });
      expect(history[1]).toEqual({
        messageId: "msg-2",
        fromAddress: "agents@example.com",
        fromName: "Agent",
        body: "Agent response",
        receivedAt: new Date("2024-01-15T10:05:00Z"),
        isAgentMessage: true,
      });
    });

    test("correctly identifies agent messages by mailbox address", async () => {
      const mockGraphClient = createMockGraphClient();
      const provider = new OutlookEmailProvider(validConfig);
      // @ts-expect-error - accessing private property for testing
      provider.graphClient = mockGraphClient;

      mockGraphClient.get.mockResolvedValueOnce({
        value: [
          {
            id: "msg-1",
            from: { emailAddress: { address: "AGENTS@EXAMPLE.COM" } },
            body: { contentType: "text", content: "From agent" },
            receivedDateTime: "2024-01-15T10:00:00Z",
          },
        ],
      });

      const history = await provider.getConversationHistory(
        "conv-123",
        "current-msg",
      );

      expect(history[0].isAgentMessage).toBe(true);
    });

    test("strips HTML from message bodies", async () => {
      const mockGraphClient = createMockGraphClient();
      const provider = new OutlookEmailProvider(validConfig);
      // @ts-expect-error - accessing private property for testing
      provider.graphClient = mockGraphClient;

      mockGraphClient.get.mockResolvedValueOnce({
        value: [
          {
            id: "msg-1",
            from: { emailAddress: { address: "user@example.com" } },
            body: { contentType: "html", content: "<p>Hello <b>world</b></p>" },
            receivedDateTime: "2024-01-15T10:00:00Z",
          },
        ],
      });

      const history = await provider.getConversationHistory(
        "conv-123",
        "current-msg",
      );

      expect(history[0].body).toBe("Hello world");
    });

    test("returns empty array on API error", async () => {
      const mockGraphClient = createMockGraphClient();
      const provider = new OutlookEmailProvider(validConfig);
      // @ts-expect-error - accessing private property for testing
      provider.graphClient = mockGraphClient;

      mockGraphClient.get.mockRejectedValueOnce(new Error("API Error"));

      const history = await provider.getConversationHistory(
        "conv-123",
        "current-msg",
      );

      expect(history).toEqual([]);
    });

    test("returns empty array when no messages in conversation", async () => {
      const mockGraphClient = createMockGraphClient();
      const provider = new OutlookEmailProvider(validConfig);
      // @ts-expect-error - accessing private property for testing
      provider.graphClient = mockGraphClient;

      mockGraphClient.get.mockResolvedValueOnce({ value: [] });

      const history = await provider.getConversationHistory(
        "conv-123",
        "current-msg",
      );

      expect(history).toEqual([]);
    });

    test("escapes single quotes in conversationId for OData filter", async () => {
      const mockGraphClient = createMockGraphClient();
      const provider = new OutlookEmailProvider(validConfig);
      // @ts-expect-error - accessing private property for testing
      provider.graphClient = mockGraphClient;

      mockGraphClient.get.mockResolvedValueOnce({ value: [] });

      // ConversationId with single quotes (can happen with certain email subjects)
      await provider.getConversationHistory(
        "AAQkADk='test'value",
        "current-msg",
      );

      // Single quotes should be escaped to '' for OData filter syntax
      expect(mockGraphClient.filter).toHaveBeenCalledWith(
        "conversationId eq 'AAQkADk=''test''value'",
      );
    });
  });

  describe("getAttachments", () => {
    const createMockGraphClient = () => ({
      api: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      top: vi.fn().mockReturnThis(),
      get: vi.fn(),
    });

    test("fetches attachments for a message", async () => {
      const mockGraphClient = createMockGraphClient();
      const provider = new OutlookEmailProvider(validConfig);
      // @ts-expect-error - accessing private property for testing
      provider.graphClient = mockGraphClient;

      // First call returns attachment list, subsequent calls return full attachment data
      mockGraphClient.get
        .mockResolvedValueOnce({
          value: [
            {
              "@odata.type": "#microsoft.graph.fileAttachment",
              id: "attachment-1",
              name: "document.pdf",
              contentType: "application/pdf",
              size: 1024,
              isInline: false,
              contentId: null,
            },
            {
              "@odata.type": "#microsoft.graph.fileAttachment",
              id: "attachment-2",
              name: "image.png",
              contentType: "image/png",
              size: 2048,
              isInline: true,
              contentId: "image001",
            },
          ],
        })
        .mockResolvedValueOnce({
          id: "attachment-1",
          name: "document.pdf",
          contentType: "application/pdf",
          size: 1024,
          contentBytes: "SGVsbG8gV29ybGQ=", // "Hello World" base64
        })
        .mockResolvedValueOnce({
          id: "attachment-2",
          name: "image.png",
          contentType: "image/png",
          size: 2048,
          contentBytes: "iVBORw0KGgo=", // partial PNG base64
          contentId: "image001",
        });

      const attachments = await provider.getAttachments("msg-123", true);

      expect(attachments).toHaveLength(2);
      expect(attachments[0]).toEqual({
        id: "attachment-1",
        name: "document.pdf",
        contentType: "application/pdf",
        size: 1024,
        isInline: false,
        contentBase64: "SGVsbG8gV29ybGQ=",
      });
      expect(attachments[1]).toEqual({
        id: "attachment-2",
        name: "image.png",
        contentType: "image/png",
        size: 2048,
        isInline: true,
        contentId: "image001",
        contentBase64: "iVBORw0KGgo=",
      });
    });

    test("fetches metadata only when includeContent is false", async () => {
      const mockGraphClient = createMockGraphClient();
      const provider = new OutlookEmailProvider(validConfig);
      // @ts-expect-error - accessing private property for testing
      provider.graphClient = mockGraphClient;

      mockGraphClient.get.mockResolvedValueOnce({
        value: [
          {
            "@odata.type": "#microsoft.graph.fileAttachment",
            id: "attachment-1",
            name: "document.pdf",
            contentType: "application/pdf",
            size: 1024,
            isInline: false,
          },
        ],
      });

      const attachments = await provider.getAttachments("msg-123", false);

      // Should only make one API call (metadata list), not per-attachment content calls
      expect(mockGraphClient.get).toHaveBeenCalledTimes(1);
      expect(attachments).toHaveLength(1);
      expect(attachments[0].contentBase64).toBeUndefined();
    });

    test("skips attachments exceeding size limit", async () => {
      const mockGraphClient = createMockGraphClient();
      const provider = new OutlookEmailProvider(validConfig);
      // @ts-expect-error - accessing private property for testing
      provider.graphClient = mockGraphClient;

      mockGraphClient.get.mockResolvedValueOnce({
        value: [
          {
            "@odata.type": "#microsoft.graph.fileAttachment",
            id: "too-large",
            name: "huge-file.zip",
            contentType: "application/zip",
            size: MAX_ATTACHMENT_SIZE + 1,
            isInline: false,
          },
          {
            "@odata.type": "#microsoft.graph.fileAttachment",
            id: "small-file",
            name: "small.txt",
            contentType: "text/plain",
            size: 100,
            isInline: false,
          },
        ],
      });
      mockGraphClient.get.mockResolvedValueOnce({
        id: "small-file",
        name: "small.txt",
        contentBytes: "c21hbGw=",
      });

      const attachments = await provider.getAttachments("msg-123", true);

      // Only the small file should be included
      expect(attachments).toHaveLength(1);
      expect(attachments[0].name).toBe("small.txt");
    });

    test("stops when total size limit is reached", async () => {
      const mockGraphClient = createMockGraphClient();
      const provider = new OutlookEmailProvider(validConfig);
      // @ts-expect-error - accessing private property for testing
      provider.graphClient = mockGraphClient;

      // Create 3 attachments that individually fit within MAX_ATTACHMENT_SIZE
      // but together exceed MAX_TOTAL_ATTACHMENTS_SIZE (25MB).
      // Each file is ~9MB, so first two fit (~18MB) but third would exceed limit.
      const attachmentSize = MAX_ATTACHMENT_SIZE - 1024 * 1024; // ~9MB each
      mockGraphClient.get
        .mockResolvedValueOnce({
          value: [
            {
              "@odata.type": "#microsoft.graph.fileAttachment",
              id: "file-1",
              name: "file1.bin",
              contentType: "application/octet-stream",
              size: attachmentSize,
              isInline: false,
            },
            {
              "@odata.type": "#microsoft.graph.fileAttachment",
              id: "file-2",
              name: "file2.bin",
              contentType: "application/octet-stream",
              size: attachmentSize,
              isInline: false,
            },
            {
              "@odata.type": "#microsoft.graph.fileAttachment",
              id: "file-3",
              name: "file3.bin",
              contentType: "application/octet-stream",
              size: attachmentSize,
              isInline: false,
            },
          ],
        })
        .mockResolvedValueOnce({
          id: "file-1",
          contentBytes: "ZmlsZTE=",
        })
        .mockResolvedValueOnce({
          id: "file-2",
          contentBytes: "ZmlsZTI=",
        });
      // Note: file-3 content is never requested because total limit reached

      const attachments = await provider.getAttachments("msg-123", true);

      // First two files fit (~18MB total), third would exceed 25MB limit
      expect(attachments).toHaveLength(2);
      expect(attachments[0].name).toBe("file1.bin");
      expect(attachments[1].name).toBe("file2.bin");
    });

    test("skips non-file attachments (item and reference attachments)", async () => {
      const mockGraphClient = createMockGraphClient();
      const provider = new OutlookEmailProvider(validConfig);
      // @ts-expect-error - accessing private property for testing
      provider.graphClient = mockGraphClient;

      mockGraphClient.get.mockResolvedValueOnce({
        value: [
          {
            "@odata.type": "#microsoft.graph.itemAttachment",
            id: "attached-email",
            name: "Forwarded Email",
            contentType: "message/rfc822",
            size: 5000,
          },
          {
            "@odata.type": "#microsoft.graph.referenceAttachment",
            id: "cloud-file",
            name: "Cloud File.docx",
            contentType:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            size: 10000,
          },
          {
            "@odata.type": "#microsoft.graph.fileAttachment",
            id: "regular-file",
            name: "actual-file.txt",
            contentType: "text/plain",
            size: 100,
            isInline: false,
          },
        ],
      });
      mockGraphClient.get.mockResolvedValueOnce({
        id: "regular-file",
        contentBytes: "ZmlsZQ==",
      });

      const attachments = await provider.getAttachments("msg-123", true);

      // Only the regular file attachment should be included
      expect(attachments).toHaveLength(1);
      expect(attachments[0].name).toBe("actual-file.txt");
    });

    test("non-file attachments do not consume size budget", async () => {
      const mockGraphClient = createMockGraphClient();
      const provider = new OutlookEmailProvider(validConfig);
      // @ts-expect-error - accessing private property for testing
      provider.graphClient = mockGraphClient;

      // A large item attachment followed by a file attachment that would exceed
      // the total limit if the item attachment's size were counted.
      const nearLimitSize = MAX_TOTAL_ATTACHMENTS_SIZE - 1024;
      mockGraphClient.get
        .mockResolvedValueOnce({
          value: [
            {
              "@odata.type": "#microsoft.graph.itemAttachment",
              id: "large-item",
              name: "Forwarded Email",
              contentType: "message/rfc822",
              size: nearLimitSize,
            },
            {
              "@odata.type": "#microsoft.graph.fileAttachment",
              id: "small-file",
              name: "file.txt",
              contentType: "text/plain",
              size: 2048,
              isInline: false,
            },
          ],
        })
        .mockResolvedValueOnce({
          id: "small-file",
          contentBytes: "ZmlsZQ==",
        });

      const attachments = await provider.getAttachments("msg-123", true);

      // The item attachment should be skipped without consuming size budget,
      // so the file attachment should still be included
      expect(attachments).toHaveLength(1);
      expect(attachments[0].name).toBe("file.txt");
    });

    test("returns empty array when no attachments", async () => {
      const mockGraphClient = createMockGraphClient();
      const provider = new OutlookEmailProvider(validConfig);
      // @ts-expect-error - accessing private property for testing
      provider.graphClient = mockGraphClient;

      mockGraphClient.get.mockResolvedValueOnce({ value: [] });

      const attachments = await provider.getAttachments("msg-123", true);

      expect(attachments).toEqual([]);
    });

    test("returns empty array on API error", async () => {
      const mockGraphClient = createMockGraphClient();
      const provider = new OutlookEmailProvider(validConfig);
      // @ts-expect-error - accessing private property for testing
      provider.graphClient = mockGraphClient;

      mockGraphClient.get.mockRejectedValueOnce(new Error("API Error"));

      const attachments = await provider.getAttachments("msg-123", true);

      expect(attachments).toEqual([]);
    });

    test("continues with metadata when content fetch fails", async () => {
      const mockGraphClient = createMockGraphClient();
      const provider = new OutlookEmailProvider(validConfig);
      // @ts-expect-error - accessing private property for testing
      provider.graphClient = mockGraphClient;

      mockGraphClient.get
        .mockResolvedValueOnce({
          value: [
            {
              "@odata.type": "#microsoft.graph.fileAttachment",
              id: "attachment-1",
              name: "document.pdf",
              contentType: "application/pdf",
              size: 1024,
              isInline: false,
            },
          ],
        })
        .mockRejectedValueOnce(new Error("Content fetch failed"));

      const attachments = await provider.getAttachments("msg-123", true);

      // Should still return the attachment, just without content
      expect(attachments).toHaveLength(1);
      expect(attachments[0].name).toBe("document.pdf");
      expect(attachments[0].contentBase64).toBeUndefined();
    });

    test("respects MAX_ATTACHMENTS_PER_EMAIL limit", async () => {
      const mockGraphClient = createMockGraphClient();
      const provider = new OutlookEmailProvider(validConfig);
      // @ts-expect-error - accessing private property for testing
      provider.graphClient = mockGraphClient;

      mockGraphClient.get.mockResolvedValueOnce({ value: [] });

      await provider.getAttachments("msg-123", false);

      // Verify that .top() was called with MAX_ATTACHMENTS_PER_EMAIL
      expect(mockGraphClient.top).toHaveBeenCalledWith(
        MAX_ATTACHMENTS_PER_EMAIL,
      );
    });

    test("uses default values for missing attachment properties", async () => {
      const mockGraphClient = createMockGraphClient();
      const provider = new OutlookEmailProvider(validConfig);
      // @ts-expect-error - accessing private property for testing
      provider.graphClient = mockGraphClient;

      mockGraphClient.get
        .mockResolvedValueOnce({
          value: [
            {
              "@odata.type": "#microsoft.graph.fileAttachment",
              id: "minimal-attachment",
              // Missing name, contentType, size, isInline
            },
          ],
        })
        .mockResolvedValueOnce({
          id: "minimal-attachment",
        });

      const attachments = await provider.getAttachments("msg-123", true);

      expect(attachments).toHaveLength(1);
      expect(attachments[0].name).toBe("attachment-minimal-attachment");
      expect(attachments[0].contentType).toBe("application/octet-stream");
      expect(attachments[0].size).toBe(0);
      expect(attachments[0].isInline).toBe(false);
    });
  });

  describe("stripHtml (email threading)", () => {
    // Access private method via type casting for testing
    const getStripHtml = (provider: OutlookEmailProvider) => {
      // @ts-expect-error - accessing private method for testing
      return provider.stripHtml.bind(provider);
    };

    test("converts simple HTML to plain text", () => {
      const provider = new OutlookEmailProvider(validConfig);
      const stripHtml = getStripHtml(provider);

      const html = "<p>Hello world</p>";
      expect(stripHtml(html)).toBe("Hello world");
    });

    test("preserves line breaks from br tags", () => {
      const provider = new OutlookEmailProvider(validConfig);
      const stripHtml = getStripHtml(provider);

      const html = "Line 1<br>Line 2<br/>Line 3";
      expect(stripHtml(html)).toBe("Line 1\nLine 2\nLine 3");
    });

    test("preserves paragraph structure", () => {
      const provider = new OutlookEmailProvider(validConfig);
      const stripHtml = getStripHtml(provider);

      const html = "<p>Paragraph 1</p><p>Paragraph 2</p>";
      expect(stripHtml(html)).toBe("Paragraph 1\n\nParagraph 2");
    });

    test("converts blockquotes to quoted text format", () => {
      const provider = new OutlookEmailProvider(validConfig);
      const stripHtml = getStripHtml(provider);

      const html =
        "<p>My reply</p><blockquote>Original message line 1<br>Original message line 2</blockquote>";
      const result = stripHtml(html);

      expect(result).toContain("My reply");
      expect(result).toContain("> Original message line 1");
      expect(result).toContain("> Original message line 2");
    });

    test("handles nested blockquotes in email threads", () => {
      const provider = new OutlookEmailProvider(validConfig);
      const stripHtml = getStripHtml(provider);

      // Simulates a 3-level email thread: User reply -> Agent response -> Original user message
      const html = `
        <p>User's second reply</p>
        <blockquote>
          <p>Agent's response</p>
          <blockquote>
            <p>User's original message</p>
          </blockquote>
        </blockquote>
      `;
      const result = stripHtml(html);

      // All messages should be present and quoted content should have ">" prefix
      expect(result).toContain("User's second reply");
      expect(result).toContain("> Agent's response");
      expect(result).toContain("> User's original message");
    });

    test("converts horizontal rules to separator lines", () => {
      const provider = new OutlookEmailProvider(validConfig);
      const stripHtml = getStripHtml(provider);

      const html = "<p>Above</p><hr><p>Below</p>";
      const result = stripHtml(html);

      expect(result).toContain("Above");
      expect(result).toContain("---");
      expect(result).toContain("Below");
    });

    test("decodes HTML entities", () => {
      const provider = new OutlookEmailProvider(validConfig);
      const stripHtml = getStripHtml(provider);

      const html =
        "<p>Tom &amp; Jerry &lt;hello@example.com&gt; said &quot;hi&quot;</p>";
      const result = stripHtml(html);

      expect(result).toBe('Tom & Jerry <hello@example.com> said "hi"');
    });

    test("prevents double-unescaping of HTML entities", () => {
      const provider = new OutlookEmailProvider(validConfig);
      const stripHtml = getStripHtml(provider);

      // Double-encoded entities should only be decoded once
      // &amp;lt; should become &lt; (literal characters), not <
      // &amp;amp; should become &amp; (literal characters), not &
      const html = "<p>Code: &amp;lt;script&amp;gt; and &amp;amp;</p>";
      const result = stripHtml(html);

      // After single decode: &lt;script&gt; and &amp;
      expect(result).toBe("Code: &lt;script&gt; and &amp;");
      // Should NOT be double-decoded to: <script> and &
      expect(result).not.toContain("<script>");
    });

    test("handles realistic Outlook email reply HTML", () => {
      const provider = new OutlookEmailProvider(validConfig);
      const stripHtml = getStripHtml(provider);

      // This simulates a typical Outlook HTML email reply format
      const html = `
        <html>
        <body>
          <div>Thanks for your response!</div>
          <div>&nbsp;</div>
          <hr style="display:inline-block;width:98%">
          <div id="divRplyFwdMsg" dir="ltr">
            <b>From:</b> Agent &lt;agents+agent-abc@example.com&gt;<br>
            <b>Sent:</b> Monday, January 15, 2026 10:00 AM<br>
            <b>To:</b> User &lt;user@example.com&gt;<br>
            <b>Subject:</b> Re: Question<br>
          </div>
          <div>&nbsp;</div>
          <div>Here is the agent's previous response with helpful information.</div>
        </body>
        </html>
      `;
      const result = stripHtml(html);

      // Should contain user's new message
      expect(result).toContain("Thanks for your response!");
      // Should contain the separator
      expect(result).toContain("---");
      // Should contain the agent's previous response
      expect(result).toContain(
        "Here is the agent's previous response with helpful information",
      );
      // Should contain email metadata (From, Sent, etc.)
      expect(result).toContain("From:");
      expect(result).toContain("agents+agent-abc@example.com");
    });

    test("preserves full conversation history in multi-turn thread", () => {
      const provider = new OutlookEmailProvider(validConfig);
      const stripHtml = getStripHtml(provider);

      // Simulates a 3-turn email conversation
      const html = `
        <div>This is my third message to the agent.</div>
        <blockquote>
          <div>Agent's second response: I've processed your request.</div>
          <blockquote>
            <div>User's second message: Can you help me with something else?</div>
            <blockquote>
              <div>Agent's first response: Hello! How can I help you?</div>
              <blockquote>
                <div>User's first message: Hello agent!</div>
              </blockquote>
            </blockquote>
          </blockquote>
        </blockquote>
      `;
      const result = stripHtml(html);

      // All messages should be present in the result - this is the key requirement
      // The agent needs to see the full conversation history
      expect(result).toContain("This is my third message to the agent");
      expect(result).toContain("Agent's second response");
      expect(result).toContain("User's second message");
      expect(result).toContain("Agent's first response");
      expect(result).toContain("User's first message");

      // Quoted content should be marked with ">" prefix
      expect(result).toContain("> Agent's second response");
      expect(result).toContain("> User's second message");
      expect(result).toContain("> Agent's first response");
      expect(result).toContain("> User's first message");
    });
  });
});

describe("shouldFetchAttachments", () => {
  test("returns true when hasAttachments is true", () => {
    expect(shouldFetchAttachments(true, undefined)).toBe(true);
  });

  test("returns true when hasAttachments is true even with no HTML body", () => {
    expect(shouldFetchAttachments(true, "")).toBe(true);
  });

  test("returns false when hasAttachments is false and no HTML body", () => {
    expect(shouldFetchAttachments(false, undefined)).toBe(false);
  });

  test("returns false when hasAttachments is false and HTML has no inline images", () => {
    const html = "<html><body><p>Hello world</p></body></html>";
    expect(shouldFetchAttachments(false, html)).toBe(false);
  });

  test("returns true when HTML body contains cid: reference with double quotes", () => {
    const html =
      '<html><body><img src="cid:image001@01D00000.00000000"></body></html>';
    expect(shouldFetchAttachments(false, html)).toBe(true);
  });

  test("returns true when HTML body contains cid: reference with single quotes", () => {
    const html = "<html><body><img src='cid:ii_abc123'></body></html>";
    expect(shouldFetchAttachments(false, html)).toBe(true);
  });

  test("returns true for case-insensitive CID references", () => {
    const html = '<html><body><img SRC="CID:image001"></body></html>';
    expect(shouldFetchAttachments(false, html)).toBe(true);
  });

  test("returns false for non-cid image sources", () => {
    const html =
      '<html><body><img src="https://example.com/photo.png"></body></html>';
    expect(shouldFetchAttachments(false, html)).toBe(false);
  });

  test("returns true with multiple inline images", () => {
    const html = `
      <html><body>
        <p>Here are photos:</p>
        <img src="cid:image001@exchange">
        <img src="cid:image002@exchange">
      </body></html>`;
    expect(shouldFetchAttachments(false, html)).toBe(true);
  });

  test("returns false for empty HTML body", () => {
    expect(shouldFetchAttachments(false, "")).toBe(false);
  });
});

describe("parseWebhookNotification", () => {
  const AGENT_UUID_NO_DASHES = "c47915015ce24f89a26f00a86e0cdf76";
  const AGENT_EMAIL = `agents+agent-${AGENT_UUID_NO_DASHES}@example.com`;

  const createMockGraphClient = () => ({
    api: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    top: vi.fn().mockReturnThis(),
    get: vi.fn(),
  });

  /**
   * Helper: build a minimal valid webhook payload
   */
  const buildPayload = (
    notifications: Array<{
      changeType?: string;
      resource?: string;
      resourceData?: { id?: string };
    }>,
  ) => ({
    value: notifications.map((n) => ({
      changeType: n.changeType ?? "created",
      resource:
        n.resource ??
        `Users/agents@example.com/Messages/${n.resourceData?.id ?? "msg-1"}`,
      resourceData: n.resourceData ?? { id: "msg-1" },
      clientState: "test-state",
    })),
  });

  /**
   * Helper: build a Graph API message response
   */
  const buildGraphMessage = (overrides: Record<string, unknown> = {}) => ({
    id: "msg-1",
    conversationId: "conv-1",
    subject: "Test Subject",
    body: { contentType: "text", content: "Hello from sender" },
    bodyPreview: "Hello from sender",
    from: {
      emailAddress: { address: "sender@example.com", name: "Sender" },
    },
    toRecipients: [{ emailAddress: { address: AGENT_EMAIL, name: "Agent" } }],
    receivedDateTime: "2024-06-15T12:00:00Z",
    hasAttachments: false,
    ...overrides,
  });

  // ----------------------------------------------------------------
  // Null / invalid payloads
  // ----------------------------------------------------------------

  test("returns null for null payload", async () => {
    const provider = new OutlookEmailProvider(validConfig);
    const result = await provider.parseWebhookNotification(null, {});
    expect(result).toBeNull();
  });

  test("returns null for non-object payload (string)", async () => {
    const provider = new OutlookEmailProvider(validConfig);
    const result = await provider.parseWebhookNotification("hello", {});
    expect(result).toBeNull();
  });

  test("returns null for non-object payload (number)", async () => {
    const provider = new OutlookEmailProvider(validConfig);
    const result = await provider.parseWebhookNotification(42, {});
    expect(result).toBeNull();
  });

  test("returns null for object without value key", async () => {
    const provider = new OutlookEmailProvider(validConfig);
    const result = await provider.parseWebhookNotification({ foo: "bar" }, {});
    expect(result).toBeNull();
  });

  test("returns null for payload with empty value array", async () => {
    const provider = new OutlookEmailProvider(validConfig);
    const result = await provider.parseWebhookNotification({ value: [] }, {});
    expect(result).toBeNull();
  });

  // ----------------------------------------------------------------
  // Filtering
  // ----------------------------------------------------------------

  test("skips notifications where changeType is not 'created'", async () => {
    const mockGraphClient = createMockGraphClient();
    const provider = new OutlookEmailProvider(validConfig);
    // @ts-expect-error - accessing private property for testing
    provider.graphClient = mockGraphClient;

    const payload = buildPayload([
      { changeType: "updated", resourceData: { id: "msg-update" } },
      { changeType: "deleted", resourceData: { id: "msg-delete" } },
    ]);

    const result = await provider.parseWebhookNotification(payload, {});

    // Neither notification should trigger a Graph API call
    expect(mockGraphClient.api).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  test("skips notifications with missing resourceData.id", async () => {
    const mockGraphClient = createMockGraphClient();
    const provider = new OutlookEmailProvider(validConfig);
    // @ts-expect-error - accessing private property for testing
    provider.graphClient = mockGraphClient;

    const payload = {
      value: [
        { changeType: "created", resourceData: {} },
        { changeType: "created", resourceData: undefined },
      ],
    };

    const result = await provider.parseWebhookNotification(payload, {});

    expect(mockGraphClient.api).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  // ----------------------------------------------------------------
  // Successful parsing — plain text email
  // ----------------------------------------------------------------

  test("parses a valid notification with text body", async () => {
    const mockGraphClient = createMockGraphClient();
    const provider = new OutlookEmailProvider(validConfig);
    // @ts-expect-error - accessing private property for testing
    provider.graphClient = mockGraphClient;

    mockGraphClient.get.mockResolvedValueOnce(buildGraphMessage());

    const payload = buildPayload([{ resourceData: { id: "msg-1" } }]);
    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: length asserted above
    const email = result![0];
    expect(email.messageId).toBe("msg-1");
    expect(email.conversationId).toBe("conv-1");
    expect(email.toAddress).toBe(AGENT_EMAIL);
    expect(email.fromAddress).toBe("sender@example.com");
    expect(email.subject).toBe("Test Subject");
    expect(email.body).toBe("Hello from sender");
    expect(email.htmlBody).toBeUndefined();
    expect(email.receivedAt).toEqual(new Date("2024-06-15T12:00:00Z"));
    expect(email.metadata).toEqual({
      provider: "outlook",
      originalResource: expect.any(String),
    });
    expect(email.attachments).toBeUndefined();
  });

  // ----------------------------------------------------------------
  // HTML body emails
  // ----------------------------------------------------------------

  test("parses notification with HTML body — strips to plain text and sets htmlBody", async () => {
    const mockGraphClient = createMockGraphClient();
    const provider = new OutlookEmailProvider(validConfig);
    // @ts-expect-error - accessing private property for testing
    provider.graphClient = mockGraphClient;

    mockGraphClient.get.mockResolvedValueOnce(
      buildGraphMessage({
        body: {
          contentType: "html",
          content: "<p>Hello <b>world</b></p>",
        },
      }),
    );

    const payload = buildPayload([{ resourceData: { id: "msg-html" } }]);
    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).toHaveLength(1);
    expect(result?.[0].body).toBe("Hello world");
    expect(result?.[0].htmlBody).toBe("<p>Hello <b>world</b></p>");
  });

  test("fetches attachments when HTML body contains cid: inline images", async () => {
    const mockGraphClient = createMockGraphClient();
    const provider = new OutlookEmailProvider(validConfig);
    // @ts-expect-error - accessing private property for testing
    provider.graphClient = mockGraphClient;

    const htmlContent =
      '<p>See image:</p><img src="cid:image001@01D00000.00000000">';

    // First call: message fetch
    mockGraphClient.get.mockResolvedValueOnce(
      buildGraphMessage({
        id: "msg-cid",
        body: { contentType: "html", content: htmlContent },
        hasAttachments: false,
      }),
    );
    // Second call: attachment list (getAttachments -> list)
    mockGraphClient.get.mockResolvedValueOnce({
      value: [
        {
          "@odata.type": "#microsoft.graph.fileAttachment",
          id: "att-inline",
          name: "image001.png",
          contentType: "image/png",
          size: 512,
          isInline: true,
        },
      ],
    });
    // Third call: attachment content
    mockGraphClient.get.mockResolvedValueOnce({
      id: "att-inline",
      contentBytes: "iVBORw0KGgo=",
      contentId: "image001@01D00000.00000000",
    });

    const payload = buildPayload([{ resourceData: { id: "msg-cid" } }]);
    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).toHaveLength(1);
    expect(result?.[0].attachments).toHaveLength(1);
    expect(result?.[0].attachments?.[0].isInline).toBe(true);
    expect(result?.[0].attachments?.[0].contentId).toBe(
      "image001@01D00000.00000000",
    );
  });

  // ----------------------------------------------------------------
  // Attachments
  // ----------------------------------------------------------------

  test("fetches attachments when hasAttachments is true", async () => {
    const mockGraphClient = createMockGraphClient();
    const provider = new OutlookEmailProvider(validConfig);
    // @ts-expect-error - accessing private property for testing
    provider.graphClient = mockGraphClient;

    mockGraphClient.get
      .mockResolvedValueOnce(
        buildGraphMessage({
          id: "msg-att",
          hasAttachments: true,
        }),
      )
      .mockResolvedValueOnce({
        value: [
          {
            "@odata.type": "#microsoft.graph.fileAttachment",
            id: "att-1",
            name: "report.pdf",
            contentType: "application/pdf",
            size: 2048,
            isInline: false,
          },
        ],
      })
      .mockResolvedValueOnce({
        id: "att-1",
        contentBytes: "JVBERi0xLjQ=",
      });

    const payload = buildPayload([{ resourceData: { id: "msg-att" } }]);
    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).toHaveLength(1);
    expect(result?.[0].attachments).toHaveLength(1);
    expect(result?.[0].attachments?.[0].name).toBe("report.pdf");
    expect(result?.[0].attachments?.[0].contentBase64).toBe("JVBERi0xLjQ=");
  });

  test("does not fetch attachments when hasAttachments is false and no cid references", async () => {
    const mockGraphClient = createMockGraphClient();
    const provider = new OutlookEmailProvider(validConfig);
    // @ts-expect-error - accessing private property for testing
    provider.graphClient = mockGraphClient;

    mockGraphClient.get.mockResolvedValueOnce(
      buildGraphMessage({
        hasAttachments: false,
        body: { contentType: "text", content: "Plain text" },
      }),
    );

    const payload = buildPayload([{ resourceData: { id: "msg-noatt" } }]);
    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).toHaveLength(1);
    expect(result?.[0].attachments).toBeUndefined();
    // Only one API call (message fetch), no attachment calls
    expect(mockGraphClient.get).toHaveBeenCalledTimes(1);
  });

  // ----------------------------------------------------------------
  // Recipient matching
  // ----------------------------------------------------------------

  test("skips message when no recipient matches agent email pattern", async () => {
    const mockGraphClient = createMockGraphClient();
    const provider = new OutlookEmailProvider(validConfig);
    // @ts-expect-error - accessing private property for testing
    provider.graphClient = mockGraphClient;

    mockGraphClient.get.mockResolvedValueOnce(
      buildGraphMessage({
        toRecipients: [
          {
            emailAddress: {
              address: "random-user@example.com",
              name: "Random",
            },
          },
        ],
      }),
    );

    const payload = buildPayload([{ resourceData: { id: "msg-nomatch" } }]);
    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).toBeNull();
  });

  test("handles multiple recipients — picks the one matching agent pattern", async () => {
    const mockGraphClient = createMockGraphClient();
    const provider = new OutlookEmailProvider(validConfig);
    // @ts-expect-error - accessing private property for testing
    provider.graphClient = mockGraphClient;

    mockGraphClient.get.mockResolvedValueOnce(
      buildGraphMessage({
        toRecipients: [
          {
            emailAddress: {
              address: "colleague@example.com",
              name: "Colleague",
            },
          },
          { emailAddress: { address: AGENT_EMAIL, name: "Agent" } },
          {
            emailAddress: {
              address: "another@example.com",
              name: "Another",
            },
          },
        ],
      }),
    );

    const payload = buildPayload([{ resourceData: { id: "msg-multi" } }]);
    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).toHaveLength(1);
    expect(result?.[0].toAddress).toBe(AGENT_EMAIL);
  });

  // ----------------------------------------------------------------
  // Error handling
  // ----------------------------------------------------------------

  test("handles Graph API error gracefully — logs and continues", async () => {
    const mockGraphClient = createMockGraphClient();
    const provider = new OutlookEmailProvider(validConfig);
    // @ts-expect-error - accessing private property for testing
    provider.graphClient = mockGraphClient;

    mockGraphClient.get.mockRejectedValueOnce(
      new Error("Graph API 404: Message not found"),
    );

    const payload = buildPayload([{ resourceData: { id: "msg-err" } }]);
    const result = await provider.parseWebhookNotification(payload, {});

    // Error should not throw; result should be null since no emails succeeded
    expect(result).toBeNull();
  });

  test("processes multiple notifications — returns only successful ones", async () => {
    const mockGraphClient = createMockGraphClient();
    const provider = new OutlookEmailProvider(validConfig);
    // @ts-expect-error - accessing private property for testing
    provider.graphClient = mockGraphClient;

    // First notification: Graph API error
    mockGraphClient.get.mockRejectedValueOnce(new Error("API Error"));
    // Second notification: success
    mockGraphClient.get.mockResolvedValueOnce(
      buildGraphMessage({
        id: "msg-success",
        subject: "Success Email",
      }),
    );

    const payload = buildPayload([
      { resourceData: { id: "msg-fail" } },
      { resourceData: { id: "msg-success" } },
    ]);
    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).toHaveLength(1);
    expect(result?.[0].messageId).toBe("msg-success");
    expect(result?.[0].subject).toBe("Success Email");
  });

  // ----------------------------------------------------------------
  // Edge cases
  // ----------------------------------------------------------------

  test("uses 'unknown' as fromAddress when from field is missing", async () => {
    const mockGraphClient = createMockGraphClient();
    const provider = new OutlookEmailProvider(validConfig);
    // @ts-expect-error - accessing private property for testing
    provider.graphClient = mockGraphClient;

    mockGraphClient.get.mockResolvedValueOnce(
      buildGraphMessage({ from: undefined }),
    );

    const payload = buildPayload([{ resourceData: { id: "msg-nofrom" } }]);
    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).toHaveLength(1);
    expect(result?.[0].fromAddress).toBe("unknown");
  });

  test("falls back to current date when receivedDateTime is null", async () => {
    const mockGraphClient = createMockGraphClient();
    const provider = new OutlookEmailProvider(validConfig);
    // @ts-expect-error - accessing private property for testing
    provider.graphClient = mockGraphClient;

    const before = new Date();
    mockGraphClient.get.mockResolvedValueOnce(
      buildGraphMessage({ receivedDateTime: null }),
    );

    const payload = buildPayload([{ resourceData: { id: "msg-nodate" } }]);
    const result = await provider.parseWebhookNotification(payload, {});
    const after = new Date();

    expect(result).toHaveLength(1);
    const receivedAt = result?.[0].receivedAt as Date;
    expect(receivedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(receivedAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  test("uses empty string as subject when subject is missing", async () => {
    const mockGraphClient = createMockGraphClient();
    const provider = new OutlookEmailProvider(validConfig);
    // @ts-expect-error - accessing private property for testing
    provider.graphClient = mockGraphClient;

    mockGraphClient.get.mockResolvedValueOnce(
      buildGraphMessage({ subject: undefined }),
    );

    const payload = buildPayload([{ resourceData: { id: "msg-nosubject" } }]);
    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).toHaveLength(1);
    expect(result?.[0].subject).toBe("");
  });
});
