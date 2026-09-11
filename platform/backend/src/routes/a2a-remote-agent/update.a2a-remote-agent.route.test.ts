import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import A2aRemoteAgentModel from "@/models/a2a-remote-agent";
import AgentToolModel from "@/models/agent-tool";
import { secretManager } from "@/secrets-manager";
import { createA2aRemoteAgent } from "@/services/a2a-outbound-registry";
import { afterEach, describe, expect, test, useRouteTestApp } from "@/test";
import a2aRemoteAgentRoutes from "./a2a-remote-agent.routes";
import {
  makeAgentCard,
  startA2aDiscoveryFixture,
} from "./a2a-remote-agent.test-helpers";

describe("PUT /api/a2a/remote-agents/:id", () => {
  const ctx = useRouteTestApp(a2aRemoteAgentRoutes);
  let closeFixture: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await closeFixture?.();
    closeFixture = undefined;
  });

  test("atomically replaces a connection credential without mutating it in place", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/a2a/remote-agents",
      payload: {
        name: "Before rename",
        source: { type: "inline_card", agentCard: makeAgentCard("bearer") },
        auth: { type: "bearer", credential: "credential-v1" },
      },
    });
    expect(created.statusCode).toBe(200);
    const createdBody = created.json();
    const before = await A2aRemoteAgentModel.findByIdForOrganization({
      id: createdBody.id,
      organizationId: ctx.organizationId,
    });
    const secretId = before?.connection.secretId;
    if (!secretId) throw new Error("expected a stored connection secret");

    const response = await ctx.app.inject({
      method: "PUT",
      url: `/api/a2a/remote-agents/${createdBody.id}`,
      payload: {
        name: "After rename",
        enabled: false,
        auth: { type: "bearer", credential: "credential-v2" },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      id: createdBody.id,
      name: "After rename",
      connection: {
        authType: "bearer",
        hasCredential: true,
        enabled: false,
      },
    });
    expect(JSON.stringify(body)).not.toContain("credential-v2");
    expect(body.connection.secretId).toBeUndefined();

    const after = await A2aRemoteAgentModel.findByIdForOrganization({
      id: createdBody.id,
      organizationId: ctx.organizationId,
    });
    expect(after?.connection.secretId).not.toBe(secretId);
    if (!after?.connection.secretId) {
      throw new Error("expected a replacement connection secret");
    }
    const rotated = await secretManager().getSecret(after.connection.secretId);
    expect(rotated?.secret).toEqual({ credential: "credential-v2" });
    await expect(secretManager().getSecret(secretId)).resolves.toBeNull();
  });

  test("persists editable fields and visibility without rotating an omitted credential", async ({
    makeTeam,
  }) => {
    const team = await makeTeam(ctx.organizationId, ctx.user.id, {
      name: "Edited Audience",
    });
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/a2a/remote-agents",
      payload: {
        name: "Before edit",
        source: { type: "inline_card", agentCard: makeAgentCard("bearer") },
        auth: { type: "bearer", credential: "credential-kept" },
      },
    });
    const before = await A2aRemoteAgentModel.findByIdForOrganization({
      id: created.json().id,
      organizationId: ctx.organizationId,
    });

    const response = await ctx.app.inject({
      method: "PUT",
      url: `/api/a2a/remote-agents/${created.json().id}`,
      payload: {
        name: "After edit",
        description: "Edited description",
        enabled: false,
        scope: "team",
        teams: [team.id],
        users: [ctx.user.id],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      name: "After edit",
      description: "Edited description",
      scope: "team",
      teams: [{ id: team.id, name: "Edited Audience" }],
      users: [],
      connection: {
        enabled: false,
        authType: "bearer",
        hasCredential: true,
      },
    });
    const after = await A2aRemoteAgentModel.findByIdForOrganization({
      id: created.json().id,
      organizationId: ctx.organizationId,
    });
    expect(after?.connection.secretId).toBe(before?.connection.secretId);
  });

  test("reuses the stored credential when refreshing a protected Agent Card", async () => {
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
    const before = await A2aRemoteAgentModel.findByIdForOrganization({
      id: created.json().id,
      organizationId: ctx.organizationId,
    });

    const response = await ctx.app.inject({
      method: "PUT",
      url: `/api/a2a/remote-agents/${created.json().id}`,
      payload: {
        source: { type: "well_known", url: `${fixture.baseUrl}/` },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      name: "Deterministic A2A Test Agent",
      discoveryMode: "well_known",
      discoveryUrl: `${fixture.baseUrl}/`,
      connection: { authType: "bearer", hasCredential: true },
    });
    const after = await A2aRemoteAgentModel.findByIdForOrganization({
      id: created.json().id,
      organizationId: ctx.organizationId,
    });
    expect(after?.connection.secretId).toBe(before?.connection.secretId);
    expect(JSON.stringify(response.json())).not.toContain(
      "fixture-bearer-token",
    );
    expect(await fixture.requests()).toHaveLength(2);
  });

  test("requires a replacement credential before changing an authenticated discovery source", async () => {
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

    const response = await ctx.app.inject({
      method: "PUT",
      url: `/api/a2a/remote-agents/${created.json().id}`,
      payload: {
        source: { type: "well_known", url: changedFixture.baseUrl },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        message:
          "A replacement credential is required when changing the Agent Card discovery source",
      },
    });
    expect(await changedFixture.requests()).toEqual([]);
  });

  test("allows an unauthenticated connection to change discovery source", async () => {
    const fixture = await startA2aDiscoveryFixture("none");
    closeFixture = fixture.close;
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/a2a/remote-agents",
      payload: {
        source: { type: "inline_card", agentCard: makeAgentCard("none") },
        auth: { type: "none" },
      },
    });
    expect(created.statusCode).toBe(200);

    const response = await ctx.app.inject({
      method: "PUT",
      url: `/api/a2a/remote-agents/${created.json().id}`,
      payload: {
        source: { type: "well_known", url: fixture.baseUrl },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      discoveryMode: "well_known",
      discoveryUrl: fixture.baseUrl,
      connection: { authType: "none", hasCredential: false },
    });
    expect(await fixture.requests()).toHaveLength(1);
  });

  test("adopts an author when a migrated organization row becomes personal", async () => {
    const legacy = await createA2aRemoteAgent({
      organizationId: ctx.organizationId,
      input: {
        source: { type: "inline_card", agentCard: makeAgentCard("none") },
        auth: { type: "none" },
      },
    });
    expect(legacy.authorId).toBeNull();
    expect(legacy.scope).toBe("org");

    const response = await ctx.app.inject({
      method: "PUT",
      url: `/api/a2a/remote-agents/${legacy.id}`,
      payload: { scope: "personal" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: legacy.id,
      scope: "personal",
      authorId: ctx.user.id,
      authorName: ctx.user.name,
    });
  });

  test("returns 404 for an agent outside the current organization", async ({
    makeOrganization,
  }) => {
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/a2a/remote-agents",
      payload: {
        source: { type: "inline_card", agentCard: makeAgentCard("none") },
        auth: { type: "none" },
      },
    });
    expect(created.statusCode).toBe(200);

    ctx.organizationId = (await makeOrganization()).id;
    const response = await ctx.app.inject({
      method: "PUT",
      url: `/api/a2a/remote-agents/${created.json().id}`,
      payload: { name: "Cross-org rename" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { message: "Outbound A2A agent not found" },
    });
  });

  test("keeps the callable tool identity stable across display-name changes", async ({
    makeAgent,
  }) => {
    const first = await ctx.app.inject({
      method: "POST",
      url: "/api/a2a/remote-agents",
      payload: {
        name: "First Delegate",
        source: { type: "inline_card", agentCard: makeAgentCard("none") },
        auth: { type: "none" },
      },
    });
    const second = await ctx.app.inject({
      method: "POST",
      url: "/api/a2a/remote-agents",
      payload: {
        name: "Second Delegate",
        source: { type: "inline_card", agentCard: makeAgentCard("none") },
        auth: { type: "none" },
      },
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const parent = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
    });
    await AgentToolModel.createIfNotExists(parent.id, first.json().toolId);
    await AgentToolModel.createIfNotExists(parent.id, second.json().toolId);

    const response = await ctx.app.inject({
      method: "PUT",
      url: `/api/a2a/remote-agents/${first.json().id}`,
      payload: { name: "second-delegate" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().name).toBe("second-delegate");
    const [tool] = await db
      .select({ name: schema.toolsTable.name })
      .from(schema.toolsTable)
      .where(eq(schema.toolsTable.id, first.json().toolId));
    expect(tool.name).toMatch(/^agent__first_delegate__/);
  });
});
