import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AnthropicWifConfig } from "@/config";

const mockConfig = vi.hoisted(() => ({
  llm: {
    anthropic: {
      baseUrl: "https://api.anthropic.com",
      wif: null as AnthropicWifConfig | null,
    },
  },
}));

vi.mock("@/config", () => ({ default: mockConfig }));

import { anthropicWorkloadIdentity } from "./anthropic-workload-identity";

const WIF_CONFIG: AnthropicWifConfig = {
  federationRuleId: "fdrl_test",
  organizationId: "00000000-0000-0000-0000-000000000000",
  serviceAccountId: "svac_test",
  workspaceId: "wrkspc_test",
  identityToken: "jwt-inline",
};

function tokenResponse(accessToken: string, expiresIn = 3600): Response {
  return new Response(
    JSON.stringify({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: expiresIn,
      scope: "workspace:developer",
    }),
    { status: 200 },
  );
}

describe("anthropicWorkloadIdentity", () => {
  const originalStaticEnv = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
  };

  beforeEach(() => {
    anthropicWorkloadIdentity.resetForTests();
    mockConfig.llm.anthropic.baseUrl = "https://api.anthropic.com";
    mockConfig.llm.anthropic.wif = { ...WIF_CONFIG };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    for (const [key, value] of Object.entries(originalStaticEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  describe("isEnabled", () => {
    test("enabled with complete config", () => {
      expect(anthropicWorkloadIdentity.isEnabled()).toBe(true);
    });

    test("disabled when WIF is not configured", () => {
      mockConfig.llm.anthropic.wif = null;
      expect(anthropicWorkloadIdentity.isEnabled()).toBe(false);
    });

    test("shadowed by static SDK env credentials (documented precedence)", () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-static";
      expect(anthropicWorkloadIdentity.isEnabled()).toBe(false);
    });
  });

  describe("getAccessToken", () => {
    test("exchanges the identity token via the RFC 7523 jwt-bearer grant", async () => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(tokenResponse("sk-ant-oat01-test"));

      await expect(anthropicWorkloadIdentity.getAccessToken()).resolves.toBe(
        "sk-ant-oat01-test",
      );

      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.anthropic.com/v1/oauth/token",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion: "jwt-inline",
            federation_rule_id: "fdrl_test",
            organization_id: "00000000-0000-0000-0000-000000000000",
            service_account_id: "svac_test",
            workspace_id: "wrkspc_test",
          }),
        },
      );
    });

    test("omits workspace_id when not configured", async () => {
      mockConfig.llm.anthropic.wif = { ...WIF_CONFIG, workspaceId: undefined };
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(tokenResponse("sk-ant-oat01-test"));

      await anthropicWorkloadIdentity.getAccessToken();

      const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
      expect(body).not.toHaveProperty("workspace_id");
    });

    test("caches the token until the advisory refresh window", async () => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(tokenResponse("sk-ant-oat01-cached"));

      await anthropicWorkloadIdentity.getAccessToken();
      await anthropicWorkloadIdentity.getAccessToken();

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test("deduplicates concurrent exchanges", async () => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(tokenResponse("sk-ant-oat01-dedup"));

      await Promise.all([
        anthropicWorkloadIdentity.getAccessToken(),
        anthropicWorkloadIdentity.getAccessToken(),
        anthropicWorkloadIdentity.getAccessToken(),
      ]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test("re-exchanges inside the advisory window and serves the cached token if the exchange fails", async () => {
      vi.useFakeTimers();
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(tokenResponse("sk-ant-oat01-first", 3600));

      await anthropicWorkloadIdentity.getAccessToken();

      // Inside the advisory window (120s before expiry) but outside the
      // mandatory window (30s): a failed refresh falls back to the cache.
      vi.setSystemTime(Date.now() + (3600 - 60) * 1000);
      fetchMock.mockRejectedValue(new Error("token endpoint unreachable"));

      await expect(anthropicWorkloadIdentity.getAccessToken()).resolves.toBe(
        "sk-ant-oat01-first",
      );
    });

    test("fails hard inside the mandatory refresh window", async () => {
      vi.useFakeTimers();
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(tokenResponse("sk-ant-oat01-first", 3600));

      await anthropicWorkloadIdentity.getAccessToken();

      vi.setSystemTime(Date.now() + (3600 - 10) * 1000);
      fetchMock.mockRejectedValue(new Error("token endpoint unreachable"));

      await expect(anthropicWorkloadIdentity.getAccessToken()).rejects.toThrow(
        "token endpoint unreachable",
      );
    });

    test("re-reads the identity token file on every exchange (rotated projected tokens)", async () => {
      vi.useFakeTimers();
      const dir = await mkdtemp(join(tmpdir(), "anthropic-wif-"));
      const tokenFile = join(dir, "token.jwt");
      await writeFile(tokenFile, "jwt-generation-1\n", "utf8");
      mockConfig.llm.anthropic.wif = {
        ...WIF_CONFIG,
        identityToken: undefined,
        identityTokenFile: tokenFile,
      };
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () =>
          tokenResponse("sk-ant-oat01-file", 3600),
        );

      await anthropicWorkloadIdentity.getAccessToken();
      await writeFile(tokenFile, "jwt-generation-2\n", "utf8");
      vi.setSystemTime(Date.now() + 3600 * 1000);
      await anthropicWorkloadIdentity.getAccessToken();

      const assertions = fetchMock.mock.calls.map(
        (call) => JSON.parse(call[1]?.body as string).assertion,
      );
      expect(assertions).toEqual(["jwt-generation-1", "jwt-generation-2"]);

      await rm(dir, { recursive: true, force: true });
    });

    test("surfaces non-OK exchange responses with the request id", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("{}", {
          status: 403,
          headers: { "request-id": "req_123" },
        }),
      );

      await expect(anthropicWorkloadIdentity.getAccessToken()).rejects.toThrow(
        "token exchange failed with status 403 (request-id: req_123)",
      );
    });

    test("rejects token responses without a usable access token", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ access_token: "", expires_in: 3600 }), {
          status: 200,
        }),
      );

      await expect(anthropicWorkloadIdentity.getAccessToken()).rejects.toThrow(
        "invalid token response",
      );
    });
  });

  describe("createFetch", () => {
    test("injects the federated bearer token and strips x-api-key", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        tokenResponse("sk-ant-oat01-wrapped"),
      );
      const providerFetch = vi.fn().mockResolvedValue(new Response("{}"));
      const wrappedFetch = anthropicWorkloadIdentity.createFetch(
        providerFetch as typeof fetch,
      );

      await wrappedFetch("https://api.anthropic.com/v1/messages", {
        headers: {
          "x-api-key": "placeholder",
          "anthropic-version": "2023-06-01",
        },
      });

      const headers = providerFetch.mock.calls[0][1].headers as Headers;
      expect(headers.get("authorization")).toBe("Bearer sk-ant-oat01-wrapped");
      expect(headers.has("x-api-key")).toBe(false);
      expect(headers.get("anthropic-version")).toBe("2023-06-01");
    });
  });
});
