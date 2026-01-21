import type { IncomingEmailSecurityMode } from "@shared";
import { vi } from "vitest";

// Mock the a2a-executor service - must be before other imports
vi.mock("@/agents/a2a-executor", () => ({
  executeA2AMessage: vi.fn(),
}));

// Mock the auth utils for permission checks
vi.mock("@/auth", () => ({
  userHasPermission: vi.fn(),
}));

import { executeA2AMessage } from "@/agents/a2a-executor";
import { userHasPermission } from "@/auth";
import db, { schema } from "@/database";
import { beforeEach, describe, expect, test } from "@/test";
import type { IncomingEmail } from "@/types";
import { MAX_EMAIL_BODY_SIZE } from "./constants";
import {
  createEmailProvider,
  processIncomingEmail,
  tryMarkEmailAsProcessed,
} from "./index";
import { OutlookEmailProvider } from "./outlook-provider";

/**
 * Helper to create a prompt for testing with optional incoming email settings
 */
async function createTestPrompt(
  agentId: string,
  organizationId: string,
  options?: {
    incomingEmailEnabled?: boolean;
    incomingEmailSecurityMode?: IncomingEmailSecurityMode;
    incomingEmailAllowedDomain?: string;
  },
) {
  const [prompt] = await db
    .insert(schema.promptsTable)
    .values({
      id: crypto.randomUUID(),
      organizationId,
      name: `Test Prompt ${crypto.randomUUID().substring(0, 8)}`,
      agentId,
      userPrompt: null,
      systemPrompt: null,
      version: 1,
      history: [],
      incomingEmailEnabled: options?.incomingEmailEnabled ?? false,
      incomingEmailSecurityMode:
        options?.incomingEmailSecurityMode ?? "private",
      incomingEmailAllowedDomain: options?.incomingEmailAllowedDomain ?? null,
    })
    .returning();
  return prompt;
}

describe("createEmailProvider", () => {
  test("creates OutlookEmailProvider with valid config", () => {
    const provider = createEmailProvider("outlook", {
      provider: "outlook",
      outlook: {
        tenantId: "test-tenant",
        clientId: "test-client",
        clientSecret: "test-secret",
        mailboxAddress: "agents@test.com",
      },
    });

    expect(provider).toBeInstanceOf(OutlookEmailProvider);
    expect(provider.providerId).toBe("outlook");
  });

  test("throws error when outlook config is missing", () => {
    expect(() =>
      createEmailProvider("outlook", {
        provider: "outlook",
        outlook: undefined,
      }),
    ).toThrow("Outlook provider configuration is missing");
  });

  test("throws error for unknown provider type", () => {
    expect(() =>
      createEmailProvider("unknown" as "outlook", {
        provider: "unknown" as "outlook",
      }),
    ).toThrow("Unknown email provider type: unknown");
  });
});

