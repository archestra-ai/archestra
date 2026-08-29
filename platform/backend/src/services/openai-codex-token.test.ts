import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiError } from "@/types";
import type { OpenAiCodexCredential } from "./openai-codex-credentials";
import {
  createOpenAiCodexFetch,
  openAiCodexTokenManager,
} from "./openai-codex-token";

const CREDENTIAL: OpenAiCodexCredential = {
  refreshToken: "rt_secret",
  accountId: "acc_123",
};

function tokenResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("openAiCodexTokenManager.getAccessToken (uncached, no key id)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        tokenResponse({ access_token: "at_1", expires_in: 3600 }),
      ),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("redeems the refresh token for an access token", async () => {
    const token = await openAiCodexTokenManager.getAccessToken({
      refreshToken: CREDENTIAL.refreshToken,
    });
    expect(token).toBe("at_1");

    const fetchMock = vi.mocked(fetch);
    const init = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      grant_type: "refresh_token",
      refresh_token: CREDENTIAL.refreshToken,
      client_id: expect.any(String),
    });
    const headers = new Headers(init?.headers);
    expect(headers.get("originator")).toBe("archestra");
    expect(headers.get("user-agent")).toMatch(/^archestra\//);
  });

  it("uses the access token from sign-in without immediately refreshing it", async () => {
    const fetchMock = vi.mocked(fetch);
    const token = await openAiCodexTokenManager.getAccessToken({
      refreshToken: CREDENTIAL.refreshToken,
      accessToken: "at_from_sign_in",
      accessTokenExpiresAtMs: Date.now() + 60 * 60 * 1000,
    });

    expect(token).toBe("at_from_sign_in");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a 401 when OpenAI rejects the refresh token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => tokenResponse({ error: "invalid_grant" }, 400)),
    );
    await expect(
      openAiCodexTokenManager.getAccessToken({
        refreshToken: CREDENTIAL.refreshToken,
      }),
    ).rejects.toMatchObject({ statusCode: 401 } satisfies Partial<ApiError>);
  });
});

