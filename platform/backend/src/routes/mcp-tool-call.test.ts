/**
 * Contract: GET /api/mcp-tool-calls (+/:id)
 * - log:read scopes every listing and the detail route to rows attributed to
 *   the caller (mcp_tool_calls.user_id); log:admin lifts the scoping.
 * - Another user's (or an unattributed) row 404s on the detail route without
 *   log:admin — existence is not disclosed.
 * - The agentId listing applies the same agent-visibility check as the main
 *   listing (regression: it previously skipped access control entirely).
 */
import { vi } from "vitest";

// hasPermission resolves the session from request headers, which app.inject
// cannot provide — mock it (isMcpServerAdmin=false). userHasPermission stays
// REAL so log:read / log:admin resolution runs against actual membership rows.
vi.mock("@/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/auth")>()),
  hasPermission: vi.fn().mockResolvedValue({ success: false, error: null }),
}));

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

  const seedCall = (userId: string | null, method = "tools/call") =>
    McpToolCallModel.create({
      mcpServerName: "test-server",
      method,
      userId,
      agentId,
      toolCall: { id: "call-1", name: "test_tool", arguments: {} },
      toolResult: { content: [{ type: "text", text: "ok" }] },
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
        permission: { log: ["read"], agent: ["read"] },
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
      url: "/api/mcp-tool-calls?limit=10&offset=0",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().pagination.total).toBe(1);
    expect(response.json().data[0].id).toBe(ownRowId);
  });

  test("the org admin (log:admin) lists every user's tool calls", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/mcp-tool-calls?limit=10&offset=0",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().pagination.total).toBe(3);
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
      url: "/api/mcp-tool-calls?limit=10&offset=0",
    });
    expect(response.json().pagination.total).toBe(1);
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

  test("the agentId listing is access-controlled and own-scoped (regression: it skipped both)", async ({
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
      permission: { log: ["read"], agent: ["read"] },
    });
    await makeMember(caller.id, organizationId, { role: role.role });
    currentUser = caller;

    const invisible = await app.inject({
      method: "GET",
      url: `/api/mcp-tool-calls?limit=10&offset=0&agentId=${privateAgent.id}`,
    });
    expect(invisible.statusCode).toBe(200);
    expect(invisible.json().pagination.total).toBe(0);

    // A visible org agent still only yields the caller's own rows.
    const mine = await seedCall(caller.id);
    const visible = await app.inject({
      method: "GET",
      url: `/api/mcp-tool-calls?limit=10&offset=0&agentId=${agentId}`,
    });
    expect(visible.statusCode).toBe(200);
    expect(visible.json().pagination.total).toBe(1);
    expect(visible.json().data[0].id).toBe(mine.id);
  });
});
