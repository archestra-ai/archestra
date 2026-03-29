import { describe, expect, it, vi, beforeEach } from "vitest";
import { NotionConnector } from "./notion-connector";

describe("NotionConnector", () => {
  let connector: NotionConnector;

  beforeEach(() => {
    connector = new NotionConnector();
  });

  describe("validateConfig", () => {
    it("should accept valid config with parentPageIds", async () => {
      const result = await connector.validateConfig({
        type: "notion",
        parentPageIds: ["abc-123"],
      });
      expect(result.valid).toBe(true);
    });

    it("should accept valid config with databaseIds", async () => {
      const result = await connector.validateConfig({
        type: "notion",
        databaseIds: ["db-456"],
      });
      expect(result.valid).toBe(true);
    });

    it("should accept empty config (sync all accessible pages)", async () => {
      const result = await connector.validateConfig({
        type: "notion",
      });
      expect(result.valid).toBe(true);
    });

    it("should reject invalid config", async () => {
      const result = await connector.validateConfig({
        type: "wrong-type",
      });
      expect(result.valid).toBe(false);
    });
  });

  describe("type", () => {
    it('should have type "notion"', () => {
      expect(connector.type).toBe("notion");
    });
  });
});
