import { VIRTUAL_KEY_HEADER } from "@archestra/shared";
import { vi } from "vitest";
import { AgentModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";

vi.mock("@/auth");

// cacheManager needs a live PostgreSQL connection that PGlite tests don't
// have; back it with the canonical Map-backed fake from
// src/__mocks__/cache-manager.ts so the rate limiter runs for real against an
// in-memory store (reset before every test).
vi.mock("@/cache-manager");

/**
 * Public single-request health check used by the Claude Code startup guard.
 * The whole point is the case reachability probes cannot see: a remote that
 * was deleted on the platform while the client still has it configured — the
 * data plane answers 401/404 uniformly, so only this endpoint can say "down"
 * (which the guard turns into a disconnect prompt).
 */
describe("GET /v1/health", () => {
  let app: FastifyInstanceWithZod;

  beforeEach(async () => {
    app = createFastifyInstance();
    const { default: connectionSetupRoutes } = await import(
      "./connection-setup.routes"
    );
    await app.register(connectionSetupRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  let requesterCounter = 0;
  /** Unique requester per call batch so buckets never bleed between tests. */
  function nextRequester(): Record<string, string> {
    requesterCounter += 1;
    return { "x-forwarded-for": `10.9.0.${(requesterCounter % 250) + 1}` };
  }

  function health(query: string, headers: Record<string, string> = {}) {
    return app.inject({
      method: "GET",
      url: `/v1/health${query}`,
      headers: { ...nextRequester(), ...headers },
    });
  }

  test("answers for both remotes in one request, without auth", async ({
    makeAgent,
  }) => {
    const gateway = await makeAgent({ agentType: "mcp_gateway" });
    const proxy = await makeAgent({ agentType: "llm_proxy" });
    const res = await health(
      `?mcp=${gateway.slug ?? gateway.id}&llm=${proxy.id}`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ mcp: "ok", llm: "ok" });
  });

  test("reports down for a deleted gateway — the startup-guard scenario", async ({
    makeAgent,
  }) => {
    const gateway = await makeAgent({ agentType: "mcp_gateway" });
    const proxy = await makeAgent({ agentType: "llm_proxy" });
    const query = `?mcp=${gateway.id}&llm=${proxy.id}`;
    expect((await health(query)).json()).toEqual({ mcp: "ok", llm: "ok" });

    await AgentModel.delete(gateway.id);

    // Freshness is the contract: a just-deleted gateway must read as down
    // immediately (no resolve-cache staleness).
    expect((await health(query)).json()).toEqual({ mcp: "down", llm: "ok" });
  });

  test("each param answers independently and is optional", async ({
    makeAgent,
  }) => {
    const proxy = await makeAgent({ agentType: "llm_proxy" });
    expect((await health(`?llm=${proxy.id}`)).json()).toEqual({ llm: "ok" });
    expect(
      (await health("?mcp=00000000-0000-0000-0000-000000000000")).json(),
    ).toEqual({ mcp: "down" });
    // no params = a bare reachability ping
    expect((await health("")).json()).toEqual({});
  });

  test("is kind-scoped: a proxy ref never passes as a gateway", async ({
    makeAgent,
  }) => {
    const proxy = await makeAgent({ agentType: "llm_proxy" });
    expect((await health(`?mcp=${proxy.id}`)).json()).toEqual({ mcp: "down" });
  });

  test("heavily rate limits per requester, identified by forwarded-for", async ({
    makeAgent,
  }) => {
    const gateway = await makeAgent({ agentType: "mcp_gateway" });
    const headers = { "x-forwarded-for": "203.0.113.7" };
    let firstLimited: number | null = null;
    for (let i = 1; i <= 31; i++) {
      const res = await app.inject({
        method: "GET",
        url: `/v1/health?mcp=${gateway.id}`,
        headers,
      });
      if (res.statusCode === 429) {
        firstLimited = i;
        break;
      }
      expect(res.statusCode).toBe(200);
    }
    expect(firstLimited).toBe(31);

    // a different requester is unaffected by the exhausted bucket
    const other = await health(`?mcp=${gateway.id}`);
    expect(other.statusCode).toBe(200);
  });

  test("a caller sending the connection's virtual-key header gets its own bucket", async ({
    makeAgent,
  }) => {
    const gateway = await makeAgent({ agentType: "mcp_gateway" });
    // same forwarded-for as another exhausted identity would use, but the
    // key header takes precedence for identification
    const headers = {
      "x-forwarded-for": "203.0.113.9",
      [VIRTUAL_KEY_HEADER.toLowerCase()]: "arch_somekeyvalue",
    };
    for (let i = 0; i < 30; i++) {
      const res = await app.inject({
        method: "GET",
        url: `/v1/health?mcp=${gateway.id}`,
        headers,
      });
      expect(res.statusCode).toBe(200);
    }
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/v1/health?mcp=${gateway.id}`,
          headers,
        })
      ).statusCode,
    ).toBe(429);
    // the bare forwarded-for identity still has its own untouched bucket
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/v1/health?mcp=${gateway.id}`,
          headers: { "x-forwarded-for": "203.0.113.9" },
        })
      ).statusCode,
    ).toBe(200);
  });
});
