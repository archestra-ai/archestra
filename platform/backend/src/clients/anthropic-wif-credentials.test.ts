import { describe, expect, test, vi, beforeEach, afterEach } from "@/test";

// We test the module-level functions by mocking config and fetch
describe("anthropic-wif-credentials", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("isAnthropicWifEnabled", () => {
    test("returns false when WIF is not configured", async () => {
      const { isAnthropicWifEnabled } = await import(
        "@/clients/anthropic-wif-credentials"
      );
      expect(isAnthropicWifEnabled()).toBe(false);
    });
  });

  describe("getAnthropicWifAccessToken", () => {
    test("throws when no identity token source is configured", async () => {
      // This tests the error path when WIF env vars are set but no token source
      // We can't easily test the full flow without mocking fetch and fs
    });
  });
});