describe("createOpenAiCodexFetch", () => {
  beforeEach(() => {
    // Global fetch backs the OAuth token redemption; the Codex request itself
    // goes through the injected innerFetch so we can inspect its headers.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        tokenResponse({ access_token: "at_fresh", expires_in: 3600 }),
      ),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("injects the ChatGPT identity headers on every request", async () => {
    let capturedInit: RequestInit | undefined;
    const innerFetch = vi.fn(async (_input, init?: RequestInit) => {
      capturedInit = init;
      return new Response("{}", { status: 200 });
    });

    const codexFetch = createOpenAiCodexFetch({
      credential: CREDENTIAL,
      sessionId: "sess_1",
      innerFetch,
    });
    await codexFetch("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      body: "{}",
    });

    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("authorization")).toBe("Bearer at_fresh");
    expect(headers.get("chatgpt-account-id")).toBe("acc_123");
    expect(headers.get("originator")).toBe("archestra");
    expect(headers.get("openai-beta")).toBe("responses=experimental");
    expect(headers.get("session-id")).toBe("sess_1");
    expect(headers.get("user-agent")).toMatch(/^archestra\//);
  });

  it("retries exactly once after a 401 from the Codex backend", async () => {
    const innerFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("nope", { status: 401 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    const codexFetch = createOpenAiCodexFetch({
      credential: CREDENTIAL,
      sessionId: "sess_1",
      innerFetch,
    });
    const response = await codexFetch(
      "https://chatgpt.com/backend-api/codex/responses",
      { method: "POST", body: "{}" },
    );

    expect(innerFetch).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(200);
  });

  it("refreshes instead of replaying a sign-in token rejected before expiry", async () => {
    const authorizationHeaders: string[] = [];
    const innerFetch = vi.fn(async (_input, init?: RequestInit) => {
      authorizationHeaders.push(
        new Headers(init?.headers).get("authorization") ?? "",
      );
      return authorizationHeaders.length === 1
        ? new Response("nope", { status: 401 })
        : new Response("{}", { status: 200 });
    });

    const codexFetch = createOpenAiCodexFetch({
      credential: {
        ...CREDENTIAL,
        accessToken: "at_from_sign_in",
        accessTokenExpiresAtMs: Date.now() + 60 * 60 * 1000,
      },
      providerApiKeyId: "key-early-revocation",
      sessionId: "sess_1",
      innerFetch,
    });
    const response = await codexFetch(
      "https://chatgpt.com/backend-api/codex/responses",
      { method: "POST", body: "{}" },
    );

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(authorizationHeaders).toEqual([
      "Bearer at_from_sign_in",
      "Bearer at_fresh",
    ]);
    expect(response.status).toBe(200);
  });
});

// =============================================================================
// Rotation lifecycle (issue #7206): ID-less validation stash, in-flight lineage
// isolation, and compare-and-swap persistence. These use the fixture-aware test
// from @/test where a real database row is involved.
// =============================================================================

import { LlmProviderApiKeyModel } from "@/models";
import SecretModel from "@/models/secret";
import {
  getSecretValueForLlmProviderApiKey,
  secretManager,
} from "@/secrets-manager";
import { test } from "@/test";
import {
  decodeOpenAiCodexCredential,
  encodeOpenAiCodexCredential,
} from "./openai-codex-credentials";

/** fetch stub for the OAuth token endpoint that rotates per a token map. */
function stubTokenEndpoint(
  rotations: Record<string, { accessToken: string; rotatedTo?: string }>,
) {
  const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body)) as {
      refresh_token?: string;
    };
    const presented = payload.refresh_token ?? "";
    const entry = rotations[presented];
    if (!entry) {
      return tokenResponse({ error: "invalid_grant" }, 400);
    }
    return tokenResponse({
      access_token: entry.accessToken,
      expires_in: 3600,
      ...(entry.rotatedTo ? { refresh_token: entry.rotatedTo } : {}),
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("ID-less validation rotation stash", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("follows an observed rotation instead of redeeming the dead predecessor", async () => {
    const rtA = `rt-a-${crypto.randomUUID()}`;
    const rtB = `rt-b-${crypto.randomUUID()}`;
    const fetchMock = stubTokenEndpoint({
      [rtA]: { accessToken: "at_1", rotatedTo: rtB },
      [rtB]: { accessToken: "at_2" },
    });

    await openAiCodexTokenManager.getAccessToken({ refreshToken: rtA });
    expect(openAiCodexTokenManager.latestKnownRefreshToken(rtA)).toBe(rtB);

    // Validating the same credential again must redeem the live successor —
    // redeeming rtA again would be invalid_grant (single-use tokens).
    const token = await openAiCodexTokenManager.getAccessToken({
      refreshToken: rtA,
    });
    expect(token).toBe("at_2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns the token unchanged when no rotation was observed", async () => {
    const rt = `rt-plain-${crypto.randomUUID()}`;
    stubTokenEndpoint({ [rt]: { accessToken: "at_1" } });
    await openAiCodexTokenManager.getAccessToken({ refreshToken: rt });
    expect(openAiCodexTokenManager.latestKnownRefreshToken(rt)).toBe(rt);
  });
});

describe("in-flight redemption lineage isolation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not serve an in-flight redemption to a caller holding a different credential", async () => {
    const rowId = crypto.randomUUID();
    const rtOld = `rt-old-${crypto.randomUUID()}`;
    const rtNew = `rt-new-${crypto.randomUUID()}`;
    const resolvers: Array<(response: Response) => void> = [];
    const presentedTokens: Array<string | null> = [];
    const fetchMock = vi.fn(
      (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          presentedTokens.push(
            (JSON.parse(String(init?.body)) as { refresh_token?: string })
              .refresh_token ?? null,
          );
          resolvers.push(resolve);
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    // Caller 1: the row's old credential (e.g. read before a reconnect).
    const first = openAiCodexTokenManager.getAccessToken({
      refreshToken: rtOld,
      providerApiKeyId: rowId,
    });
    // Caller 2 arrives mid-flight holding the NEW credential after a
    // reconnect. Joining caller 1's flight would hand it the old account's
    // bearer.
    const second = openAiCodexTokenManager.getAccessToken({
      refreshToken: rtNew,
      providerApiKeyId: rowId,
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    resolvers[0](tokenResponse({ access_token: "at_old", expires_in: 3600 }));
    resolvers[1](tokenResponse({ access_token: "at_new", expires_in: 3600 }));

    expect(await first).toBe("at_old");
    expect(await second).toBe("at_new");
    expect(presentedTokens).toEqual([rtOld, rtNew]);
  });

  it("shares one redemption between callers presenting the same credential", async () => {
    const rowId = crypto.randomUUID();
    const rt = `rt-shared-${crypto.randomUUID()}`;
    let release: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = openAiCodexTokenManager.getAccessToken({
      refreshToken: rt,
      providerApiKeyId: rowId,
    });
    const second = openAiCodexTokenManager.getAccessToken({
      refreshToken: rt,
      providerApiKeyId: rowId,
    });
    await vi.waitFor(() => expect(release).toBeDefined());
    release?.(tokenResponse({ access_token: "at_1", expires_in: 3600 }));

    expect(await first).toBe("at_1");
    expect(await second).toBe("at_1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("rotation persistence compare-and-swap", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("persists a rotated refresh token back to the stored secret", async ({
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    const rtStored = `rt-stored-${crypto.randomUUID()}`;
    const rtRotated = `rt-rotated-${crypto.randomUUID()}`;
    const stored = encodeOpenAiCodexCredential({
      refreshToken: rtStored,
      accountId: "acc-1",
    });
    const secret = await secretManager().createSecret(
      { apiKey: stored },
      `codex-test-${crypto.randomUUID()}`,
    );
    const key = await LlmProviderApiKeyModel.create({
      organizationId: organization.id,
      name: "ChatGPT Subscription",
      provider: "openai",
      secretId: secret.id,
      scope: "personal",
      userId: user.id,
    });
    stubTokenEndpoint({
      [rtStored]: { accessToken: "at_1", rotatedTo: rtRotated },
    });

    await openAiCodexTokenManager.getAccessToken({
      refreshToken: rtStored,
      providerApiKeyId: key.id,
      accountId: "acc-1",
    });
    await openAiCodexTokenManager.waitForPersistFlush(key.id);

    const value = await getSecretValueForLlmProviderApiKey(secret.id);
    expect(decodeOpenAiCodexCredential(value)).toMatchObject({
      refreshToken: rtRotated,
      accountId: "acc-1",
    });
  });

  test("skips the write when the stored credential is a different token family — even for the same account", async ({
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    // The row already holds a FRESH credential (a completed reconnect)…
    const rtFresh = `rt-fresh-${crypto.randomUUID()}`;
    const freshStored = encodeOpenAiCodexCredential({
      refreshToken: rtFresh,
      accountId: "acc-1",
    });
    const secret = await secretManager().createSecret(
      { apiKey: freshStored },
      `codex-test-${crypto.randomUUID()}`,
    );
    const key = await LlmProviderApiKeyModel.create({
      organizationId: organization.id,
      name: "ChatGPT Subscription",
      provider: "openai",
      secretId: secret.id,
      scope: "personal",
      userId: user.id,
    });
    // …while a caller still holding the PREVIOUS credential redeems it and
    // observes a rotation. Persisting that rotation would clobber the fresh
    // sign-in with a dead family (the old accountId guard allowed this,
    // because the account is the same).
    const rtOld = `rt-old-${crypto.randomUUID()}`;
    const rtOldRotated = `rt-old2-${crypto.randomUUID()}`;
    stubTokenEndpoint({
      [rtOld]: { accessToken: "at_old", rotatedTo: rtOldRotated },
    });

    await openAiCodexTokenManager.getAccessToken({
      refreshToken: rtOld,
      providerApiKeyId: key.id,
      accountId: "acc-1",
    });
    await openAiCodexTokenManager.waitForPersistFlush(key.id);

    const value = await getSecretValueForLlmProviderApiKey(secret.id);
    expect(decodeOpenAiCodexCredential(value)).toMatchObject({
      refreshToken: rtFresh,
    });
  });

  test("skips the write when the secret row is a read-only BYOS Vault reference", async ({
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    // A BYOS row stores the vault REFERENCE; the resolved value (what the
    // old guard inspected) would look like an ordinary credential.
    const secret = await SecretModel.create({
      name: `codex-byos-${crypto.randomUUID()}`,
      secret: { apiKey: "vault/data/llm#openai" },
      isByosVault: true,
    });
    const key = await LlmProviderApiKeyModel.create({
      organizationId: organization.id,
      name: "ChatGPT Subscription",
      provider: "openai",
      secretId: secret.id,
      scope: "personal",
      userId: user.id,
    });
    const rtOld = `rt-byos-${crypto.randomUUID()}`;
    stubTokenEndpoint({
      [rtOld]: {
        accessToken: "at_1",
        rotatedTo: `rt-byos2-${crypto.randomUUID()}`,
      },
    });

    await openAiCodexTokenManager.getAccessToken({
      refreshToken: rtOld,
      providerApiKeyId: key.id,
      accountId: "acc-1",
    });
    await openAiCodexTokenManager.waitForPersistFlush(key.id);

    const row = await SecretModel.findById(secret.id);
    expect(row?.secret).toMatchObject({ apiKey: "vault/data/llm#openai" });
  });
});
