import { describe, expect, test } from "@/test";
import { SalesforceConnector } from "./salesforce-connector";

describe("SalesforceConnector", () => {
  test("exposes salesforce connector type", () => {
    expect(new SalesforceConnector().type).toBe("salesforce");
  });

  describe("validateConfig", () => {
    test("accepts minimal valid config", async () => {
      const connector = new SalesforceConnector();
      const result = await connector.validateConfig({});
      expect(result).toEqual({ valid: true });
    });

    test("rejects invalid advanced object JSON text", async () => {
      const connector = new SalesforceConnector();
      const result = await connector.validateConfig({
        advancedObjectConfigJson: "[1,2,3]",
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain("advancedObjectConfigJson");
    });
  });

  describe("phase placeholders", () => {
    test("testConnection returns explicit phase-not-implemented error", async () => {
      const connector = new SalesforceConnector();
      const result = await connector.testConnection({
        config: {},
        credentials: { email: "test@example.com", apiToken: "token" },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Phase 2");
    });

    test("sync throws explicit phase-not-implemented error", async () => {
      const connector = new SalesforceConnector();

      await expect(async () => {
        for await (const _ of connector.sync({
          config: {},
          credentials: { email: "test@example.com", apiToken: "token" },
          checkpoint: null,
        })) {
          // noop
        }
      }).rejects.toThrow("Phase 2");
    });
  });
});
