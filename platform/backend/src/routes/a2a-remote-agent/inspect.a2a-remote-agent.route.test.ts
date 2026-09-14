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

  test("resolves the well-known Agent Card relative to a path-prefixed base URL", async () => {
    const fixture = await startA2aDiscoveryFixture(
      "none",
      "127.0.0.1",
      "/apikey",
    );
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
        auth: { type: "bearer", credential: "new-bearer-token" },
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
        auth: {
          type: "api_key",
          headerName: "X-API-Key",
          credential: "new-api-key",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      supportedAuthTypes: ["api_key"],
      selectedSecurityRequirement: { apiKeyAuth: [] },
    });
  });

  test("sends bearer authentication while resolving a protected Agent Card", async () => {
    const fixture = await startA2aDiscoveryFixture("bearer");
    closeFixture = fixture.close;

    const unauthenticated = await ctx.app.inject({
      method: "POST",
      url: "/api/a2a/remote-agents/inspect",
      payload: {
        source: { type: "well_known", url: fixture.baseUrl },
        auth: { type: "none" },
      },
    });
    expect(unauthenticated.statusCode).toBe(400);

    const wrongCredential = await ctx.app.inject({
      method: "POST",
      url: "/api/a2a/remote-agents/inspect",
      payload: {
        source: { type: "well_known", url: fixture.baseUrl },
        auth: { type: "bearer", credential: "wrong-token" },
      },
    });
    expect(wrongCredential.statusCode).toBe(400);

    const authenticated = await ctx.app.inject({
      method: "POST",
      url: "/api/a2a/remote-agents/inspect",
      payload: {
        source: { type: "well_known", url: fixture.baseUrl },
        auth: { type: "bearer", credential: "fixture-bearer-token" },
      },
    });
    expect(authenticated.statusCode).toBe(200);
    expect(authenticated.json()).toMatchObject({
      supportedAuthTypes: ["bearer"],
      selectedSecurityRequirement: { bearerAuth: [] },
    });
  });

  test("sends the named API-key header while resolving a protected Agent Card", async () => {
    const fixture = await startA2aDiscoveryFixture("api-key");
    closeFixture = fixture.close;

    const unauthenticated = await ctx.app.inject({
      method: "POST",
      url: "/api/a2a/remote-agents/inspect",
      payload: {
        source: { type: "well_known", url: fixture.baseUrl },
        auth: { type: "none" },
      },
    });
    expect(unauthenticated.statusCode).toBe(400);

    const wrongCredential = await ctx.app.inject({
      method: "POST",
      url: "/api/a2a/remote-agents/inspect",
      payload: {
        source: { type: "well_known", url: fixture.baseUrl },
        auth: {
          type: "api_key",
          headerName: "X-API-Key",
          credential: "wrong-api-key",
        },
      },
    });
    expect(wrongCredential.statusCode).toBe(400);

    const authenticated = await ctx.app.inject({
      method: "POST",
      url: "/api/a2a/remote-agents/inspect",
      payload: {
        source: { type: "well_known", url: fixture.baseUrl },
        auth: {
          type: "api_key",
          headerName: "X-API-Key",
          credential: "fixture-api-key",
        },
      },
    });
    expect(authenticated.statusCode).toBe(200);
    expect(authenticated.json()).toMatchObject({
      supportedAuthTypes: ["api_key"],
      selectedSecurityRequirement: { apiKeyAuth: [] },
    });
  });

  test("reuses a stored credential without returning it to the client", async () => {
    const fixture = await startA2aDiscoveryFixture("bearer");
    closeFixture = fixture.close;
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/a2a/remote-agents",
      payload: {
        source: { type: "well_known", url: fixture.baseUrl },
        auth: { type: "bearer", credential: "fixture-bearer-token" },
      },
    });
    expect(created.statusCode).toBe(200);

    const inspected = await ctx.app.inject({
      method: "POST",
      url: "/api/a2a/remote-agents/inspect",
      payload: {
        remoteAgentId: created.json().id,
        source: { type: "well_known", url: `${fixture.baseUrl}/` },
        auth: { type: "bearer" },
      },
    });

    expect(inspected.statusCode).toBe(200);
    expect(inspected.json()).toMatchObject({
      supportedAuthTypes: ["bearer"],
      selectedSecurityRequirement: { bearerAuth: [] },
    });
    expect(JSON.stringify(inspected.json())).not.toContain(
      "fixture-bearer-token",
    );
    expect(await fixture.requests()).toHaveLength(2);
  });

  test("does not send a stored credential to a changed discovery source", async () => {
    const originalFixture = await startA2aDiscoveryFixture("bearer");
    const changedFixture = await startA2aDiscoveryFixture("bearer");
    closeFixture = async () => {
      await Promise.all([originalFixture.close(), changedFixture.close()]);
    };
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/a2a/remote-agents",
      payload: {
        source: { type: "well_known", url: originalFixture.baseUrl },
        auth: { type: "bearer", credential: "fixture-bearer-token" },
      },
    });
    expect(created.statusCode).toBe(200);

    const inspected = await ctx.app.inject({
      method: "POST",
      url: "/api/a2a/remote-agents/inspect",
      payload: {
        remoteAgentId: created.json().id,
        source: { type: "well_known", url: changedFixture.baseUrl },
        auth: { type: "bearer" },
      },
    });

    expect(inspected.statusCode).toBe(400);
    expect(inspected.json()).toMatchObject({
      error: {
        message:
          "Stored credential cannot be reused for a different Agent Card discovery source",
      },
    });
    expect(await changedFixture.requests()).toEqual([]);
  });

  test("does not reuse a stored credential across organizations", async ({
    makeOrganization,
  }) => {
    const fixture = await startA2aDiscoveryFixture("bearer");
    closeFixture = fixture.close;
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/a2a/remote-agents",
      payload: {
        source: { type: "inline_card", agentCard: makeAgentCard("bearer") },
        auth: { type: "bearer", credential: "fixture-bearer-token" },
      },
    });
    expect(created.statusCode).toBe(200);

    ctx.organizationId = (await makeOrganization()).id;
    const inspected = await ctx.app.inject({
      method: "POST",
      url: "/api/a2a/remote-agents/inspect",
      payload: {
        remoteAgentId: created.json().id,
        source: { type: "well_known", url: fixture.baseUrl },
        auth: { type: "bearer" },
      },
    });

    expect(inspected.statusCode).toBe(404);
    expect(inspected.json()).toMatchObject({
      error: { message: "Outbound A2A agent not found" },
    });
  });

  test("does not repurpose a stored credential under another authentication configuration", async () => {
    const bearerAgent = await ctx.app.inject({
      method: "POST",
      url: "/api/a2a/remote-agents",
      payload: {
        source: { type: "inline_card", agentCard: makeAgentCard("bearer") },
        auth: { type: "bearer", credential: "stored-bearer-token" },
      },
    });
    expect(bearerAgent.statusCode).toBe(200);

    const changedType = await ctx.app.inject({
      method: "POST",
      url: "/api/a2a/remote-agents/inspect",
      payload: {
        remoteAgentId: bearerAgent.json().id,
        source: {
          type: "inline_card",
          agentCard: makeAgentCard("bearer"),
        },
        auth: { type: "api_key", headerName: "X-API-Key" },
      },
    });
    expect(changedType.statusCode).toBe(400);
    expect(changedType.json()).toMatchObject({
      error: {
        message:
          "Stored credential does not match the requested authentication configuration",
      },
    });

    const apiKeyAgent = await ctx.app.inject({
      method: "POST",
      url: "/api/a2a/remote-agents",
      payload: {
        source: { type: "inline_card", agentCard: makeAgentCard("api-key") },
        auth: {
          type: "api_key",
          headerName: "X-API-Key",
          credential: "stored-api-key",
        },
      },
    });
    expect(apiKeyAgent.statusCode).toBe(200);

    const changedHeader = await ctx.app.inject({
      method: "POST",
      url: "/api/a2a/remote-agents/inspect",
      payload: {
        remoteAgentId: apiKeyAgent.json().id,
        source: {
          type: "inline_card",
          agentCard: makeAgentCard("api-key"),
        },
        auth: { type: "api_key", headerName: "X-Different-Key" },
      },
    });
    expect(changedHeader.statusCode).toBe(400);
    expect(changedHeader.json()).toMatchObject({
      error: {
        message:
          "Stored credential does not match the requested authentication configuration",
      },
    });
  });

  test("requires a saved remote-agent ID when a credential is omitted", async () => {
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

    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).toContain(
      "A saved outbound A2A agent is required when reusing a credential",
    );
  });

  test("does not expose malformed credential text in an inspection error", async () => {
    const fixture = await startA2aDiscoveryFixture("bearer");
    closeFixture = fixture.close;
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/a2a/remote-agents/inspect",
      payload: {
        source: { type: "well_known", url: fixture.baseUrl },
        auth: {
          type: "bearer",
          credential: "credential-before-control\nSENSITIVE_MARKER",
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).not.toContain("SENSITIVE_MARKER");
    expect(await fixture.requests()).toEqual([]);
  });
});
