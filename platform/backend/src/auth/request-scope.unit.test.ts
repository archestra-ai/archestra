import { describe, expect, test } from "vitest";
import { requestScope, shouldShareCallerLookups } from "./request-scope";

const run = <T>(memoize: boolean | null, body: () => Promise<T>) =>
  new Promise<T>((resolve, reject) => {
    // Each request runs in its own async context, as Fastify's handlers do.
    setImmediate(() => {
      if (memoize !== null) requestScope.enter({ memoize });
      body().then(resolve, reject);
    });
  });

describe("requestScope", () => {
  test("a read request loads each key once; another request loads again", async () => {
    let loads = 0;
    const load = async () => ++loads;
    const first = await run(true, async () => [
      await requestScope.memo("k", load),
      await requestScope.memo("k", load),
    ]);
    const second = await run(true, () => requestScope.memo("k", load));
    expect(first).toEqual([1, 1]);
    expect(second).toBe(2);
  });

  test("writes and code outside any request never share an answer", async () => {
    let loads = 0;
    const load = async () => ++loads;
    const write = await run(false, async () => [
      await requestScope.memo("k", load),
      await requestScope.memo("k", load),
    ]);
    const outside = await run(null, async () => [
      await requestScope.memo("k", load),
      await requestScope.memo("k", load),
    ]);
    expect(write).toEqual([1, 2]);
    expect(outside).toEqual([3, 4]);
  });

  test("a failed load is not remembered", async () => {
    let attempts = 0;
    const result = await run(true, async () => {
      await requestScope
        .memo("k", async () => {
          attempts++;
          throw new Error("transient");
        })
        .catch(() => undefined);
      return requestScope.memo("k", async () => ++attempts);
    });
    expect(result).toBe(2);
  });

  test("only REST reads share lookups; auth callbacks, streams and writes never do", () => {
    const share = (method: string, url: string) =>
      shouldShareCallerLookups({ method, url });
    expect(share("GET", "/api/skills?limit=100")).toBe(true);
    expect(share("HEAD", "/api/agents")).toBe(true);
    // SSO callbacks sync the caller's role and teams during a GET.
    expect(share("GET", "/api/auth/sso/callback/okta?code=x")).toBe(false);
    // Long-lived GETs.
    expect(share("GET", "/v1/mcp/agent-id")).toBe(false);
    expect(share("GET", "/ws")).toBe(false);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(share(method, "/api/teams")).toBe(false);
    }
  });

  test("LLM proxy calls share lookups; other /v1 routes never do", () => {
    const share = (method: string, url: string) =>
      shouldShareCallerLookups({ method, url });
    expect(share("POST", "/v1/anthropic/agent-id/v1/messages")).toBe(true);
    expect(share("POST", "/v1/openai/chat/completions")).toBe(true);
    expect(share("POST", "/v1/model-router/agent-id/responses")).toBe(true);
    expect(share("GET", "/v1/gemini/v1beta/models")).toBe(true);
    expect(share("POST", "/v1/mcp/agent-id")).toBe(false);
    expect(share("POST", "/v1/a2a/agent-id")).toBe(false);
    expect(share("GET", "/v1/health?mcp=agent-id")).toBe(false);
    expect(share("GET", "/v1/connection-instructions")).toBe(false);
  });
});
