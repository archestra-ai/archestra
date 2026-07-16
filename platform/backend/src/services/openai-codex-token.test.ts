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
});
