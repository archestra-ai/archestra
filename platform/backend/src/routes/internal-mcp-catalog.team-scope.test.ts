// Pre-migration compatibility. Migrated resources use the scoped-grants route suites.
import {
  ADMIN_ROLE_NAME,
  EDITOR_ROLE_NAME,
  MEMBER_ROLE_NAME,
  type ResourcePermissionGrant,
} from "@archestra/shared";
import { type Mock, vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import McpCatalogTeamModel from "@/models/mcp-catalog-team";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth");

import { hasPermission } from "@/auth";

const mockHasPermission = hasPermission as Mock;

const USE: ResourcePermissionGrant["actions"] = ["read", "use"];

/**
 * Team-scope RBAC for internal MCP catalog items. The handlers gate on the
 * real DB role (via `getUserPermissions`), so `hasPermission` is mocked to
 * success only to wave through unrelated gates (e.g. restricted environments).
 * The behavior under test is driven entirely by each actor's role + team
 * membership.
 */
describe("internal MCP catalog — team-scope RBAC", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let currentUser: User;

  beforeEach(async ({ makeOrganization }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });

    organizationId = (await makeOrganization()).id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = currentUser;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: routes } = await import("./internal-mcp-catalog");
    await app.register(routes);
    const { default: permissionRoutes } = await import(
      "./resource-permission/resource-permission.routes"
    );
    await app.register(permissionRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  function remotePayload(overrides: Record<string, unknown> = {}) {
    return {
      name: `srv-${crypto.randomUUID().slice(0, 8)}`,
      serverType: "remote",
      serverUrl: "https://example.test/mcp",
      ...overrides,
    };
  }

  function post(payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload,
    });
  }

  function put(id: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${id}`,
      payload,
    });
  }

  function get(id: string) {
    return app.inject({
      method: "GET",
      url: `/api/internal_mcp_catalog/${id}`,
    });
  }

  /**
   * Replace the item's direct grants through the permissions API. A grant
   * list that omits the caller's own grant keeps it, the way the editor does.
   */
  async function share(id: string, grants: ResourcePermissionGrant[]) {
    const key = { organizationId, resource: "mcpRegistry" as const, scope: id };
    const current = await ResourcePermissionPolicyModel.find(key);
    const own = (current?.grants ?? []).filter(
      (grant) =>
        grant.subject.type === "user" &&
        grant.subject.id === currentUser.id &&
        !grants.some(
          (next) =>
            next.subject.type === "user" && next.subject.id === currentUser.id,
        ),
    );
    return app.inject({
      method: "PUT",
      url: `/api/resource-permissions/mcpRegistry/${id}`,
      payload: {
        revision: current?.revision ?? 0,
        grants: [...own, ...grants],
      },
    });
  }

  // Sharing moved off the catalog edit onto the item's grants. Whoever
  // creates an item holds Full access on it and shares it through the
  // permissions API; the retired `scope`/`teams` fields on an edit are dropped.
  for (const role of [EDITOR_ROLE_NAME, MEMBER_ROLE_NAME]) {
    test(`an author with the ${role} role shares their own item with a team`, async ({
      makeUser,
      makeMember,
      makeTeam,
      makeTeamMember,
    }) => {
      const author = await makeUser();
      await makeMember(author.id, organizationId, { role });
      const teammate = await makeUser();
      await makeMember(teammate.id, organizationId, { role: MEMBER_ROLE_NAME });
      const team = await makeTeam(organizationId, author.id);
      await makeTeamMember(team.id, teammate.id);

      currentUser = author;
      const created = await post(remotePayload());
      expect(created.statusCode, created.body).toBe(200);
      const id = created.json().id;

      currentUser = teammate;
      expect((await get(id)).statusCode).toBe(404);

      currentUser = author;
      const shared = await share(id, [
        { subject: { type: "team", id: team.id }, actions: USE },
      ]);
      expect(shared.statusCode, shared.body).toBe(200);

      currentUser = teammate;
      expect((await get(id)).statusCode).toBe(200);
    });
  }

  test("an author may share with a team they neither belong to nor administer", async ({
    makeUser,
    makeMember,
    makeTeam,
  }) => {
    // Team membership used to bound whom an editor could share with. Grants
    // are bounded by what the caller holds on the item instead: an author
    // holds Full access, so any team in the organization is a valid recipient.
    const editor = await makeUser();
    await makeMember(editor.id, organizationId, { role: EDITOR_ROLE_NAME });
    const otherTeam = await makeTeam(organizationId, editor.id); // not a member

    currentUser = editor;
    const created = await post(remotePayload());
    const shared = await share(created.json().id, [
      { subject: { type: "team", id: otherTeam.id }, actions: USE },
    ]);
    expect(shared.statusCode, shared.body).toBe(200);
  });

  test("sharing is out of reach of an edit and of a caller without permission management", async ({
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
    makeInternalMcpCatalog,
  }) => {
    const admin = await makeUser();
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });
    const editor = await makeUser();
    await makeMember(editor.id, organizationId, { role: EDITOR_ROLE_NAME });
    const team = await makeTeam(organizationId, admin.id);
    await makeTeamMember(team.id, editor.id);
    const item = await makeInternalMcpCatalog({
      ...remotePayload(),
      serverType: "remote",
      organizationId,
      authorId: admin.id,
      access: { teams: [{ id: team.id, level: "edit" }] },
    });
    const key = {
      organizationId,
      resource: "mcpRegistry" as const,
      scope: item.id,
    };
    const before = (await ResourcePermissionPolicyModel.find(key))?.grants;

    currentUser = editor;
    // The retired field on an edit is refused, so the edit cannot widen the
    // item's audience…
    const edited = await put(item.id, {
      ...remotePayload({ name: item.name }),
      scope: "org",
    });
    expect(edited.statusCode, edited.body).toBe(400);
    expect((await ResourcePermissionPolicyModel.find(key))?.grants).toEqual(
      before,
    );

    // …and Edit access carries no permission management, so the permissions
    // API refuses to open it to the organization.
    const widened = await share(item.id, [
      ...(before ?? []),
      { subject: { type: "organization", id: "*" }, actions: USE },
    ]);
    expect(widened.statusCode).toBe(403);
    expect(widened.json().error.message).toMatch(/only grant permissions/i);
    expect((await ResourcePermissionPolicyModel.find(key))?.grants).toEqual(
      before,
    );
  });

  test("editor cannot edit another user's personal item", async ({
    makeUser,
    makeMember,
  }) => {
    const author = await makeUser();
    await makeMember(author.id, organizationId, { role: EDITOR_ROLE_NAME });
    const editor = await makeUser();
    await makeMember(editor.id, organizationId, { role: EDITOR_ROLE_NAME });

    currentUser = author;
    const created = await post(remotePayload());

    currentUser = editor;
    const res = await put(created.json().id, {
      ...remotePayload({ name: created.json().name }),
      description: "hijacked",
    });

    // Not visible to a non-author non-admin → 404.
    expect(res.statusCode).toBe(404);
  });

  test("a member of a write-level team can content-edit, preserving other teams", async ({
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
    makeInternalMcpCatalog,
  }) => {
    const admin = await makeUser();
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });
    const editor = await makeUser();
    await makeMember(editor.id, organizationId, { role: EDITOR_ROLE_NAME });
    const teamA = await makeTeam(organizationId, admin.id);
    const teamB = await makeTeam(organizationId, admin.id);
    await makeTeamMember(teamA.id, editor.id, { role: MEMBER_ROLE_NAME }); // editor belongs to A only

    const item = await makeInternalMcpCatalog({
      ...remotePayload(),
      serverType: "remote",
      organizationId,
      authorId: admin.id,
      access: {
        teams: [
          { id: teamA.id, level: "edit" },
          { id: teamB.id, level: "use" },
        ],
      },
      legacy: {
        scope: "team",
        teams: [
          { id: teamA.id, level: "write" },
          { id: teamB.id, level: "use" },
        ],
      },
    });
    const created = { json: () => item };

    currentUser = editor;
    const edited = await put(created.json().id, {
      ...remotePayload({ name: created.json().name }),
      description: "edited by team member",
    });

    expect(edited.statusCode).toBe(200);
    const teams = await McpCatalogTeamModel.getTeamDetailsForCatalog(
      created.json().id,
    );
    expect(teams.map((t) => t.id).sort()).toEqual([teamA.id, teamB.id].sort());
    expect(Object.fromEntries(teams.map((t) => [t.id, t.level]))).toEqual({
      [teamA.id]: "write",
      [teamB.id]: "use",
    });
  });

  test("an admin of a use-level team cannot content-edit", async ({
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
    makeInternalMcpCatalog,
  }) => {
    const admin = await makeUser();
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });
    const editor = await makeUser();
    await makeMember(editor.id, organizationId, { role: EDITOR_ROLE_NAME });
    const team = await makeTeam(organizationId, admin.id);
    await makeTeamMember(team.id, editor.id, { role: ADMIN_ROLE_NAME });

    const item = await makeInternalMcpCatalog({
      ...remotePayload(),
      serverType: "remote",
      organizationId,
      authorId: admin.id,
      access: { teams: [{ id: team.id, level: "use" }] },
      legacy: { scope: "team", teams: [{ id: team.id, level: "use" }] },
    });
    const created = { json: () => item };

    currentUser = editor;
    const res = await put(created.json().id, {
      ...remotePayload({ name: created.json().name }),
      description: "should be rejected",
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toContain(
      "permission to perform this action",
    );
  });

  test("admin bypasses membership and can grant arbitrary teams at create", async ({
    makeUser,
    makeMember,
    makeTeam,
  }) => {
    const admin = await makeUser();
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });
    const team = await makeTeam(organizationId, admin.id); // admin not a member

    currentUser = admin;
    const created = await post(
      remotePayload({
        initialGrants: [
          { subject: { type: "team", id: team.id }, actions: ["read", "use"] },
        ],
      }),
    );
    expect(created.statusCode, created.body).toBe(200);
    const policy = await ResourcePermissionPolicyModel.find({
      organizationId,
      resource: "mcpRegistry",
      scope: created.json().id,
    });
    expect(
      policy?.grants.some(
        (grant) =>
          grant.subject.type === "team" && grant.subject.id === team.id,
      ),
    ).toBe(true);
  });

  test("create refuses the retired scope and teams fields", async ({
    makeUser,
    makeMember,
    makeTeam,
  }) => {
    const admin = await makeUser();
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });
    const team = await makeTeam(organizationId, admin.id);

    currentUser = admin;
    const res = await post(remotePayload({ scope: "team", teams: [team.id] }));
    expect(res.statusCode).toBe(400);
  });

  test("lowering a team's grant takes away its content edits", async ({
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
    makeInternalMcpCatalog,
  }) => {
    const admin = await makeUser();
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });
    const editor = await makeUser();
    await makeMember(editor.id, organizationId, { role: EDITOR_ROLE_NAME });
    const team = await makeTeam(organizationId, admin.id);
    await makeTeamMember(team.id, editor.id);
    const item = await makeInternalMcpCatalog({
      ...remotePayload(),
      serverType: "remote",
      organizationId,
      authorId: admin.id,
      access: { teams: [{ id: team.id, level: "edit" }] },
    });
    const edit = () =>
      put(item.id, {
        ...remotePayload({ name: item.name }),
        description: `edit ${crypto.randomUUID()}`,
      });

    currentUser = editor;
    expect((await edit()).statusCode).toBe(200);

    currentUser = admin;
    const current = await ResourcePermissionPolicyModel.find({
      organizationId,
      resource: "mcpRegistry",
      scope: item.id,
    });
    const lowered = await share(item.id, [
      ...(current?.grants ?? []).filter(
        (grant) => grant.subject.type !== "team",
      ),
      { subject: { type: "team", id: team.id }, actions: USE },
    ]);
    expect(lowered.statusCode, lowered.body).toBe(200);

    currentUser = editor;
    expect((await get(item.id)).statusCode).toBe(200);
    expect((await edit()).statusCode).toBe(403);
  });

  test("an author can take a team-shared item back to personal", async ({
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
  }) => {
    // Unsharing used to be refused. With grants, revoking the team's grant is
    // an ordinary edit for whoever manages the item's permissions, and it
    // takes effect: the team loses the item.
    const editor = await makeUser();
    await makeMember(editor.id, organizationId, { role: EDITOR_ROLE_NAME });
    const teammate = await makeUser();
    await makeMember(teammate.id, organizationId, { role: MEMBER_ROLE_NAME });
    const team = await makeTeam(organizationId, editor.id);
    await makeTeamMember(team.id, teammate.id);

    currentUser = editor;
    const id = (await post(remotePayload())).json().id;
    const key = { organizationId, resource: "mcpRegistry" as const, scope: id };
    const ownGrants = (await ResourcePermissionPolicyModel.find(key))?.grants;
    const shared = await share(id, [
      ...(ownGrants ?? []),
      { subject: { type: "team", id: team.id }, actions: USE },
    ]);
    expect(shared.statusCode, shared.body).toBe(200);
    currentUser = teammate;
    expect((await get(id)).statusCode).toBe(200);

    currentUser = editor;
    const revoked = await share(id, ownGrants ?? []);
    expect(revoked.statusCode, revoked.body).toBe(200);
    currentUser = teammate;
    expect((await get(id)).statusCode).toBe(404);
  });
});
