import { describe, expect, it } from "vitest";
import { isCimdClientId } from "./cimd";

describe("CIMD", () => {
  describe("isCimdClientId", () => {
    it("returns true for HTTPS URL with path", () => {
      expect(isCimdClientId("https://example.com/client-metadata.json")).toBe(
        true,
      );
    });

    it("returns true for HTTP URL with path", () => {
      expect(
        isCimdClientId("http://localhost:9092/cimd/test-client.json"),
      ).toBe(true);
    });

    it("returns true for URL with nested path", () => {
      expect(
        isCimdClientId("https://myapp.example.com/oauth/client.json"),
      ).toBe(true);
    });

    it("returns false for URL without path (just host)", () => {
      // Just "https://example.com" has pathname "/" which is length 1
      expect(isCimdClientId("https://example.com")).toBe(false);
    });

    it("returns false for URL with trailing slash only", () => {
      expect(isCimdClientId("https://example.com/")).toBe(false);
    });

    it("returns false for non-URL string", () => {
      expect(isCimdClientId("my-client-id")).toBe(false);
    });

    it("returns false for UUID-style client_id", () => {
      expect(isCimdClientId("550e8400-e29b-41d4-a716-446655440000")).toBe(
        false,
      );
    });

    it("returns false for empty string", () => {
      expect(isCimdClientId("")).toBe(false);
    });

    it("returns false for non-http scheme", () => {
      expect(isCimdClientId("ftp://example.com/file.json")).toBe(false);
    });

    it("returns false for mailto: URI", () => {
      expect(isCimdClientId("mailto:user@example.com")).toBe(false);
    });
  });
});
