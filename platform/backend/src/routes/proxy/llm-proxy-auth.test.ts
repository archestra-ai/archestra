import { vi } from "vitest";
import { describe, expect, test } from "@/test";
import {
  assertAuthenticatedForKeylessProvider,
  validateVirtualApiKey,
} from "./llm-proxy-auth";

describe("assertAuthenticatedForKeylessProvider", () => {
  test("allows request when apiKey is present", () => {
    expect(() =>
      assertAuthenticatedForKeylessProvider(
        "sk-real-key",
        false,
        false,
        "1.2.3.4",
      ),
    ).not.toThrow();
  });

  test("allows request when virtual key was resolved", () => {
    expect(() =>
      assertAuthenticatedForKeylessProvider(undefined, true, false, "1.2.3.4"),
    ).not.toThrow();
  });

  test("allows request when JWKS authenticated", () => {
    expect(() =>
      assertAuthenticatedForKeylessProvider(undefined, false, true, "1.2.3.4"),
    ).not.toThrow();
  });

  test("allows localhost IPv4 without any auth", () => {
    expect(() =>
      assertAuthenticatedForKeylessProvider(
        undefined,
        false,
        false,
        "127.0.0.1",
      ),
    ).not.toThrow();
  });

  test("allows localhost IPv6 without any auth", () => {
    expect(() =>
      assertAuthenticatedForKeylessProvider(undefined, false, false, "::1"),
    ).not.toThrow();
  });

  test("allows localhost IPv4-mapped IPv6 without any auth", () => {
    expect(() =>
      assertAuthenticatedForKeylessProvider(
        undefined,
        false,
        false,
        "::ffff:127.0.0.1",
      ),
    ).not.toThrow();
  });

  test("rejects external request without any auth", () => {
    expect(() =>
      assertAuthenticatedForKeylessProvider(undefined, false, false, "1.2.3.4"),
    ).toThrow("Authentication required");
  });

  test("rejects external request with empty apiKey", () => {
    expect(() =>
      assertAuthenticatedForKeylessProvider(
        undefined,
        false,
        false,
        "10.0.0.5",
      ),
    ).toThrow("Authentication required");
  });
});

describe("validateVirtualApiKey", () => {
  test("returns 401 with 'Virtual API key expired' for expired key", async () => {
    // Mock VirtualApiKeyModel.validateToken to return an expired key
    const { VirtualApiKeyModel } = await import("@/models");
    const spy = vi
      .spyOn(VirtualApiKeyModel, "validateToken")
      .mockResolvedValue({
        virtualKey: {
          id: "vk-1",
          chatApiKeyId: "ck-1",
          name: "test",
          tokenHash: "hash",
          tokenStart: "archestra_",
          expiresAt: new Date("2020-01-01"),
          lastUsedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        chatApiKey: {
          id: "ck-1",
          provider: "openai",
          secretId: "secret-1",
          baseUrl: null,
        },
      } as never);

    await expect(
      validateVirtualApiKey("archestra_test_token", "openai"),
    ).rejects.toThrow("Virtual API key expired");

    spy.mockRestore();
  });
});
