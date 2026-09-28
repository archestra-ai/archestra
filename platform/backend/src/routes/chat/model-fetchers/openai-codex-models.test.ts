import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeOpenAiCodexCredential } from "@/services/openai-codex-credentials";
import { fetchOpenAiModels } from "./openai";

const credential = encodeOpenAiCodexCredential({
  refreshToken: "rt_secret",
  accountId: "acc_123",
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchOpenAiModels with a ChatGPT-subscription credential", () => {
  it("syncs the account's picker-visible Codex models in priority order", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        if (String(input).endsWith("/oauth/token")) {
          return Response.json({ access_token: "at_1", expires_in: 3600 });
        }
        if (String(input).includes("/models?")) {
          return Response.json({
            models: [
              {
                slug: "gpt-6-sol",
                display_name: "GPT-6 Sol",
                visibility: "list",
                priority: 2,
              },
              {
                slug: "internal-preview",
                display_name: "Internal Preview",
                visibility: "hide",
                priority: 0,
              },
              {
                slug: "gpt-6-astra",
                display_name: "GPT-6 Astra",
                visibility: "list",
                priority: 1,
              },
              {
                slug: "legacy-model",
                visibility: "none",
                priority: 3,
              },
            ],
          });
        }
        throw new Error(`Unexpected request: ${String(input)}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchOpenAiModels(credential)).resolves.toEqual([
      { id: "gpt-6-astra", displayName: "GPT-6 Astra", provider: "openai" },
      { id: "gpt-6-sol", displayName: "GPT-6 Sol", provider: "openai" },
    ]);

    const [modelsUrl, modelsInit] = fetchMock.mock.calls.find(([input]) =>
      String(input).includes("/models?"),
    ) ?? [null, null];
    expect(modelsUrl).toBeTruthy();
    expect(new URL(String(modelsUrl)).pathname).toBe(
      "/backend-api/codex/models",
    );
    expect(new URL(String(modelsUrl)).searchParams.get("client_version")).toBe(
      "0.158.0",
    );
    expect(new Headers(modelsInit?.headers).get("authorization")).toBe(
      "Bearer at_1",
    );
    expect(new Headers(modelsInit?.headers).get("chatgpt-account-id")).toBe(
      "acc_123",
    );
    expect(modelsInit?.redirect).toBe("error");
  });

  it("propagates a rejected credential so key creation fails clearly", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      Response.json({ error: "invalid_grant" }, { status: 400 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchOpenAiModels(credential)).rejects.toMatchObject({
      statusCode: 401,
      message: expect.stringContaining("Reconnect your ChatGPT account"),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toContain("/oauth/token");
  });

  it("fails a provider error instead of replacing the catalog with a stale list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith("/oauth/token")
          ? Response.json({ access_token: "at_1", expires_in: 3600 })
          : new Response("unavailable", { status: 503 }),
      ),
    );

    await expect(fetchOpenAiModels(credential)).rejects.toMatchObject({
      statusCode: 502,
    });
  });

  it("rejects an invalid catalog", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith("/oauth/token")
          ? Response.json({ access_token: "at_1", expires_in: 3600 })
          : Response.json({ data: [] }),
      ),
    );

    await expect(fetchOpenAiModels(credential)).rejects.toThrow();
  });
});
