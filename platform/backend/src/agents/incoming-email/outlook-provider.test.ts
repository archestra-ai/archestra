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
