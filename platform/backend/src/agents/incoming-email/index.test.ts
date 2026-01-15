import { vi } from "vitest";

// Mock the a2a-executor service - must be before other imports
vi.mock("@/services/a2a-executor", () => ({
  executeA2AMessage: vi.fn(),
}));

import db, { schema } from "@/database";
import { executeA2AMessage } from "@/services/a2a-executor";
import { beforeEach, describe, expect, test } from "@/test";
import type { IncomingEmail } from "@/types";
import { MAX_EMAIL_BODY_SIZE } from "./constants";
import {
  createEmailProvider,
  isEmailAlreadyProcessed,
  markEmailAsProcessed,
  processIncomingEmail,
} from "./index";
import { OutlookEmailProvider } from "./outlook-provider";

/**
 * Helper to create a prompt for testing
 */
async function createTestPrompt(agentId: string, organizationId: string) {
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
  const mockExecuteA2AMessage = vi.mocked(executeA2AMessage);

  beforeEach(async () => {
    vi.clearAllMocks();

    // Set up default mock for executeA2AMessage
    mockExecuteA2AMessage.mockResolvedValue({
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
    const agent = await makeAgent({ teams: [team.id] });

    // Create a prompt for the agent
    const prompt = await createTestPrompt(agent.id, org.id);
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

    expect(mockExecuteA2AMessage).toHaveBeenCalledWith({
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
    const agent = await makeAgent({ teams: [team.id] });

    const prompt = await createTestPrompt(agent.id, org.id);
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

    expect(mockExecuteA2AMessage).toHaveBeenCalledWith(
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
    const agent = await makeAgent({ teams: [team.id] });

    const prompt = await createTestPrompt(agent.id, org.id);
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

    expect(mockExecuteA2AMessage).toHaveBeenCalledWith(
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
    const agent = await makeAgent({ teams: [team.id] });

    const prompt = await createTestPrompt(agent.id, org.id);
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

    const calledMessage = mockExecuteA2AMessage.mock.calls[0][0].message;

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
    const agent = await makeAgent({ teams: [team.id] });

    const prompt = await createTestPrompt(agent.id, org.id);
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

    const calledMessage = mockExecuteA2AMessage.mock.calls[0][0].message;

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
    const agent = await makeAgent({ teams: [] });

    const prompt = await createTestPrompt(agent.id, org.id);
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
    const agent = await makeAgent({ teams: [team.id] });

    // Create a prompt for the agent
    const prompt = await createTestPrompt(agent.id, org.id);
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
    expect(mockExecuteA2AMessage).toHaveBeenCalledTimes(1);

    // Reset mock to track subsequent calls
    mockExecuteA2AMessage.mockClear();

    // Second call with same messageId should be skipped (deduplication)
    await processIncomingEmail(email, mockProvider);
    expect(mockExecuteA2AMessage).not.toHaveBeenCalled();
  });
});

describe("email deduplication helpers", () => {
  test("isEmailAlreadyProcessed returns false for new messageId", async () => {
    const messageId = `new-msg-${Date.now()}`;
    const result = await isEmailAlreadyProcessed(messageId);
    expect(result).toBe(false);
  });

  test("markEmailAsProcessed marks email as processed", async () => {
    const messageId = `mark-msg-${Date.now()}`;

    // Initially not processed
    expect(await isEmailAlreadyProcessed(messageId)).toBe(false);

    // Mark as processed
    await markEmailAsProcessed(messageId);

    // Now should be processed
    expect(await isEmailAlreadyProcessed(messageId)).toBe(true);
  });

  test("isEmailAlreadyProcessed returns true for recently processed messageId", async () => {
    const messageId = `recent-msg-${Date.now()}`;

    await markEmailAsProcessed(messageId);
    const result = await isEmailAlreadyProcessed(messageId);
    expect(result).toBe(true);
  });
});
