import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createAnthropicWorkloadIdentityFetch,
  getAnthropicWorkloadIdentityAccessToken,
  hasAnthropicSdkStaticCredentialsConfigured,
  isAnthropicWorkloadIdentityConfigured,
  resetAnthropicWorkloadIdentityTokenCacheForTests,
} from "./anthropic-workload-identity";

const WIF_ENV_KEYS = [
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_SERVICE_ACCOUNT_ID",
  "ANTHROPIC_WORKSPACE_ID",
  "ANTHROPIC_IDENTITY_TOKEN",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
] as const;

const originalEnv = Object.fromEntries(
  WIF_ENV_KEYS.map((key) => [key, process.env[key]]),
);

function restoreEnv() {
  for (const key of WIF_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function configureWifEnv(
  overrides: Partial<Record<(typeof WIF_ENV_KEYS)[number], string>> = {},
) {
  process.env.ANTHROPIC_FEDERATION_RULE_ID = "fdrl_test";
  process.env.ANTHROPIC_ORGANIZATION_ID =
    "00000000-0000-0000-0000-000000000000";
  process.env.ANTHROPIC_SERVICE_ACCOUNT_ID = "svac_test";
  process.env.ANTHROPIC_WORKSPACE_ID = "wrkspc_test";
  process.env.ANTHROPIC_IDENTITY_TOKEN = "jwt-from-env";
  delete process.env.ANTHROPIC_IDENTITY_TOKEN_FILE;

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key as (typeof WIF_ENV_KEYS)[number]];
    } else {
      process.env[key as (typeof WIF_ENV_KEYS)[number]] = value;
    }
  }
}

describe("Anthropic Workload Identity Federation", () => {
  beforeEach(() => {
    resetAnthropicWorkloadIdentityTokenCacheForTests();
    vi.restoreAllMocks();
    restoreEnv();
  });

  afterEach(() => {
    resetAnthropicWorkloadIdentityTokenCacheForTests();
    vi.restoreAllMocks();
    restoreEnv();
  });

  test("detects a complete direct environment configuration", () => {
    configureWifEnv();

    expect(isAnthropicWorkloadIdentityConfigured()).toBe(true);
  });

  test("does not activate without an identity token source", () => {
    configureWifEnv({ ANTHROPIC_IDENTITY_TOKEN: undefined });

    expect(isAnthropicWorkloadIdentityConfigured()).toBe(false);
  });

  test("detects SDK static credentials as higher precedence", () => {
    configureWifEnv();
    process.env.ANTHROPIC_API_KEY = "";

    expect(hasAnthropicSdkStaticCredentialsConfigured()).toBe(true);
  });

  test("exchanges an identity token file for an access token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "anthropic-wif-"));
    const tokenFile = join(dir, "token.jwt");
    await writeFile(tokenFile, "jwt-from-file\n", "utf8");
    configureWifEnv({
      ANTHROPIC_IDENTITY_TOKEN: undefined,
      ANTHROPIC_IDENTITY_TOKEN_FILE: tokenFile,
    });

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "sk-ant-oat01-test",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "workspace:developer",
        }),
        { status: 200 },
      ),
    );

    await expect(
      getAnthropicWorkloadIdentityAccessToken("https://api.anthropic.com"),
    ).resolves.toBe("sk-ant-oat01-test");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/oauth/token",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: "jwt-from-file",
          federation_rule_id: "fdrl_test",
          organization_id: "00000000-0000-0000-0000-000000000000",
          service_account_id: "svac_test",
          workspace_id: "wrkspc_test",
        }),
      }),
    );

    await rm(dir, { recursive: true, force: true });
  });

  test("caches exchanged access tokens", async () => {
    configureWifEnv();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "sk-ant-oat01-cached",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "workspace:developer",
        }),
        { status: 200 },
      ),
    );

    await getAnthropicWorkloadIdentityAccessToken(undefined);
    await getAnthropicWorkloadIdentityAccessToken(undefined);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("injects a federated bearer token into Anthropic requests", async () => {
    configureWifEnv();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "sk-ant-oat01-wrapper",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "workspace:developer",
        }),
        { status: 200 },
      ),
    );
    const providerFetch = vi.fn().mockResolvedValue(new Response("{}"));
    const wrappedFetch = createAnthropicWorkloadIdentityFetch(
      providerFetch as typeof fetch,
      "https://api.anthropic.com/",
    );

    await wrappedFetch("https://api.anthropic.com/v1/messages", {
      headers: {
        "x-api-key": "placeholder",
        "anthropic-version": "2023-06-01",
      },
    });

    expect(providerFetch).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
    const headers = providerFetch.mock.calls[0][1].headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer sk-ant-oat01-wrapper");
    expect(headers.has("x-api-key")).toBe(false);
  });
});