describe("processIncomingEmail", () => {
  beforeEach(async () => {
    vi.clearAllMocks();

    // Set up default mock for executeA2AMessage
    vi.mocked(executeA2AMessage).mockResolvedValue({
      messageId: "msg-123",
      text: "Agent response",
      finishReason: "end_turn",
    });
  });

  test("throws error when provider is null", async () => {
    const email: IncomingEmail = {
      messageId: "test-msg-1",
      toAddress: "agents+agent-prompt-123@test.com",
      fromAddress: "sender@example.com",
      subject: "Test Subject",
      body: "Test body",
      receivedAt: new Date(),
    };

    await expect(processIncomingEmail(email, null)).rejects.toThrow(
      "No email provider configured",
    );
  });

  test("throws error when promptId cannot be extracted", async () => {
    const mockProvider = {
      providerId: "outlook",
      displayName: "Outlook",
      isConfigured: () => true,
      initialize: vi.fn(),
      generateEmailAddress: vi.fn(),
      getEmailDomain: () => "test.com",
      parseWebhookNotification: vi.fn(),
      validateWebhookRequest: vi.fn(),
      handleValidationChallenge: vi.fn(),
      cleanup: vi.fn(),
      extractPromptIdFromEmail: () => null,
    } as unknown as OutlookEmailProvider;

    const email: IncomingEmail = {
      messageId: "test-msg-2",
      toAddress: "invalid-address@test.com",
      fromAddress: "sender@example.com",
      subject: "Test Subject",
      body: "Test body",
      receivedAt: new Date(),
    };

    await expect(processIncomingEmail(email, mockProvider)).rejects.toThrow(
      "Could not extract promptId from email address: invalid-address@test.com",
    );
  });

  test("throws error when prompt is not found", async () => {
    const promptId = crypto.randomUUID();

    const mockProvider = {
      providerId: "outlook",
      displayName: "Outlook",
      isConfigured: () => true,
      initialize: vi.fn(),
      generateEmailAddress: vi.fn(),
      getEmailDomain: () => "test.com",
      parseWebhookNotification: vi.fn(),
      validateWebhookRequest: vi.fn(),
      handleValidationChallenge: vi.fn(),
      cleanup: vi.fn(),
      extractPromptIdFromEmail: () => promptId,
    } as unknown as OutlookEmailProvider;

    const email: IncomingEmail = {
      messageId: "test-msg-3",
      toAddress: `agents+agent-${promptId}@test.com`,
      fromAddress: "sender@example.com",
      subject: "Test Subject",
      body: "Test body",
      receivedAt: new Date(),
    };

    await expect(processIncomingEmail(email, mockProvider)).rejects.toThrow(
      `Prompt ${promptId} not found`,
    );
  });

  test("processes email successfully with valid prompt and team", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeAgent,
  }) => {
    // Create test data
    const user = await makeUser();
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    const agent = await makeAgent({
      teams: [team.id],
    });

    // Create a prompt for the agent with incoming email enabled
    const prompt = await createTestPrompt(agent.id, org.id, {
      incomingEmailEnabled: true,
      incomingEmailSecurityMode: "public",
    });
    const promptId = prompt.id;

    const mockProvider = {
      providerId: "outlook",
      displayName: "Outlook",
      isConfigured: () => true,
      initialize: vi.fn(),
      generateEmailAddress: vi.fn(),
      getEmailDomain: () => "test.com",
      parseWebhookNotification: vi.fn(),
      validateWebhookRequest: vi.fn(),
      handleValidationChallenge: vi.fn(),
      cleanup: vi.fn(),
      extractPromptIdFromEmail: () => promptId,
    } as unknown as OutlookEmailProvider;

    const email: IncomingEmail = {
      messageId: "test-msg-4",
      toAddress: `agents+agent-${promptId}@test.com`,
      fromAddress: "sender@example.com",
      subject: "Test Subject",
      body: "Hello, agent!",
      receivedAt: new Date(),
    };

    await processIncomingEmail(email, mockProvider);

    expect(vi.mocked(executeA2AMessage)).toHaveBeenCalledWith({
      promptId,
      message: "Hello, agent!",
      organizationId: org.id,
      userId: "system",
    });
  });

  test("uses subject when body is empty", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    const agent = await makeAgent({
      teams: [team.id],
    });

    const prompt = await createTestPrompt(agent.id, org.id, {
      incomingEmailEnabled: true,
      incomingEmailSecurityMode: "public",
    });
    const promptId = prompt.id;

    const mockProvider = {
      providerId: "outlook",
      displayName: "Outlook",
      isConfigured: () => true,
      initialize: vi.fn(),
      generateEmailAddress: vi.fn(),
      getEmailDomain: () => "test.com",
      parseWebhookNotification: vi.fn(),
      validateWebhookRequest: vi.fn(),
      handleValidationChallenge: vi.fn(),
      cleanup: vi.fn(),
      extractPromptIdFromEmail: () => promptId,
    } as unknown as OutlookEmailProvider;

    const email: IncomingEmail = {
      messageId: "test-msg-5",
      toAddress: `agents+agent-${promptId}@test.com`,
      fromAddress: "sender@example.com",
      subject: "Subject as message",
      body: "   ", // whitespace only
      receivedAt: new Date(),
    };

    await processIncomingEmail(email, mockProvider);

    expect(vi.mocked(executeA2AMessage)).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Subject as message",
      }),
    );
  });

  test("uses default message when both body and subject are empty", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    const agent = await makeAgent({
      teams: [team.id],
    });

    const prompt = await createTestPrompt(agent.id, org.id, {
      incomingEmailEnabled: true,
      incomingEmailSecurityMode: "public",
    });
    const promptId = prompt.id;

    const mockProvider = {
      providerId: "outlook",
      displayName: "Outlook",
      isConfigured: () => true,
      initialize: vi.fn(),
      generateEmailAddress: vi.fn(),
      getEmailDomain: () => "test.com",
      parseWebhookNotification: vi.fn(),
      validateWebhookRequest: vi.fn(),
      handleValidationChallenge: vi.fn(),
      cleanup: vi.fn(),
      extractPromptIdFromEmail: () => promptId,
    } as unknown as OutlookEmailProvider;

    const email: IncomingEmail = {
      messageId: "test-msg-6",
      toAddress: `agents+agent-${promptId}@test.com`,
      fromAddress: "sender@example.com",
      subject: "",
      body: "",
      receivedAt: new Date(),
    };

    await processIncomingEmail(email, mockProvider);

    expect(vi.mocked(executeA2AMessage)).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "No message content",
      }),
    );
  });

  test("truncates email body exceeding size limit", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    const agent = await makeAgent({
      teams: [team.id],
    });

    const prompt = await createTestPrompt(agent.id, org.id, {
      incomingEmailEnabled: true,
      incomingEmailSecurityMode: "public",
    });
    const promptId = prompt.id;

    const mockProvider = {
      providerId: "outlook",
      displayName: "Outlook",
      isConfigured: () => true,
      initialize: vi.fn(),
      generateEmailAddress: vi.fn(),
      getEmailDomain: () => "test.com",
      parseWebhookNotification: vi.fn(),
      validateWebhookRequest: vi.fn(),
      handleValidationChallenge: vi.fn(),
      cleanup: vi.fn(),
      extractPromptIdFromEmail: () => promptId,
    } as unknown as OutlookEmailProvider;

    // Create a body larger than MAX_EMAIL_BODY_SIZE
    const largeBody = "x".repeat(MAX_EMAIL_BODY_SIZE + 10000);

    const email: IncomingEmail = {
      messageId: "test-msg-7",
      toAddress: `agents+agent-${promptId}@test.com`,
      fromAddress: "sender@example.com",
      subject: "Large email",
      body: largeBody,
      receivedAt: new Date(),
    };

    await processIncomingEmail(email, mockProvider);

    const calledMessage = vi.mocked(executeA2AMessage).mock.calls[0][0].message;

    // The message should be truncated and contain the truncation notice
    expect(calledMessage).toContain(
      `[Message truncated - original size exceeded ${MAX_EMAIL_BODY_SIZE / 1024}KB limit]`,
    );
    // The truncated message (without the notice) should be approximately MAX_EMAIL_BODY_SIZE
    expect(Buffer.byteLength(calledMessage, "utf8")).toBeLessThan(
      MAX_EMAIL_BODY_SIZE + 200,
    ); // Allow some overhead for the truncation notice
  });

  test("does not truncate email body within size limit", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    const agent = await makeAgent({
      teams: [team.id],
    });

    const prompt = await createTestPrompt(agent.id, org.id, {
      incomingEmailEnabled: true,
      incomingEmailSecurityMode: "public",
    });
    const promptId = prompt.id;

    const mockProvider = {
      providerId: "outlook",
      displayName: "Outlook",
      isConfigured: () => true,
      initialize: vi.fn(),
      generateEmailAddress: vi.fn(),
      getEmailDomain: () => "test.com",
      parseWebhookNotification: vi.fn(),
      validateWebhookRequest: vi.fn(),
      handleValidationChallenge: vi.fn(),
      cleanup: vi.fn(),
      extractPromptIdFromEmail: () => promptId,
    } as unknown as OutlookEmailProvider;

    // Create a body just under MAX_EMAIL_BODY_SIZE
    const normalBody = "This is a normal sized email body.";

    const email: IncomingEmail = {
      messageId: "test-msg-8",
      toAddress: `agents+agent-${promptId}@test.com`,
      fromAddress: "sender@example.com",
      subject: "Normal email",
      body: normalBody,
      receivedAt: new Date(),
    };

    await processIncomingEmail(email, mockProvider);

    const calledMessage = vi.mocked(executeA2AMessage).mock.calls[0][0].message;

    // The message should not be truncated
    expect(calledMessage).toBe(normalBody);
    expect(calledMessage).not.toContain("[Message truncated");
  });

  test("throws error when agent has no teams", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    await makeUser(); // Need a user in the system
    const org = await makeOrganization();
    // Create agent without assigning to any team
    const agent = await makeAgent({
      teams: [],
    });

    // Create prompt with email enabled
    const prompt = await createTestPrompt(agent.id, org.id, {
      incomingEmailEnabled: true,
      incomingEmailSecurityMode: "public",
    });
    const promptId = prompt.id;

    const mockProvider = {
      providerId: "outlook",
      displayName: "Outlook",
      isConfigured: () => true,
      initialize: vi.fn(),
      generateEmailAddress: vi.fn(),
      getEmailDomain: () => "test.com",
      parseWebhookNotification: vi.fn(),
      validateWebhookRequest: vi.fn(),
      handleValidationChallenge: vi.fn(),
      cleanup: vi.fn(),
      extractPromptIdFromEmail: () => promptId,
    } as unknown as OutlookEmailProvider;

    const email: IncomingEmail = {
      messageId: "test-msg-9",
      toAddress: `agents+agent-${promptId}@test.com`,
      fromAddress: "sender@example.com",
      subject: "Test",
      body: "Test body",
      receivedAt: new Date(),
    };

    await expect(processIncomingEmail(email, mockProvider)).rejects.toThrow(
      `No teams found for agent ${agent.id}`,
    );
  });

  test("skips duplicate emails (deduplication)", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeAgent,
  }) => {
    // Create test data
    const user = await makeUser();
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    const agent = await makeAgent({
      teams: [team.id],
    });

    // Create a prompt for the agent with incoming email enabled
    const prompt = await createTestPrompt(agent.id, org.id, {
      incomingEmailEnabled: true,
      incomingEmailSecurityMode: "public",
    });
    const promptId = prompt.id;

    const mockProvider = {
      providerId: "outlook",
      displayName: "Outlook",
      isConfigured: () => true,
      initialize: vi.fn(),
      generateEmailAddress: vi.fn(),
      getEmailDomain: () => "test.com",
      parseWebhookNotification: vi.fn(),
      validateWebhookRequest: vi.fn(),
      handleValidationChallenge: vi.fn(),
      cleanup: vi.fn(),
      extractPromptIdFromEmail: () => promptId,
    } as unknown as OutlookEmailProvider;

    const email: IncomingEmail = {
      messageId: "test-dedup-msg-1",
      toAddress: `agents+agent-${promptId}@test.com`,
      fromAddress: "sender@example.com",
      subject: "Test Subject",
      body: "Hello, agent!",
      receivedAt: new Date(),
    };

    // First call should process the email
    await processIncomingEmail(email, mockProvider);
    expect(vi.mocked(executeA2AMessage)).toHaveBeenCalledTimes(1);

    // Reset mock to track subsequent calls
    vi.mocked(executeA2AMessage).mockClear();

    // Second call with same messageId should be skipped (deduplication)
    await processIncomingEmail(email, mockProvider);
    expect(vi.mocked(executeA2AMessage)).not.toHaveBeenCalled();
  });
});

