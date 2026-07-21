import { vi } from "vitest";
import { AgentModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";

vi.mock("@/auth");

/**
 * Public existence check used by the Claude Code startup guard. The whole
 * point of the endpoint is the case reachability probes cannot see: a remote
 * that was deleted on the platform while the client still has it configured
 * — the data-plane answers 401/404 uniformly, so only this endpoint can say
 * "missing" (which the guard turns into a disconnect prompt).
 */
describe("GET /api/connection-health", () => {
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

  function health(kind: string, ref: string) {
    return app.inject({
      method: "GET",
      url: `/api/connection-health?kind=${kind}&ref=${encodeURIComponent(ref)}`,
    });
  }

  test("reports ok for an existing gateway, by id and by slug, without auth", async ({
    makeAgent,
  }) => {
    const gateway = await makeAgent({ agentType: "mcp_gateway" });
    for (const ref of [gateway.id, gateway.slug].filter(
      (r): r is string => !!r,
    )) {
      const res = await health("mcp-gateway", ref);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "ok" });
    }
  });

  test("reports missing for a deleted gateway — the startup-guard scenario", async ({
    makeAgent,
  }) => {
    const gateway = await makeAgent({ agentType: "mcp_gateway" });
    expect((await health("mcp-gateway", gateway.id)).json()).toEqual({
      status: "ok",
    });

    await AgentModel.delete(gateway.id);

    // Freshness is the contract: a just-deleted gateway must read as missing
    // immediately (no resolve-cache staleness).
    expect((await health("mcp-gateway", gateway.id)).json()).toEqual({
      status: "missing",
    });
  });

  test("reports ok/missing for an LLM proxy by id", async ({ makeAgent }) => {
    const proxy = await makeAgent({ agentType: "llm_proxy" });
    expect((await health("llm-proxy", proxy.id)).json()).toEqual({
      status: "ok",
    });

    await AgentModel.delete(proxy.id);
    expect((await health("llm-proxy", proxy.id)).json()).toEqual({
      status: "missing",
    });
  });

  test("is kind-scoped: a proxy ref never passes as a gateway", async ({
    makeAgent,
  }) => {
    const proxy = await makeAgent({ agentType: "llm_proxy" });
    expect((await health("mcp-gateway", proxy.id)).json()).toEqual({
      status: "missing",
    });
  });

  test("reports missing for a ref that never existed", async () => {
    expect(
      (
        await health("mcp-gateway", "00000000-0000-0000-0000-000000000000")
      ).json(),
    ).toEqual({ status: "missing" });
    expect((await health("llm-proxy", "not-a-real-slug")).json()).toEqual({
      status: "missing",
    });
  });

  test("rejects an unknown kind", async () => {
    const res = await health("something-else", "ref");
    expect(res.statusCode).toBe(400);
  });
});
