import { describe, expect, test } from "@/test";
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
});