describe("email deduplication helpers", () => {
  test("tryMarkEmailAsProcessed returns true for new messageId", async () => {
    const messageId = `new-msg-${Date.now()}-${Math.random()}`;
    const result = await tryMarkEmailAsProcessed(messageId);
    expect(result).toBe(true);
  });

  test("tryMarkEmailAsProcessed returns false for already processed messageId", async () => {
    const messageId = `dup-msg-${Date.now()}-${Math.random()}`;

    // First call should succeed
    const firstResult = await tryMarkEmailAsProcessed(messageId);
    expect(firstResult).toBe(true);

    // Second call should fail (already processed)
    const secondResult = await tryMarkEmailAsProcessed(messageId);
    expect(secondResult).toBe(false);
  });

  test("tryMarkEmailAsProcessed handles concurrent calls atomically", async () => {
    const messageId = `concurrent-msg-${Date.now()}-${Math.random()}`;

    // Call concurrently - only one should succeed
    const results = await Promise.all([
      tryMarkEmailAsProcessed(messageId),
      tryMarkEmailAsProcessed(messageId),
      tryMarkEmailAsProcessed(messageId),
    ]);

    // Exactly one should be true, the rest should be false
    const successCount = results.filter((r) => r === true).length;
    const failCount = results.filter((r) => r === false).length;

    expect(successCount).toBe(1);
    expect(failCount).toBe(2);
  });
});

