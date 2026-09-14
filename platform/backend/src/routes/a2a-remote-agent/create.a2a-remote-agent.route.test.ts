import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import A2aRemoteAgentModel from "@/models/a2a-remote-agent";
import { secretManager } from "@/secrets-manager";
import { afterEach, describe, expect, test, useRouteTestApp } from "@/test";
import a2aRemoteAgentRoutes from "./a2a-remote-agent.routes";
import {
  makeAgentCard,
  startA2aDiscoveryFixture,
} from "./a2a-remote-agent.test-helpers";

describe("POST /api/a2a/remote-agents", () => {
  const ctx = useRouteTestApp(a2aRemoteAgentRoutes);
  let closeFixture: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await closeFixture?.();
    closeFixture = undefined;
  });

  test("persists a credential-backed connection without exposing credential material", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/a2a/remote-agents",
      payload: {
        name: "External researcher",
        source: { type: "inline_card", agentCard: makeAgentCard("api-key") },
        auth: {
          type: "api_key",
          headerName: "X-API-Key",
          credential: "a2a-super-secret",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      name: "External researcher",
      authorId: ctx.user.id,
      authorName: ctx.user.name,
      scope: "personal",
      teams: [],
      users: [],
      discoveryMode: "inline_card",
      discoveryUrl: null,
      connection: {
        authType: "api_key",
        authConfig: { headerName: "X-API-Key" },
        hasCredential: true,
        enabled: true,
      },
    });
    expect(JSON.stringify(body)).not.toContain("a2a-super-secret");
    expect(body.connection.secretId).toBeUndefined();

    const stored = await A2aRemoteAgentModel.findByIdForOrganization({
      id: body.id,
      organizationId: ctx.organizationId,
    });
    const secretId = stored?.connection.secretId;
    if (!secretId) throw new Error("expected a stored connection secret");
    const secret = await secretManager().getSecret(secretId);
    expect(secret?.secret).toEqual({ credential: "a2a-super-secret" });
    const auditSnapshot = await A2aRemoteAgentModel.findByIdForAudit(
      body.id,
      ctx.organizationId,
    );
    expect(auditSnapshot).toMatchObject({
      id: body.id,
      hasCredential: true,
    });
    expect(auditSnapshot).not.toHaveProperty("secretId");
    expect(JSON.stringify(auditSnapshot)).not.toContain("a2a-super-secret");
  });

  test("uses configured authentication while discovering the card to save", async () => {
    const fixture = await startA2aDiscoveryFixture("api-key");
    closeFixture = fixture.close;

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/a2a/remote-agents",
      payload: {
        source: { type: "well_known", url: fixture.baseUrl },
        auth: {
          type: "api_key",
          headerName: "X-API-Key",
          credential: "fixture-api-key",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      name: "Deterministic A2A Test Agent",
      discoveryMode: "well_known",
      discoveryUrl: fixture.baseUrl,
      connection: {
        authType: "api_key",
        authConfig: { headerName: "X-API-Key" },
        hasCredential: true,
      },
    });
    expect(JSON.stringify(response.json())).not.toContain("fixture-api-key");
  });

  test("round-trips team visibility and rejects invalid team audiences", async ({
    makeOrganization,
    makeTeam,
  }) => {
    const team = await makeTeam(ctx.organizationId, ctx.user.id, {
      name: "Research Team",
    });
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/a2a/remote-agents",
      payload: {
        source: { type: "inline_card", agentCard: makeAgentCard("none") },
        auth: { type: "none" },
        scope: "team",
        teams: [team.id],
      },
    });

    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      authorId: ctx.user.id,
      scope: "team",
      teams: [{ id: team.id, name: "Research Team" }],
      users: [],
    });

    const noTeam = await ctx.app.inject({
      method: "POST",
      url: "/api/a2a/remote-agents",
      payload: {
        source: { type: "inline_card", agentCard: makeAgentCard("none") },
        auth: { type: "none" },
        scope: "team",
        teams: [],
      },
    });
    expect(noTeam.statusCode).toBe(400);

    const foreignOrganization = await makeOrganization();
    const foreignTeam = await makeTeam(foreignOrganization.id, ctx.user.id);
    const foreign = await ctx.app.inject({
      method: "POST",
      url: "/api/a2a/remote-agents",
      payload: {
        source: { type: "inline_card", agentCard: makeAgentCard("none") },
        auth: { type: "none" },
        scope: "team",
        teams: [foreignTeam.id],
      },
    });
    expect(foreign.statusCode).toBe(400);
  });

  test("rejects an auth method the Agent Card does not advertise", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/a2a/remote-agents",
      payload: {
        source: { type: "inline_card", agentCard: makeAgentCard("none") },
        auth: { type: "bearer", credential: "unused-secret" },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        message:
          "The Agent Card does not advertise the selected bearer authentication method",
      },
    });

    const list = await ctx.app.inject({
      method: "GET",
      url: "/api/a2a/remote-agents",
    });
    expect(list.json()).toEqual([]);
  });

  test("rejects an API-key header that does not satisfy the card requirement", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/a2a/remote-agents",
      payload: {
        source: { type: "inline_card", agentCard: makeAgentCard("api-key") },
        auth: {
          type: "api_key",
          headerName: "X-Wrong-Key",
          credential: "unused-secret",
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        message:
          "The selected credential does not satisfy a complete Agent Card security requirement",
      },
    });
  });

  test("rejects reserved headers as API-key credential carriers", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/a2a/remote-agents",
      payload: {
        source: { type: "inline_card", agentCard: makeAgentCard("api-key") },
        auth: {
          type: "api_key",
          headerName: "Host",
          credential: "unused-secret",
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).toContain(
      "API-key header name is reserved",
    );
  });

  test("rejects cards that cannot exchange the supported media modes", async () => {
    for (const agentCard of [
      makeAgentCard("none", { defaultInputModes: ["image/png"] }),
      makeAgentCard("none", { defaultOutputModes: ["image/png"] }),
    ]) {
      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/a2a/remote-agents",
        payload: {
          source: { type: "inline_card", agentCard },
          auth: { type: "none" },
        },
      });
      expect(response.statusCode).toBe(400);
    }
  });

  test("rejects cards with required protocol extensions", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/a2a/remote-agents",
      payload: {
        source: {
          type: "inline_card",
          agentCard: makeAgentCard("none", {
            capabilities: {
              streaming: false,
              extensions: [{ uri: "urn:example:required", required: true }],
            },
          }),
        },
        auth: { type: "none" },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        message:
          "Agent Card requires an A2A extension that Archestra does not support",
      },
    });
  });

  test("keeps the complete generated delegation tool name within provider limits", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/a2a/remote-agents",
      payload: {
        name: "A very long external agent name that should never overflow a model provider tool-name limit",
        source: { type: "inline_card", agentCard: makeAgentCard("none") },
        auth: { type: "none" },
      },
    });

    expect(response.statusCode).toBe(200);
    const stored = await A2aRemoteAgentModel.findByIdForOrganization({
      id: response.json().id,
      organizationId: ctx.organizationId,
    });
    expect(stored?.toolId).toBe(response.json().toolId);
    const [tool] = await db
      .select({ name: schema.toolsTable.name })
      .from(schema.toolsTable)
      .where(eq(schema.toolsTable.id, response.json().toolId));
    expect(tool.name).toHaveLength(64);
    expect(tool.name).toMatch(/^agent__.+__[0-9a-f]{32}$/);
  });
});
