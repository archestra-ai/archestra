import { vi } from "vitest";
import {
  createGithubCopilotFetch,
  githubCopilotTokenManager,
} from "@/services/github-copilot-token";
import { afterEach, describe, expect, test } from "@/test";
import { ApiError } from "@/types";

/**
 * The token manager is a singleton with an internal cache, so every test uses
 * a unique GitHub token to stay isolated from other tests' cache entries.
 */
let tokenCounter = 0;
function uniqueGithubToken(): string {
  tokenCounter += 1;
  return `gho_test_${Date.now()}_${tokenCounter}`;
}

function exchangeResponse(params?: {
  token?: string;
  expiresInSeconds?: number;
}): Response {
  return Response.json({
    token: params?.token ?? "copilot-bearer",
    expires_at:
      Math.floor(Date.now() / 1000) + (params?.expiresInSeconds ?? 1800),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("githubCopilotTokenManager.getBearerToken", () => {
  test("exchanges the GitHub token with the token scheme and editor headers", async () => {
    const githubToken = uniqueGithubToken();
    const fetchMock = vi.fn().mockResolvedValue(exchangeResponse());
    vi.stubGlobal("fetch", fetchMock);

    const bearer = await githubCopilotTokenManager.getBearerToken(githubToken);

    expect(bearer).toBe("copilot-bearer");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.authorization).toBe(`token ${githubToken}`);
    expect(init.headers["copilot-integration-id"]).toBe("vscode-chat");
  });

  test("caches the bearer until expiry and reuses it", async () => {
    const githubToken = uniqueGithubToken();
    const fetchMock = vi.fn().mockResolvedValue(exchangeResponse());
    vi.stubGlobal("fetch", fetchMock);

    await githubCopilotTokenManager.getBearerToken(githubToken);
    await githubCopilotTokenManager.getBearerToken(githubToken);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("re-exchanges when the cached bearer is inside the refresh buffer", async () => {
    const githubToken = uniqueGithubToken();
    const fetchMock = vi
      .fn()
      // expires in 30s — within the 60s refresh buffer on the next call
      .mockResolvedValueOnce(
        exchangeResponse({ token: "stale", expiresInSeconds: 30 }),
      )
      .mockResolvedValueOnce(exchangeResponse({ token: "fresh" }));
    vi.stubGlobal("fetch", fetchMock);

    await githubCopilotTokenManager.getBearerToken(githubToken);
    const bearer = await githubCopilotTokenManager.getBearerToken(githubToken);

    expect(bearer).toBe("fresh");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("single-flights concurrent exchanges for the same token", async () => {
    const githubToken = uniqueGithubToken();
    let resolveExchange: (response: Response) => void = () => {};
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveExchange = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const [first, second] = [
      githubCopilotTokenManager.getBearerToken(githubToken),
      githubCopilotTokenManager.getBearerToken(githubToken),
    ];
    resolveExchange(exchangeResponse());

    expect(await first).toBe("copilot-bearer");
    expect(await second).toBe("copilot-bearer");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a failed exchange does not poison subsequent attempts", async () => {
    const githubToken = uniqueGithubToken();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(exchangeResponse());
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      githubCopilotTokenManager.getBearerToken(githubToken),
    ).rejects.toThrow(ApiError);

    const bearer = await githubCopilotTokenManager.getBearerToken(githubToken);
    expect(bearer).toBe("copilot-bearer");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("maps 401/403 to a 401 ApiError mentioning the Copilot subscription", async () => {
    const githubToken = uniqueGithubToken();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("forbidden", { status: 403 })),
    );

    await expect(
      githubCopilotTokenManager.getBearerToken(githubToken),
    ).rejects.toMatchObject({
      statusCode: 401,
      message: expect.stringContaining("Copilot subscription"),
    });
  });

  test("rejects an unexpected exchange payload with a 502", async () => {
    const githubToken = uniqueGithubToken();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ unexpected: true })),
    );

    await expect(
      githubCopilotTokenManager.getBearerToken(githubToken),
    ).rejects.toMatchObject({ statusCode: 502 });
  });

  test("invalidate() with a stale bearer keeps an already-refreshed entry", async () => {
    const githubToken = uniqueGithubToken();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(exchangeResponse({ token: "fresh" }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await githubCopilotTokenManager.getBearerToken(githubToken)).toBe(
      "fresh",
    );
    // A concurrent 401 handler that used an older bearer must not evict it.
    githubCopilotTokenManager.invalidate(githubToken, "stale");
    expect(await githubCopilotTokenManager.getBearerToken(githubToken)).toBe(
      "fresh",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("invalidate() drops the cached bearer", async () => {
    const githubToken = uniqueGithubToken();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(exchangeResponse({ token: "first" }))
      .mockResolvedValueOnce(exchangeResponse({ token: "second" }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await githubCopilotTokenManager.getBearerToken(githubToken)).toBe(
      "first",
    );
    githubCopilotTokenManager.invalidate(githubToken);
    expect(await githubCopilotTokenManager.getBearerToken(githubToken)).toBe(
      "second",
    );
  });
});

describe("createGithubCopilotFetch", () => {
  test("injects the exchanged bearer and Copilot headers into requests", async () => {
    const githubToken = uniqueGithubToken();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(exchangeResponse()));
    const innerFetch = vi.fn().mockResolvedValue(new Response("ok"));

    const copilotFetch = createGithubCopilotFetch({ githubToken, innerFetch });
    await copilotFetch("https://api.githubcopilot.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4o" }),
      headers: { "content-type": "application/json" },
    });

    expect(innerFetch).toHaveBeenCalledTimes(1);
    const [, init] = innerFetch.mock.calls[0];
    const headers = init.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer copilot-bearer");
    expect(headers.get("copilot-integration-id")).toBe("vscode-chat");
    expect(headers.get("editor-version")).toMatch(/^vscode\//);
    expect(headers.get("content-type")).toBe("application/json");
  });

  test("on 401 with a cached bearer: invalidates, re-exchanges, and retries exactly once", async () => {
    const githubToken = uniqueGithubToken();
    const exchangeMock = vi
      .fn()
      .mockResolvedValueOnce(exchangeResponse({ token: "stale" }))
      .mockResolvedValueOnce(exchangeResponse({ token: "fresh" }));
    vi.stubGlobal("fetch", exchangeMock);

    const innerFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const copilotFetch = createGithubCopilotFetch({ githubToken, innerFetch });
    const response = await copilotFetch(
      "https://api.githubcopilot.com/chat/completions",
      { method: "POST", body: JSON.stringify({ model: "gpt-4o" }) },
    );

    expect(response.status).toBe(200);
    expect(exchangeMock).toHaveBeenCalledTimes(2);
    expect(innerFetch).toHaveBeenCalledTimes(2);
    const retryHeaders = innerFetch.mock.calls[1][1].headers as Headers;
    expect(retryHeaders.get("authorization")).toBe("Bearer fresh");
  });

  test("does not retry a 401 when the body is not replayable", async () => {
    const githubToken = uniqueGithubToken();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(exchangeResponse()));
    const innerFetch = vi
      .fn()
      .mockResolvedValue(new Response("unauthorized", { status: 401 }));

    const copilotFetch = createGithubCopilotFetch({ githubToken, innerFetch });
    const response = await copilotFetch(
      "https://api.githubcopilot.com/chat/completions",
      { method: "POST", body: new ReadableStream() },
    );

    expect(response.status).toBe(401);
    expect(innerFetch).toHaveBeenCalledTimes(1);
  });

  test("returns the exchange failure as an OpenAI-shaped error Response instead of throwing", async () => {
    // A rejecting fetch makes the OpenAI SDK retry the exchange and surface a
    // generic connection error; a status Response preserves the real cause.
    const githubToken = uniqueGithubToken();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("forbidden", { status: 403 })),
    );
    const innerFetch = vi.fn();

    const copilotFetch = createGithubCopilotFetch({ githubToken, innerFetch });
    const response = await copilotFetch(
      "https://api.githubcopilot.com/chat/completions",
      { method: "POST", body: "{}" },
    );

    expect(innerFetch).not.toHaveBeenCalled();
    expect(response.status).toBe(401);
    const body = (await response.json()) as {
      error: { message: string; type: string };
    };
    expect(body.error.type).toBe("authentication_error");
    expect(body.error.message).toContain("Copilot subscription");
  });

  test("passes requests through untouched when no GitHub token is present", async () => {
    const innerFetch = vi.fn().mockResolvedValue(new Response("nope"));
    const exchangeMock = vi.fn();
    vi.stubGlobal("fetch", exchangeMock);

    const copilotFetch = createGithubCopilotFetch({
      githubToken: undefined,
      innerFetch,
    });
    await copilotFetch("https://api.githubcopilot.com/models");

    expect(exchangeMock).not.toHaveBeenCalled();
    expect(innerFetch).toHaveBeenCalledTimes(1);
    const init = innerFetch.mock.calls[0][1];
    expect(init).toBeUndefined();
  });
});