describe("processIncomingEmail with sendReply option", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(executeA2AMessage).mockResolvedValue({
      messageId: "msg-reply-test",
      text: "Agent response for reply",
      finishReason: "end_turn",
    });
  });

  test("does not send reply when sendReply option is false (default)", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    const agent = await makeAgent({
      teams: [team.id],
    });

    const prompt = await createTestPrompt(agent.id, org.id, {
      incomingEmailEnabled: true,
      incomingEmailSecurityMode: "public",
    });

    const mockSendReply = vi.fn().mockResolvedValue("reply-id");
    const mockProvider = {
      providerId: "outlook",
      displayName: "Outlook",
      isConfigured: () => true,
      initialize: vi.fn(),
      generateEmailAddress: vi.fn(),
      getEmailDomain: () => "test.com",
      parseWebhookNotification: vi.fn(),
      validateWebhookRequest: vi.fn(),
      handleValidationChallenge: vi.fn(),
      cleanup: vi.fn(),
      extractPromptIdFromEmail: () => prompt.id,
      sendReply: mockSendReply,
    } as unknown as OutlookEmailProvider;

    const email: IncomingEmail = {
      messageId: `test-no-reply-${Date.now()}`,
      toAddress: `agents+agent-${prompt.id}@test.com`,
      fromAddress: "sender@example.com",
      subject: "Test Subject",
      body: "Hello, agent!",
      receivedAt: new Date(),
    };

    await processIncomingEmail(email, mockProvider);

    expect(mockSendReply).not.toHaveBeenCalled();
  });

  test("sends reply when sendReply option is true", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    const agent = await makeAgent({
      teams: [team.id],
    });

    const prompt = await createTestPrompt(agent.id, org.id, {
      incomingEmailEnabled: true,
      incomingEmailSecurityMode: "public",
    });

    const mockSendReply = vi.fn().mockResolvedValue("reply-id-123");
    const mockProvider = {
      providerId: "outlook",
      displayName: "Outlook",
      isConfigured: () => true,
      initialize: vi.fn(),
      generateEmailAddress: vi.fn(),
      getEmailDomain: () => "test.com",
      parseWebhookNotification: vi.fn(),
      validateWebhookRequest: vi.fn(),
      handleValidationChallenge: vi.fn(),
      cleanup: vi.fn(),
      extractPromptIdFromEmail: () => prompt.id,
      sendReply: mockSendReply,
    } as unknown as OutlookEmailProvider;

    const email: IncomingEmail = {
      messageId: `test-with-reply-${Date.now()}`,
      toAddress: `agents+agent-${prompt.id}@test.com`,
      fromAddress: "sender@example.com",
      subject: "Test Subject",
      body: "Hello, agent!",
      receivedAt: new Date(),
    };

    const result = await processIncomingEmail(email, mockProvider, {
      sendReply: true,
    });

    expect(mockSendReply).toHaveBeenCalledWith({
      originalEmail: email,
      body: "Agent response for reply",
      agentName: prompt.name,
    });
    expect(result).toBe("Agent response for reply");
  });

  test("returns agent response text when sendReply succeeds", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    const agent = await makeAgent({
      teams: [team.id],
    });

    const prompt = await createTestPrompt(agent.id, org.id, {
      incomingEmailEnabled: true,
      incomingEmailSecurityMode: "public",
    });

    vi.mocked(executeA2AMessage).mockResolvedValueOnce({
      messageId: "msg-specific",
      text: "Specific agent response",
      finishReason: "end_turn",
    });

    const mockProvider = {
      providerId: "outlook",
      displayName: "Outlook",
      isConfigured: () => true,
      initialize: vi.fn(),
      generateEmailAddress: vi.fn(),
      getEmailDomain: () => "test.com",
      parseWebhookNotification: vi.fn(),
      validateWebhookRequest: vi.fn(),
      handleValidationChallenge: vi.fn(),
      cleanup: vi.fn(),
      extractPromptIdFromEmail: () => prompt.id,
      sendReply: vi.fn().mockResolvedValue("reply-123"),
    } as unknown as OutlookEmailProvider;

    const email: IncomingEmail = {
      messageId: `test-return-value-${Date.now()}`,
      toAddress: `agents+agent-${prompt.id}@test.com`,
      fromAddress: "sender@example.com",
      subject: "Test",
      body: "Test body",
      receivedAt: new Date(),
    };

    const result = await processIncomingEmail(email, mockProvider, {
      sendReply: true,
    });

    expect(result).toBe("Specific agent response");
  });

  test("continues processing even if sendReply fails", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    const agent = await makeAgent({
      teams: [team.id],
    });

    const prompt = await createTestPrompt(agent.id, org.id, {
      incomingEmailEnabled: true,
      incomingEmailSecurityMode: "public",
    });

    const mockSendReply = vi
      .fn()
      .mockRejectedValue(new Error("Failed to send reply"));
    const mockProvider = {
      providerId: "outlook",
      displayName: "Outlook",
      isConfigured: () => true,
      initialize: vi.fn(),
      generateEmailAddress: vi.fn(),
      getEmailDomain: () => "test.com",
      parseWebhookNotification: vi.fn(),
      validateWebhookRequest: vi.fn(),
      handleValidationChallenge: vi.fn(),
      cleanup: vi.fn(),
      extractPromptIdFromEmail: () => prompt.id,
      sendReply: mockSendReply,
    } as unknown as OutlookEmailProvider;

    const email: IncomingEmail = {
      messageId: `test-reply-failure-${Date.now()}`,
      toAddress: `agents+agent-${prompt.id}@test.com`,
      fromAddress: "sender@example.com",
      subject: "Test Subject",
      body: "Hello, agent!",
      receivedAt: new Date(),
    };

    // Should not throw even if sendReply fails
    await expect(
      processIncomingEmail(email, mockProvider, { sendReply: true }),
    ).resolves.not.toThrow();

    expect(mockSendReply).toHaveBeenCalled();
    expect(vi.mocked(executeA2AMessage)).toHaveBeenCalled();
  });
});

