import { describe, expect, test, vi, beforeEach } from "vitest";

// Mock config before importing the module
vi.mock("@/config", () => ({
  default: {
    llm: {
      anthropic: {
        baseUrl: "https://api.anthropic.com",
        workloadIdentityFederation: {
          enabled: true,
          federationRuleId: "fdrl_test123",
          organizationId: "org-123",
          serviceAccountId: "svac_test",
          workspaceId: "wrkspc_test",
          identityTokenFile: "/tmp/test-token",
        },
      },
    },
  },
}));

// Mock fs/promises
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => "mock-oidc-jwt-token"),
}));

import { isAnthropicWifEnabled, getAnthropicWifAccessToken } from "./anthropic-wif-credentials";

describe("Anthropic WIF Credentials", () => {
  test("isAnthropicWifEnabled returns true when fully configured", () => {
    expect(isAnthropicWifEnabled()).toBe(true);
  });

  test("getAnthropicWifAccessToken exchanges JWT for access token", async () => {
    const mockResponse = {
      access_token: "test-access-token",
      expires_in: 3600,
      token_type: "Bearer",
      scope: "workspace:developer",
    };

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(mockResponse)));

    const token = await getAnthropicWifAccessToken();

    expect(token).toBe("test-access-token");
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/oauth/token",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: expect.stringContaining("fdrl_test123"),
      }),
    );

    fetchSpy.mockRestore();
  });
});
