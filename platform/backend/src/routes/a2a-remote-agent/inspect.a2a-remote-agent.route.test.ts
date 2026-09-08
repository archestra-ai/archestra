import { afterEach, describe, expect, test, useRouteTestApp } from "@/test";
import a2aRemoteAgentRoutes from "./a2a-remote-agent.routes";
import { startA2aDiscoveryFixture } from "./a2a-remote-agent.test-helpers";

describe("POST /api/a2a/remote-agents/inspect", () => {
  const ctx = useRouteTestApp(a2aRemoteAgentRoutes);
  let closeFixture: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await closeFixture?.();
    closeFixture = undefined;
  });

  test("resolves the well-known Agent Card over HTTP without persisting it", async () => {
    const fixture = await startA2aDiscoveryFixture();
    closeFixture = fixture.close;

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/a2a/remote-agents/inspect",
      payload: {
        source: { type: "well_known", url: fixture.baseUrl },
        auth: { type: "none" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      name: "Deterministic A2A Test Agent",
      selectedInterface: {
        url: `${fixture.baseUrl}/a2a`,
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
      },
      supportedAuthTypes: ["none"],
      selectedSecurityRequirement: null,
    });

    const list = await ctx.app.inject({
      method: "GET",
      url: "/api/a2a/remote-agents",
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([]);
  });
});