describe("processIncomingEmail with conversation history", () => {
  beforeEach(() => {
    vi.mocked(executeA2AMessage).mockReset();
    vi.mocked(executeA2AMessage).mockResolvedValue({
      messageId: "conversation-response-123",
      text: "Agent response with context",
      finishReason: "end_turn",
    });
  });

  test("includes conversation history in message when conversationId is present", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    const agent = await makeAgent({
      teams: [team.id],
    });

    const prompt = await createTestPrompt(agent.id, org.id, {
      incomingEmailEnabled: true,
      incomingEmailSecurityMode: "public",
    });

    const mockGetConversationHistory = vi.fn().mockResolvedValue([
      {
        messageId: "prev-msg-1",
        fromAddress: "user@example.com",
        fromName: "Test User",
        body: "First message from user",
        receivedAt: new Date("2024-01-15T10:00:00Z"),
        isAgentMessage: false,
      },
      {
        messageId: "prev-msg-2",
        fromAddress: "agents@test.com",
        fromName: "Agent",
        body: "Agent's first response",
        receivedAt: new Date("2024-01-15T10:05:00Z"),
        isAgentMessage: true,
      },
    ]);

    const mockProvider = {
      providerId: "outlook",
      displayName: "Outlook",
      isConfigured: () => true,
      initialize: vi.fn(),
      generateEmailAddress: vi.fn(),
      getEmailDomain: () => "test.com",
      parseWebhookNotification: vi.fn(),
      validateWebhookRequest: vi.fn(),
      handleValidationChallenge: vi.fn(),
      cleanup: vi.fn(),
      extractPromptIdFromEmail: () => prompt.id,
      sendReply: vi.fn().mockResolvedValue("reply-123"),
      getConversationHistory: mockGetConversationHistory,
    } as unknown as OutlookEmailProvider;

    const email: IncomingEmail = {
      messageId: `test-with-context-${Date.now()}`,
      conversationId: "conv-123",
      toAddress: `agents+agent-${prompt.id}@test.com`,
      fromAddress: "user@example.com",
      subject: "Follow-up question",
      body: "What was my first message?",
      receivedAt: new Date(),
    };

    await processIncomingEmail(email, mockProvider, { sendReply: false });

    // Verify getConversationHistory was called
    expect(mockGetConversationHistory).toHaveBeenCalledWith(
      "conv-123",
      email.messageId,
    );

    // Verify the message sent to the agent includes conversation history
    expect(vi.mocked(executeA2AMessage)).toHaveBeenCalled();
    const callArgs = vi.mocked(executeA2AMessage).mock.calls[0][0];
    expect(callArgs.message).toContain("<conversation_history>");
    expect(callArgs.message).toContain("First message from user");
    expect(callArgs.message).toContain("Agent's first response");
    expect(callArgs.message).toContain("[User (Test User)]:");
    expect(callArgs.message).toContain("[You (Agent) (Agent)]:");
    expect(callArgs.message).toContain("[Current message from user]:");
    expect(callArgs.message).toContain("What was my first message?");
  });

  test("processes email without conversation history when no conversationId", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    const agent = await makeAgent({
      teams: [team.id],
    });

    const prompt = await createTestPrompt(agent.id, org.id, {
      incomingEmailEnabled: true,
      incomingEmailSecurityMode: "public",
    });

    const mockGetConversationHistory = vi.fn();

    const mockProvider = {
      providerId: "outlook",
      displayName: "Outlook",
      isConfigured: () => true,
      initialize: vi.fn(),
      generateEmailAddress: vi.fn(),
      getEmailDomain: () => "test.com",
      parseWebhookNotification: vi.fn(),
      validateWebhookRequest: vi.fn(),
      handleValidationChallenge: vi.fn(),
      cleanup: vi.fn(),
      extractPromptIdFromEmail: () => prompt.id,
      sendReply: vi.fn().mockResolvedValue("reply-123"),
      getConversationHistory: mockGetConversationHistory,
    } as unknown as OutlookEmailProvider;

    const email: IncomingEmail = {
      messageId: `test-no-context-${Date.now()}`,
      // No conversationId
      toAddress: `agents+agent-${prompt.id}@test.com`,
      fromAddress: "user@example.com",
      subject: "Standalone message",
      body: "Hello, agent!",
      receivedAt: new Date(),
    };

    await processIncomingEmail(email, mockProvider, { sendReply: false });

    // getConversationHistory should NOT be called
    expect(mockGetConversationHistory).not.toHaveBeenCalled();

    // Message should not contain conversation history tags
    const callArgs = vi.mocked(executeA2AMessage).mock.calls[0][0];
    expect(callArgs.message).not.toContain("<conversation_history>");
    expect(callArgs.message).toBe("Hello, agent!");
  });

  test("continues processing when getConversationHistory fails", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    const agent = await makeAgent({
      teams: [team.id],
    });

    const prompt = await createTestPrompt(agent.id, org.id, {
      incomingEmailEnabled: true,
      incomingEmailSecurityMode: "public",
    });

    const mockGetConversationHistory = vi
      .fn()
      .mockRejectedValue(new Error("Failed to fetch history"));

    const mockProvider = {
      providerId: "outlook",
      displayName: "Outlook",
      isConfigured: () => true,
      initialize: vi.fn(),
      generateEmailAddress: vi.fn(),
      getEmailDomain: () => "test.com",
      parseWebhookNotification: vi.fn(),
      validateWebhookRequest: vi.fn(),
      handleValidationChallenge: vi.fn(),
      cleanup: vi.fn(),
      extractPromptIdFromEmail: () => prompt.id,
      sendReply: vi.fn().mockResolvedValue("reply-123"),
      getConversationHistory: mockGetConversationHistory,
    } as unknown as OutlookEmailProvider;

    const email: IncomingEmail = {
      messageId: `test-error-handling-${Date.now()}`,
      conversationId: "conv-error",
      toAddress: `agents+agent-${prompt.id}@test.com`,
      fromAddress: "user@example.com",
      subject: "Test error handling",
      body: "Current message only",
      receivedAt: new Date(),
    };

    // Should not throw
    await expect(
      processIncomingEmail(email, mockProvider, { sendReply: false }),
    ).resolves.not.toThrow();

    // Agent should still be invoked with just the current message
    expect(vi.mocked(executeA2AMessage)).toHaveBeenCalled();
    const callArgs = vi.mocked(executeA2AMessage).mock.calls[0][0];
    expect(callArgs.message).toBe("Current message only");
    expect(callArgs.message).not.toContain("<conversation_history>");
  });
});

