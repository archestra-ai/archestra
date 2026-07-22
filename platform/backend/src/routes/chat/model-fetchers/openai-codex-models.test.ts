import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  encodeOpenAiCodexCredential,
  OPENAI_CODEX_MODELS,
} from "@/services/openai-codex-credentials";
import { fetchOpenAiModels } from "./openai";

describe("fetchOpenAiModels with a ChatGPT-subscription credential", () => {
  beforeEach(() => {
    // Global fetch backs the OAuth token redemption used to validate the
    // credential; the Codex backend has no /models endpoint.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ access_token: "at_1", expires_in: 3600 }),
      ),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the maintained Codex model list, not api.openai.com models", async () => {
    const credential = encodeOpenAiCodexCredential({
      refreshToken: "rt_secret",
      accountId: "acc_123",
    });

    const models = await fetchOpenAiModels(credential);

    expect(models.map((model) => model.id)).toEqual(
      OPENAI_CODEX_MODELS.map((model) => model.id),
    );
    expect(models.every((model) => model.provider === "openai")).toBe(true);
    // The only network call is the OAuth redemption — never a models listing.
    expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain("/oauth/token");
  });

  it("propagates a rejected credential so key creation fails clearly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "invalid_grant" }, { status: 400 }),
      ),
    );
    const credential = encodeOpenAiCodexCredential({
      refreshToken: "rt_bad",
      accountId: "acc_123",
    });

    await expect(fetchOpenAiModels(credential)).rejects.toMatchObject({
      statusCode: 401,
    });
  });
});
