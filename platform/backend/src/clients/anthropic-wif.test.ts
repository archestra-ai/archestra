import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import { getAnthropicWifToken, isAnthropicWifEnabled } from "./anthropic-wif";
import config from "@/config";

// Mock dependencies
vi.mock("node:fs");
vi.mock("@/config", () => ({
  default: {
    llm: {
      anthropic: {
        wif: {
          enabled: true,
          ruleId: "rule-123",
          organizationId: "org-123",
          serviceAccountId: "svc-123",
          identityToken: "",
          identityTokenFile: "",
        },
      },
    },
  },
}));

describe("Anthropic WIF Client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    config.llm.anthropic.wif.identityToken = "";
    config.llm.anthropic.wif.identityTokenFile = "";
  });

  it("should return true when WIF is enabled", () => {
    expect(isAnthropicWifEnabled()).toBe(true);
  });

  it("should exchange identity token for access token", async () => {
    config.llm.anthropic.wif.identityToken = "mock-jwt";
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "anthropic-access-token",
        expires_in: 3600,
      }),
    } as Response);

    const token = await getAnthropicWifToken();

    expect(token).toBe("anthropic-access-token");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/oauth/token",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"assertion":"mock-jwt"'),
      })
    );
  });

  it("should read identity token from file if provided", async () => {
    config.llm.anthropic.wif.identityTokenFile = "/path/to/token";
    vi.mocked(fs.readFileSync).mockReturnValueOnce("token-from-file");
    
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "file-token",
        expires_in: 3600,
      }),
    } as Response);

    const token = await getAnthropicWifToken();

    expect(fs.readFileSync).toHaveBeenCalledWith("/path/to/token", "utf8");
    expect(token).toBe("file-token");
  });

  it("should throw error if token exchange fails", async () => {
    config.llm.anthropic.wif.identityToken = "bad-jwt";
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => "Invalid token",
    } as Response);

    await expect(getAnthropicWifToken()).rejects.toThrow(
      "Anthropic token exchange failed (400): Invalid token"
    );
  });
});