describe("processIncomingEmail security modes", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(executeA2AMessage).mockResolvedValue({
      messageId: "msg-security-test",
      text: "Agent security response",
      finishReason: "end_turn",
    });
    // Default: user is not a profile admin
    vi.mocked(userHasPermission).mockResolvedValue(false);
  });

  test("rejects email when incoming email is disabled on the prompt", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    const agent = await makeAgent({
      teams: [team.id],
    });

    // Create prompt with incoming email disabled (default)
    const prompt = await createTestPrompt(agent.id, org.id, {
      incomingEmailEnabled: false,
    });
    const promptId = prompt.id;

    const mockProvider = {
      providerId: "outlook",
      displayName: "Outlook",
      isConfigured: () => true,
      initialize: vi.fn(),
      generateEmailAddress: vi.fn(),
      getEmailDomain: () => "test.com",
      parseWebhookNotification: vi.fn(),
      validateWebhookRequest: vi.fn(),
      handleValidationChallenge: vi.fn(),
      cleanup: vi.fn(),
      extractPromptIdFromEmail: () => promptId,
    } as unknown as OutlookEmailProvider;

    const email: IncomingEmail = {
      messageId: `test-disabled-${Date.now()}`,
      toAddress: `agents+agent-${promptId}@test.com`,
      fromAddress: "sender@example.com",
      subject: "Test",
      body: "Test body",
      receivedAt: new Date(),
    };

    await expect(processIncomingEmail(email, mockProvider)).rejects.toThrow(
      "Incoming email is not enabled for agent",
    );
    expect(vi.mocked(executeA2AMessage)).not.toHaveBeenCalled();
  });

  test("private mode: accepts email from registered user with access", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeAgent,
  }) => {
    const user = await makeUser({ email: "authorized@company.com" });
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    // Add user as a team member (makeTeam only sets createdBy, not membership)
    await makeTeamMember(team.id, user.id);
    const agent = await makeAgent({
      teams: [team.id],
    });

    const prompt = await createTestPrompt(agent.id, org.id, {
      incomingEmailEnabled: true,
      incomingEmailSecurityMode: "private",
    });
    const promptId = prompt.id;

    const mockProvider = {
      providerId: "outlook",
      displayName: "Outlook",
      isConfigured: () => true,
      initialize: vi.fn(),
      generateEmailAddress: vi.fn(),
      getEmailDomain: () => "test.com",
      parseWebhookNotification: vi.fn(),
      validateWebhookRequest: vi.fn(),
      handleValidationChallenge: vi.fn(),
      cleanup: vi.fn(),
      extractPromptIdFromEmail: () => promptId,
    } as unknown as OutlookEmailProvider;

    const email: IncomingEmail = {
      messageId: `test-private-authorized-${Date.now()}`,
      toAddress: `agents+agent-${promptId}@test.com`,
      fromAddress: "authorized@company.com", // Same email as the user
      subject: "Test",
      body: "Private mode test",
      receivedAt: new Date(),
    };

    await processIncomingEmail(email, mockProvider);

    expect(vi.mocked(executeA2AMessage)).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: user.id,
        message: "Private mode test",
      }),
    );
  });

  test("private mode: rejects email from unknown sender", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeAgent,
  }) => {
    const user = await makeUser({ email: "authorized@company.com" });
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    const agent = await makeAgent({
      teams: [team.id],
    });

    const prompt = await createTestPrompt(agent.id, org.id, {
      incomingEmailEnabled: true,
      incomingEmailSecurityMode: "private",
    });
    const promptId = prompt.id;

    const mockProvider = {
      providerId: "outlook",
      displayName: "Outlook",
      isConfigured: () => true,
      initialize: vi.fn(),
      generateEmailAddress: vi.fn(),
      getEmailDomain: () => "test.com",
      parseWebhookNotification: vi.fn(),
      validateWebhookRequest: vi.fn(),
      handleValidationChallenge: vi.fn(),
      cleanup: vi.fn(),
      extractPromptIdFromEmail: () => promptId,
    } as unknown as OutlookEmailProvider;

    const email: IncomingEmail = {
      messageId: `test-private-unknown-${Date.now()}`,
      toAddress: `agents+agent-${promptId}@test.com`,
      fromAddress: "unknown@external.com", // Unknown email
      subject: "Test",
      body: "Test body",
      receivedAt: new Date(),
    };

    await expect(processIncomingEmail(email, mockProvider)).rejects.toThrow(
      "email sender unknown@external.com is not a registered Archestra user",
    );
    expect(vi.mocked(executeA2AMessage)).not.toHaveBeenCalled();
  });

  test("private mode: rejects email from user without team access", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeAgent,
  }) => {
    // Create user without access to the agent's team
    const userWithAccess = await makeUser({ email: "authorized@company.com" });
    // userWithoutAccess exists but is not a team member - we only need to create it
    // to register the email address in the system
    await makeUser({
      email: "noaccess@company.com",
    });
    const org = await makeOrganization();
    const team = await makeTeam(org.id, userWithAccess.id);
    const agent = await makeAgent({
      teams: [team.id],
    });

    const prompt = await createTestPrompt(agent.id, org.id, {
      incomingEmailEnabled: true,
      incomingEmailSecurityMode: "private",
    });
    const promptId = prompt.id;

    const mockProvider = {
      providerId: "outlook",
      displayName: "Outlook",
      isConfigured: () => true,
      initialize: vi.fn(),
      generateEmailAddress: vi.fn(),
      getEmailDomain: () => "test.com",
      parseWebhookNotification: vi.fn(),
      validateWebhookRequest: vi.fn(),
      handleValidationChallenge: vi.fn(),
      cleanup: vi.fn(),
      extractPromptIdFromEmail: () => promptId,
    } as unknown as OutlookEmailProvider;

    const email: IncomingEmail = {
      messageId: `test-private-noaccess-${Date.now()}`,
      toAddress: `agents+agent-${promptId}@test.com`,
      fromAddress: "noaccess@company.com", // User exists but no team access
      subject: "Test",
      body: "Test body",
      receivedAt: new Date(),
    };

    await expect(processIncomingEmail(email, mockProvider)).rejects.toThrow(
      "user noaccess@company.com does not have access to this agent",
    );
    expect(vi.mocked(executeA2AMessage)).not.toHaveBeenCalled();
  });

  test("private mode: accepts email from admin user without team membership", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeAgent,
  }) => {
    // Create an admin user (user exists but is not a team member)
    const adminUser = await makeUser({ email: "admin@company.com" });
    // Create another user who owns the team
    const teamOwner = await makeUser({ email: "owner@company.com" });
    const org = await makeOrganization();
    // Create a team owned by teamOwner, admin is NOT a member
    const team = await makeTeam(org.id, teamOwner.id);
    const agent = await makeAgent({
      teams: [team.id],
    });

    const prompt = await createTestPrompt(agent.id, org.id, {
      incomingEmailEnabled: true,
      incomingEmailSecurityMode: "private",
    });
    const promptId = prompt.id;

    // Mock: adminUser IS a profile admin
    vi.mocked(userHasPermission).mockResolvedValue(true);

    const mockProvider = {
      providerId: "outlook",
      displayName: "Outlook",
      isConfigured: () => true,
      initialize: vi.fn(),
      generateEmailAddress: vi.fn(),
      getEmailDomain: () => "test.com",
      parseWebhookNotification: vi.fn(),
      validateWebhookRequest: vi.fn(),
      handleValidationChallenge: vi.fn(),
      cleanup: vi.fn(),
      extractPromptIdFromEmail: () => promptId,
    } as unknown as OutlookEmailProvider;

    const email: IncomingEmail = {
      messageId: `test-private-admin-${Date.now()}`,
      toAddress: `agents+agent-${promptId}@test.com`,
      fromAddress: "admin@company.com", // Admin user email
      subject: "Test",
      body: "Admin access test",
      receivedAt: new Date(),
    };

    await processIncomingEmail(email, mockProvider);

    // Admin should be able to access agent even without team membership
    expect(vi.mocked(executeA2AMessage)).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: adminUser.id,
        message: "Admin access test",
      }),
    );

    // Verify userHasPermission was called with correct args
    expect(vi.mocked(userHasPermission)).toHaveBeenCalledWith(
      adminUser.id,
      org.id,
      "profile",
      "admin",
    );
  });

  test("internal mode: accepts email from allowed domain", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    const agent = await makeAgent({
      teams: [team.id],
    });

    const prompt = await createTestPrompt(agent.id, org.id, {
      incomingEmailEnabled: true,
      incomingEmailSecurityMode: "internal",
      incomingEmailAllowedDomain: "company.com",
    });
    const promptId = prompt.id;

    const mockProvider = {
      providerId: "outlook",
      displayName: "Outlook",
      isConfigured: () => true,
      initialize: vi.fn(),
      generateEmailAddress: vi.fn(),
      getEmailDomain: () => "test.com",
      parseWebhookNotification: vi.fn(),
      validateWebhookRequest: vi.fn(),
      handleValidationChallenge: vi.fn(),
      cleanup: vi.fn(),
      extractPromptIdFromEmail: () => promptId,
    } as unknown as OutlookEmailProvider;

    const email: IncomingEmail = {
      messageId: `test-internal-allowed-${Date.now()}`,
      toAddress: `agents+agent-${promptId}@test.com`,
      fromAddress: "anyone@company.com", // From allowed domain
      subject: "Test",
      body: "Internal domain test",
      receivedAt: new Date(),
    };

    await processIncomingEmail(email, mockProvider);

    expect(vi.mocked(executeA2AMessage)).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Internal domain test",
      }),
    );
  });

  test("internal mode: rejects email from different domain", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    const agent = await makeAgent({
      teams: [team.id],
    });

    const prompt = await createTestPrompt(agent.id, org.id, {
      incomingEmailEnabled: true,
      incomingEmailSecurityMode: "internal",
      incomingEmailAllowedDomain: "company.com",
    });
    const promptId = prompt.id;

    const mockProvider = {
      providerId: "outlook",
      displayName: "Outlook",
      isConfigured: () => true,
      initialize: vi.fn(),
      generateEmailAddress: vi.fn(),
      getEmailDomain: () => "test.com",
      parseWebhookNotification: vi.fn(),
      validateWebhookRequest: vi.fn(),
      handleValidationChallenge: vi.fn(),
      cleanup: vi.fn(),
      extractPromptIdFromEmail: () => promptId,
    } as unknown as OutlookEmailProvider;

    const email: IncomingEmail = {
      messageId: `test-internal-blocked-${Date.now()}`,
      toAddress: `agents+agent-${promptId}@test.com`,
      fromAddress: "hacker@external.com", // From different domain
      subject: "Test",
      body: "Test body",
      receivedAt: new Date(),
    };

    await expect(processIncomingEmail(email, mockProvider)).rejects.toThrow(
      "emails from domain external.com are not allowed",
    );
    expect(vi.mocked(executeA2AMessage)).not.toHaveBeenCalled();
  });

  test("internal mode: domain comparison is case-insensitive", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    const agent = await makeAgent({
      teams: [team.id],
    });

    const prompt = await createTestPrompt(agent.id, org.id, {
      incomingEmailEnabled: true,
      incomingEmailSecurityMode: "internal",
      incomingEmailAllowedDomain: "COMPANY.COM", // Uppercase
    });
    const promptId = prompt.id;

    const mockProvider = {
      providerId: "outlook",
      displayName: "Outlook",
      isConfigured: () => true,
      initialize: vi.fn(),
      generateEmailAddress: vi.fn(),
      getEmailDomain: () => "test.com",
      parseWebhookNotification: vi.fn(),
      validateWebhookRequest: vi.fn(),
      handleValidationChallenge: vi.fn(),
      cleanup: vi.fn(),
      extractPromptIdFromEmail: () => promptId,
    } as unknown as OutlookEmailProvider;

    const email: IncomingEmail = {
      messageId: `test-internal-case-${Date.now()}`,
      toAddress: `agents+agent-${promptId}@test.com`,
      fromAddress: "user@company.com", // Lowercase domain
      subject: "Test",
      body: "Case test",
      receivedAt: new Date(),
    };

    await processIncomingEmail(email, mockProvider);

    expect(vi.mocked(executeA2AMessage)).toHaveBeenCalled();
  });

  test("public mode: accepts email from any sender", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    const agent = await makeAgent({
      teams: [team.id],
    });

    const prompt = await createTestPrompt(agent.id, org.id, {
      incomingEmailEnabled: true,
      incomingEmailSecurityMode: "public",
    });
    const promptId = prompt.id;

    const mockProvider = {
      providerId: "outlook",
      displayName: "Outlook",
      isConfigured: () => true,
      initialize: vi.fn(),
      generateEmailAddress: vi.fn(),
      getEmailDomain: () => "test.com",
      parseWebhookNotification: vi.fn(),
      validateWebhookRequest: vi.fn(),
      handleValidationChallenge: vi.fn(),
      cleanup: vi.fn(),
      extractPromptIdFromEmail: () => promptId,
    } as unknown as OutlookEmailProvider;

    const email: IncomingEmail = {
      messageId: `test-public-${Date.now()}`,
      toAddress: `agents+agent-${promptId}@test.com`,
      fromAddress: "random@anywhere.org", // Any sender
      subject: "Public Test",
      body: "Public mode test",
      receivedAt: new Date(),
    };

    await processIncomingEmail(email, mockProvider);

    expect(vi.mocked(executeA2AMessage)).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Public mode test",
      }),
    );
  });

  test("rejects email when incoming email is disabled even with internal mode", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    const agent = await makeAgent({
      teams: [team.id],
    });

    // Prompt has internal mode configured but email is disabled
    const prompt = await createTestPrompt(agent.id, org.id, {
      incomingEmailEnabled: false,
      incomingEmailSecurityMode: "internal",
      incomingEmailAllowedDomain: "company.com",
    });
    const promptId = prompt.id;

    const mockProvider = {
      providerId: "outlook",
      displayName: "Outlook",
      isConfigured: () => true,
      initialize: vi.fn(),
      generateEmailAddress: vi.fn(),
      getEmailDomain: () => "test.com",
      parseWebhookNotification: vi.fn(),
      validateWebhookRequest: vi.fn(),
      handleValidationChallenge: vi.fn(),
      cleanup: vi.fn(),
      extractPromptIdFromEmail: () => promptId,
    } as unknown as OutlookEmailProvider;

    const email: IncomingEmail = {
      messageId: `test-disabled-internal-${Date.now()}`,
      toAddress: `agents+agent-${promptId}@test.com`,
      fromAddress: "user@company.com", // From allowed domain, but email disabled
      subject: "Test",
      body: "Test body",
      receivedAt: new Date(),
    };

    await expect(processIncomingEmail(email, mockProvider)).rejects.toThrow(
      "Incoming email is not enabled for agent",
    );
    expect(vi.mocked(executeA2AMessage)).not.toHaveBeenCalled();
  });

  test("rejects email when incoming email is disabled even with public mode", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    const agent = await makeAgent({
      teams: [team.id],
    });

    // Prompt has public mode configured but email is disabled
    const prompt = await createTestPrompt(agent.id, org.id, {
      incomingEmailEnabled: false,
      incomingEmailSecurityMode: "public",
    });
    const promptId = prompt.id;

    const mockProvider = {
      providerId: "outlook",
      displayName: "Outlook",
      isConfigured: () => true,
      initialize: vi.fn(),
      generateEmailAddress: vi.fn(),
      getEmailDomain: () => "test.com",
      parseWebhookNotification: vi.fn(),
      validateWebhookRequest: vi.fn(),
      handleValidationChallenge: vi.fn(),
      cleanup: vi.fn(),
      extractPromptIdFromEmail: () => promptId,
    } as unknown as OutlookEmailProvider;

    const email: IncomingEmail = {
      messageId: `test-disabled-public-${Date.now()}`,
      toAddress: `agents+agent-${promptId}@test.com`,
      fromAddress: "anyone@anywhere.com", // Public mode, but email disabled
      subject: "Test",
      body: "Test body",
      receivedAt: new Date(),
    };

    await expect(processIncomingEmail(email, mockProvider)).rejects.toThrow(
      "Incoming email is not enabled for agent",
    );
    expect(vi.mocked(executeA2AMessage)).not.toHaveBeenCalled();
  });
});
