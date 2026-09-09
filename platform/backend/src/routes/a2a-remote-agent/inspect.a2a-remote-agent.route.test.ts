import { afterEach, describe, expect, test, useRouteTestApp } from "@/test";
import a2aRemoteAgentRoutes from "./a2a-remote-agent.routes";
import {
  makeAgentCard,
  startA2aDiscoveryFixture,
} from "./a2a-remote-agent.test-helpers";

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

  test("resolves a localhost Agent Card through the pinned DNS dispatcher", async () => {
    const fixture = await startA2aDiscoveryFixture("none", "localhost");
    closeFixture = fixture.close;

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/a2a/remote-agents/inspect",
      payload: {
        source: { type: "well_known", url: fixture.baseUrl },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      name: "Deterministic A2A Test Agent",
      selectedInterface: {
        url: `${fixture.baseUrl}/a2a`,
      },
    });
  });

  test("validates saved authentication metadata without requiring the secret value", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/a2a/remote-agents/inspect",
      payload: {
        source: {
          type: "inline_card",
          agentCard: makeAgentCard("bearer"),
        },
        auth: { type: "bearer" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      supportedAuthTypes: ["bearer"],
      selectedSecurityRequirement: { bearerAuth: [] },
    });
  });

  test("discovers an authenticated agent before authentication is selected", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/a2a/remote-agents/inspect",
      payload: {
        source: {
          type: "inline_card",
          agentCard: makeAgentCard("bearer"),
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      supportedAuthTypes: ["bearer"],
      selectedSecurityRequirement: null,
    });
  });

  test("validates a saved API-key header without requiring the secret value", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/a2a/remote-agents/inspect",
      payload: {
        source: {
          type: "inline_card",
          agentCard: makeAgentCard("api-key"),
        },
        auth: { type: "api_key", headerName: "X-API-Key" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      supportedAuthTypes: ["api_key"],
      selectedSecurityRequirement: { apiKeyAuth: [] },
    });
  });
});
