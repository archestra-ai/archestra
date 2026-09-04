/**
 * Contract: GET /api/mcp-tool-calls (+/:id)
 * - log:read scopes every listing and the detail route to rows attributed to
 *   the caller (mcp_tool_calls.user_id); log:admin lifts the scoping.
 * - Another user's (or an unattributed) row 404s on the detail route without
 *   log:admin — existence is not disclosed.
 * - Every route is constrained to the active organization; agent and MCP
 *   server permissions do not widen or narrow log visibility.
 */
import McpToolCallModel from "@/models/mcp-tool-call";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("mcp-tool-call routes", () => {
  let app: FastifyInstanceWithZod;
  let currentUser: User;
  let organizationId: string;
  let agentId: string;
  let limitedUser: User;
  let otherUser: User;
  let ownRowId: string;
  let otherRowId: string;

  const seedCall = (
    userId: string | null,
    overrides: {
      method?: string;
      createdAt?: Date;
      mcpServerName?: string;
      agentId?: string;
    } = {},
  ) =>
    McpToolCallModel.create({
      mcpServerName: overrides.mcpServerName ?? "test-server",
      method: overrides.method ?? "tools/call",
      userId,
      agentId: overrides.agentId ?? agentId,
      toolCall: { id: "call-1", name: "test_tool", arguments: {} },
      toolResult: { content: [{ type: "text", text: "ok" }] },
      createdAt: overrides.createdAt,
    });

  beforeEach(
    async ({
      makeAdmin,
      makeOrganization,
      makeAgent,
      makeUser,
      makeMember,
      makeCustomRole,
    }) => {
      currentUser = await makeAdmin();
      const organization = await makeOrganization();
      organizationId = organization.id;
      await makeMember(currentUser.id, organizationId, { role: "admin" });

      const agent = await makeAgent({
        organizationId,
        authorId: currentUser.id,
        scope: "org",
      });
      agentId = agent.id;

      otherUser = await makeUser();
      limitedUser = await makeUser();
      const readOnlyLogs = await makeCustomRole(organizationId, {
        permission: { log: ["read"] },
      });
      await makeMember(limitedUser.id, organizationId, {
        role: readOnlyLogs.role,
      });

      ownRowId = (await seedCall(limitedUser.id)).id;
      otherRowId = (await seedCall(otherUser.id)).id;
      await seedCall(null);

      app = createFastifyInstance();
      app.addHook("onRequest", async (request) => {
        (request as typeof request & { user: User }).user = currentUser;
        (
          request as typeof request & { organizationId: string }
        ).organizationId = organizationId;
      });

      const { default: mcpToolCallRoutes } = await import("./mcp-tool-call");
      await app.register(mcpToolCallRoutes);
    },
  );

  afterEach(async () => {
    await app.close();
  });

  test("log:read lists only the caller's own tool calls", async () => {
    currentUser = limitedUser;

    const response = await app.inject({
      method: "GET",
      url: "/api/mcp-tool-calls?limit=10",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(1);
    expect(response.json().data[0].id).toBe(ownRowId);
  });

  test("log:admin alone lists every tool call in the active organization", async ({
    makeCustomRole,
    makeMember,
    makeUser,
  }) => {
    const auditor = await makeUser();
    const allLogs = await makeCustomRole(organizationId, {
      permission: { log: ["read", "admin"] },
    });
    await makeMember(auditor.id, organizationId, { role: allLogs.role });
    currentUser = auditor;

    const response = await app.inject({
      method: "GET",
      url: "/api/mcp-tool-calls?limit=10",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(3);
  });

  test("log:admin includes app-owned calls without app or agent permissions", async ({
    makeApp,
    makeCustomRole,
    makeMember,
    makeUser,
  }) => {
    const appOwner = await makeUser();
    const ownedApp = await makeApp({
      organizationId,
      authorId: appOwner.id,
      scope: "personal",
    });
    const appCall = await McpToolCallModel.create({
      ownerType: "app",
      appId: ownedApp.id,
      userId: appOwner.id,
      mcpServerName: "app-server",
      method: "tools/call",
      toolCall: { id: "app-call", name: "app_tool", arguments: {} },
      toolResult: { content: [{ type: "text", text: "ok" }] },
    });
    const auditor = await makeUser();
    const allLogs = await makeCustomRole(organizationId, {
      permission: { log: ["read", "admin"] },
    });
    await makeMember(auditor.id, organizationId, { role: allLogs.role });
    currentUser = auditor;

    const response = await app.inject({
      method: "GET",
      url: "/api/mcp-tool-calls?limit=10",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.map((row: { id: string }) => row.id)).toContain(
      appCall.id,
    );
  });

  test("the predefined platform_admin sees only their own tool calls", async ({
    makeUser,
    makeMember,
  }) => {
    const platformAdmin = await makeUser();
    await makeMember(platformAdmin.id, organizationId, {
      role: "platform_admin",
    });
    const mine = await seedCall(platformAdmin.id);
    currentUser = platformAdmin;

    const response = await app.inject({
      method: "GET",
      url: "/api/mcp-tool-calls?limit=10",
    });
    expect(response.json().data).toHaveLength(1);
    expect(response.json().data[0].id).toBe(mine.id);
  });

  test("log:read hides another user's (and unattributed) detail rows as 404", async () => {
    currentUser = limitedUser;

    const own = await app.inject({
      method: "GET",
      url: `/api/mcp-tool-calls/${ownRowId}`,
    });
    expect(own.statusCode).toBe(200);

    const other = await app.inject({
      method: "GET",
      url: `/api/mcp-tool-calls/${otherRowId}`,
    });
    expect(other.statusCode).toBe(404);
  });

  test("the agentId filter stays own-scoped without requiring agent permissions", async ({
    makeAgent,
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    // A personal agent belonging to someone else: invisible to the caller.
    const stranger = await makeUser();
    const privateAgent = await makeAgent({
      organizationId,
      authorId: stranger.id,
      scope: "personal",
    });

    const caller = await makeUser();
    const role = await makeCustomRole(organizationId, {
      permission: { log: ["read"] },
    });
    await makeMember(caller.id, organizationId, { role: role.role });
    currentUser = caller;

    const mine = await seedCall(caller.id, { agentId: privateAgent.id });
    const privateAgentRows = await app.inject({
      method: "GET",
      url: `/api/mcp-tool-calls?limit=10&agentId=${privateAgent.id}`,
    });
    expect(privateAgentRows.statusCode).toBe(200);
    expect(privateAgentRows.json().data).toHaveLength(1);
    expect(privateAgentRows.json().data[0].id).toBe(mine.id);
  });

  test("returns an empty cursor page when the caller has no attributed rows", async ({
    makeUser,
  }) => {
    currentUser = await makeUser();

    const response = await app.inject({
      method: "GET",
      url: "/api/mcp-tool-calls?limit=10",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: [],
      pagination: { limit: 10, hasNext: false, nextCursor: null },
    });
  });

  test("does not expose another organization's tool calls to log administrators", async ({
    makeAgent,
    makeApp,
    makeOrganization,
    makeUser,
  }) => {
    const otherOrganization = await makeOrganization();
    const owner = await makeUser();
    const otherAgent = await makeAgent({
      organizationId: otherOrganization.id,
      authorId: owner.id,
      scope: "org",
    });
    const foreign = await seedCall(owner.id, { agentId: otherAgent.id });
    const otherApp = await makeApp({
      organizationId: otherOrganization.id,
      authorId: owner.id,
    });
    const foreignAppCall = await McpToolCallModel.create({
      ownerType: "app",
      appId: otherApp.id,
      userId: owner.id,
      mcpServerName: "other-app-server",
      method: "tools/call",
      toolCall: { id: "other-app-call", name: "app_tool", arguments: {} },
      toolResult: { content: [{ type: "text", text: "ok" }] },
    });

    const list = await app.inject({
      method: "GET",
      url: "/api/mcp-tool-calls?limit=10",
    });
    expect(list.json().data).toHaveLength(3);

    const detail = await app.inject({
      method: "GET",
      url: `/api/mcp-tool-calls/${foreign.id}`,
    });
    expect(detail.statusCode).toBe(404);

    const appDetail = await app.inject({
      method: "GET",
      url: `/api/mcp-tool-calls/${foreignAppCall.id}`,
    });
    expect(appDetail.statusCode).toBe(404);
  });

  test("walks identical timestamps without repeating or skipping rows", async () => {
    const createdAt = new Date("2026-01-02T03:04:05.000Z");
    const seeded = await Promise.all(
      Array.from({ length: 5 }, () => seedCall(currentUser.id, { createdAt })),
    );

    const first = await app.inject({
      method: "GET",
      url: "/api/mcp-tool-calls?limit=4",
    });
    const firstBody = first.json();
    const second = await app.inject({
      method: "GET",
      url: `/api/mcp-tool-calls?limit=4&cursor=${encodeURIComponent(firstBody.pagination.nextCursor)}`,
    });
    const secondBody = second.json();

    const ids = [...firstBody.data, ...secondBody.data].map(
      (row: { id: string }) => row.id,
    );
    expect(new Set(ids).size).toBe(ids.length);
    for (const row of seeded) expect(ids).toContain(row.id);
    expect(secondBody.pagination).toMatchObject({
      hasNext: false,
      nextCursor: null,
    });
  });

  test("ignores legacy offsets and malformed cursors", async () => {
    const newest = await seedCall(currentUser.id, {
      createdAt: new Date("2099-01-01T00:00:00.000Z"),
    });

    for (const query of ["offset=999&page=999", "cursor=truncated"] as const) {
      const response = await app.inject({
        method: "GET",
        url: `/api/mcp-tool-calls?limit=1&${query}`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data[0].id).toBe(newest.id);
    }
  });

  test("ignores retired sort inputs and stays newest-first", async () => {
    await seedCall(currentUser.id, {
      createdAt: new Date("2098-01-01T00:00:00.000Z"),
    });
    const newest = await seedCall(currentUser.id, {
      createdAt: new Date("2099-01-01T00:00:00.000Z"),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/mcp-tool-calls?limit=1&sortDirection=asc&sortBy=method",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data[0].id).toBe(newest.id);
  });

  test("filters by exact MCP server name and ignores retired search", async () => {
    const targeted = await seedCall(currentUser.id, {
      mcpServerName: "target-server",
    });
    await seedCall(currentUser.id, { mcpServerName: "other-server" });

    const response = await app.inject({
      method: "GET",
      url: "/api/mcp-tool-calls?mcpServerName=target-server&search=other-server",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.map((row: { id: string }) => row.id)).toEqual([
      targeted.id,
    ]);
  });
});
