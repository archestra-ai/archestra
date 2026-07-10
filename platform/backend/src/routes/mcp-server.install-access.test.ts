import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@archestra/shared";
import { vi } from "vitest";
import { hasPermission, userHasPermission } from "@/auth/utils";
import McpCatalogTeamModel from "@/models/mcp-catalog-team";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

const { connectAndGetToolsMock } = vi.hoisted(() => ({
  connectAndGetToolsMock: vi.fn(),
}));

vi.mock("@/clients/mcp-client", () => ({
  McpServerNotReadyError: class extends Error {},
  McpServerConnectionTimeoutError: class extends Error {},
  default: {
    connectAndGetTools: connectAndGetToolsMock,
    invalidateConnectionsForServer: vi.fn(),
    inspectServer: vi.fn(),
  },
}));

vi.mock("@/auth/utils");

const hasPermissionMock = vi.mocked(hasPermission);
const userHasPermissionMock = vi.mocked(userHasPermission);

/**
 * Install-time authorization against the catalog item's access model:
 * installing needs `use` on the item, and creating a *shared* install of a
 * team-scoped item — the connection other members resolve through — needs
 * `write`. `hasPermission` is mocked to gate only the caller's admin status;
 * team roles come from the real DB.
 */
describe("MCP Server Install - catalog access", () => {
  let app: FastifyInstanceWithZod;
  let currentUser: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization }) => {
    vi.clearAllMocks();
    // Non-admin by default; the mcpServerInstallation:create gate and the
    // catalog admin bypass both read through this mock.
    hasPermissionMock.mockResolvedValue({ success: false, error: null });
    userHasPermissionMock.mockResolvedValue(false);
    connectAndGetToolsMock.mockResolvedValue([]);

    organizationId = (await makeOrganization()).id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = currentUser;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: mcpServerRoutes } = await import("./mcp-server");
    await app.register(mcpServerRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  function install(payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/mcp_server",
      // `name` is overwritten from the catalog row; the schema still requires it.
      payload: { name: "install", serverType: "remote", ...payload },
    });
  }

  test("a user the catalog item does not admit cannot install it", async ({
    makeUser,
    makeMember,
    makeInternalMcpCatalog,
  }) => {
    const author = await makeUser();
    const outsider = await makeUser();
    await makeMember(outsider.id, organizationId, { role: MEMBER_ROLE_NAME });
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      authorId: author.id,
      scope: "personal",
      serverType: "remote",
      serverUrl: "https://example.test/mcp",
    });

    currentUser = outsider;
    const res = await install({ catalogId: catalog.id, scope: "personal" });

    // Indistinguishable from an item that does not exist: an install attempt
    // must never reveal another user's personal-scope item.
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/catalog item not found/i);
  });

  test("a use-level team member may install the item for themselves", async ({
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
    makeInternalMcpCatalog,
  }) => {
    const member = await makeUser();
    await makeMember(member.id, organizationId, { role: MEMBER_ROLE_NAME });
    const team = await makeTeam(organizationId, member.id);
    await makeTeamMember(team.id, member.id, { role: MEMBER_ROLE_NAME });
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      authorId: member.id,
      scope: "team",
      teams: [{ id: team.id, level: "use" }],
      serverType: "remote",
      serverUrl: "https://example.test/mcp",
    });

    currentUser = member;
    const res = await install({ catalogId: catalog.id, scope: "personal" });

    expect(res.statusCode).toBe(200);
    expect(res.json().scope).toBe("personal");
  });

  test("a use-level team admin may not create a shared team install", async ({
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
    makeInternalMcpCatalog,
  }) => {
    const teamAdmin = await makeUser();
    await makeMember(teamAdmin.id, organizationId, { role: MEMBER_ROLE_NAME });
    const team = await makeTeam(organizationId, teamAdmin.id);
    await makeTeamMember(team.id, teamAdmin.id, { role: ADMIN_ROLE_NAME });
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      authorId: teamAdmin.id,
      scope: "team",
      teams: [{ id: team.id, level: "use" }],
      serverType: "remote",
      serverUrl: "https://example.test/mcp",
    });

    currentUser = teamAdmin;
    const res = await install({
      catalogId: catalog.id,
      scope: "team",
      teamId: team.id,
    });

    expect(res.statusCode).toBe(403);
  });

  test("a write-level team admin may create a shared team install", async ({
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
    makeInternalMcpCatalog,
  }) => {
    const teamAdmin = await makeUser();
    await makeMember(teamAdmin.id, organizationId, { role: MEMBER_ROLE_NAME });
    const team = await makeTeam(organizationId, teamAdmin.id);
    await makeTeamMember(team.id, teamAdmin.id, { role: ADMIN_ROLE_NAME });
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      authorId: teamAdmin.id,
      scope: "team",
      teams: [{ id: team.id, level: "write" }],
      serverType: "remote",
      serverUrl: "https://example.test/mcp",
    });
    expect(
      (await McpCatalogTeamModel.getTeamDetailsForCatalog(catalog.id))[0].level,
    ).toBe("write");

    currentUser = teamAdmin;
    const res = await install({
      catalogId: catalog.id,
      scope: "team",
      teamId: team.id,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().scope).toBe("team");
  });

  test("an org-scoped item is installable by any organization member", async ({
    makeUser,
    makeMember,
    makeInternalMcpCatalog,
  }) => {
    const member = await makeUser();
    await makeMember(member.id, organizationId, { role: MEMBER_ROLE_NAME });
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      scope: "org",
      serverType: "remote",
      serverUrl: "https://example.test/mcp",
    });

    currentUser = member;
    const res = await install({ catalogId: catalog.id, scope: "personal" });

    expect(res.statusCode).toBe(200);
  });
});
