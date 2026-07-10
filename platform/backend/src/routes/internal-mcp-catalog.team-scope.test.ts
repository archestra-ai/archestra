import {
  ADMIN_ROLE_NAME,
  EDITOR_ROLE_NAME,
  MEMBER_ROLE_NAME,
} from "@archestra/shared";
import { type Mock, vi } from "vitest";
import McpCatalogTeamModel from "@/models/mcp-catalog-team";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth");

import { hasPermission } from "@/auth";

const mockHasPermission = hasPermission as Mock;

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

  test("team-admin promotes their own personal item to a team they administer", async ({
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
  }) => {
    const editor = await makeUser();
    await makeMember(editor.id, organizationId, { role: EDITOR_ROLE_NAME });
    const team = await makeTeam(organizationId, editor.id);
    await makeTeamMember(team.id, editor.id, { role: ADMIN_ROLE_NAME });

    currentUser = editor;
    const created = await post(remotePayload());
    expect(created.statusCode).toBe(200);

    const promoted = await put(created.json().id, {
      ...remotePayload({ name: created.json().name }),
      scope: "team",
      teams: [team.id],
    });

    expect(promoted.statusCode).toBe(200);
    expect(promoted.json().scope).toBe("team");
    expect(
      (
        await McpCatalogTeamModel.getTeamDetailsForCatalog(created.json().id)
      ).map((t) => t.id),
    ).toEqual([team.id]);
  });

  test("a plain member of a team cannot promote an item to it", async ({
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
  }) => {
    const editor = await makeUser();
    await makeMember(editor.id, organizationId, { role: EDITOR_ROLE_NAME });
    const team = await makeTeam(organizationId, editor.id);
    await makeTeamMember(team.id, editor.id, { role: MEMBER_ROLE_NAME });

    currentUser = editor;
    const created = await post(remotePayload());
    const res = await put(created.json().id, {
      ...remotePayload({ name: created.json().name }),
      scope: "team",
      teams: [team.id],
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/team-admin/i);
  });

  test("editor cannot promote to a team they are not a member of", async ({
    makeUser,
    makeMember,
    makeTeam,
  }) => {
    const editor = await makeUser();
    await makeMember(editor.id, organizationId, { role: EDITOR_ROLE_NAME });
    const otherTeam = await makeTeam(organizationId, editor.id); // not a member

    currentUser = editor;
    const created = await post(remotePayload());
    const res = await put(created.json().id, {
      ...remotePayload({ name: created.json().name }),
      scope: "team",
      teams: [otherTeam.id],
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/teams you are a member of/i);
  });

  test("editor cannot set org scope", async ({ makeUser, makeMember }) => {
    const editor = await makeUser();
    await makeMember(editor.id, organizationId, { role: EDITOR_ROLE_NAME });

    currentUser = editor;
    const created = await post(remotePayload());
    const res = await put(created.json().id, {
      ...remotePayload({ name: created.json().name }),
      scope: "org",
    });

    expect(res.statusCode).toBe(403);
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

  test("an admin of a write-level team can content-edit, preserving teams they don't control", async ({
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
  }) => {
    const admin = await makeUser();
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });
    const editor = await makeUser();
    await makeMember(editor.id, organizationId, { role: EDITOR_ROLE_NAME });
    const teamA = await makeTeam(organizationId, admin.id);
    const teamB = await makeTeam(organizationId, admin.id);
    await makeTeamMember(teamA.id, editor.id, { role: ADMIN_ROLE_NAME }); // editor administers A only

    currentUser = admin;
    const created = await post(
      remotePayload({
        scope: "team",
        teams: [
          { id: teamA.id, level: "write" },
          { id: teamB.id, level: "use" },
        ],
      }),
    );
    expect(created.statusCode).toBe(200);

    currentUser = editor;
    const edited = await put(created.json().id, {
      ...remotePayload({ name: created.json().name }),
      description: "edited by team-admin",
      scope: "team",
      teams: [teamA.id, teamB.id],
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

  test("adding a team with bare ids preserves the levels of the teams already assigned", async ({
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
  }) => {
    const admin = await makeUser();
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });
    const teamA = await makeTeam(organizationId, admin.id);
    const teamB = await makeTeam(organizationId, admin.id);
    const teamC = await makeTeam(organizationId, admin.id);
    await makeTeamMember(teamA.id, admin.id, { role: ADMIN_ROLE_NAME });

    currentUser = admin;
    const created = await post(
      remotePayload({
        scope: "team",
        teams: [
          { id: teamA.id, level: "write" },
          { id: teamB.id, level: "use" },
        ],
      }),
    );
    expect(created.statusCode).toBe(200);

    // Adding teamC changes the id set, so the assignments are rewritten. The
    // bare ids carry no level, and must not reset teamB from `use` to `write`.
    const edited = await put(created.json().id, {
      ...remotePayload({ name: created.json().name }),
      scope: "team",
      teams: [teamA.id, teamB.id, teamC.id],
    });
    expect(edited.statusCode).toBe(200);

    const teams = await McpCatalogTeamModel.getTeamDetailsForCatalog(
      created.json().id,
    );
    expect(Object.fromEntries(teams.map((t) => [t.id, t.level]))).toEqual({
      [teamA.id]: "write",
      [teamB.id]: "use",
      // A team assigned for the first time without a level defaults to `write`.
      [teamC.id]: "write",
    });
  });

  test("an admin of a use-level team cannot content-edit", async ({
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
  }) => {
    const admin = await makeUser();
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });
    const editor = await makeUser();
    await makeMember(editor.id, organizationId, { role: EDITOR_ROLE_NAME });
    const team = await makeTeam(organizationId, admin.id);
    await makeTeamMember(team.id, editor.id, { role: ADMIN_ROLE_NAME });

    currentUser = admin;
    const created = await post(
      remotePayload({ scope: "team", teams: [{ id: team.id, level: "use" }] }),
    );
    expect(created.statusCode).toBe(200);

    currentUser = editor;
    const res = await put(created.json().id, {
      ...remotePayload({ name: created.json().name }),
      description: "should be rejected",
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/write access/i);
  });

  test("member without team-admin cannot promote to team", async ({
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
  }) => {
    const member = await makeUser();
    await makeMember(member.id, organizationId, { role: MEMBER_ROLE_NAME });
    const team = await makeTeam(organizationId, member.id);
    await makeTeamMember(team.id, member.id);

    currentUser = member;
    const created = await post(remotePayload());
    const res = await put(created.json().id, {
      ...remotePayload({ name: created.json().name }),
      scope: "team",
      teams: [team.id],
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/team-admin/i);
  });

  test("admin bypasses membership and can assign arbitrary teams", async ({
    makeUser,
    makeMember,
    makeTeam,
  }) => {
    const admin = await makeUser();
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });
    const team = await makeTeam(organizationId, admin.id); // admin not a member

    currentUser = admin;
    const created = await post(
      remotePayload({ scope: "team", teams: [team.id] }),
    );
    expect(created.statusCode).toBe(200);
    expect(created.json().scope).toBe("team");
  });

  test("create with team scope rejects a non-member team", async ({
    makeUser,
    makeMember,
    makeTeam,
  }) => {
    const editor = await makeUser();
    await makeMember(editor.id, organizationId, { role: EDITOR_ROLE_NAME });
    const team = await makeTeam(organizationId, editor.id); // not a member

    currentUser = editor;
    const res = await post(remotePayload({ scope: "team", teams: [team.id] }));
    expect(res.statusCode).toBe(403);
  });

  test("cloning to team scope honors the membership gate", async ({
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
    const team = await makeTeam(organizationId, editor.id);
    await makeTeamMember(team.id, editor.id, { role: ADMIN_ROLE_NAME });

    const source = await makeInternalMcpCatalog({
      organizationId,
      authorId: admin.id,
      scope: "org",
    });

    currentUser = editor;
    const ok = await post(
      remotePayload({
        clonedFrom: source.id,
        scope: "team",
        teams: [team.id],
      }),
    );
    expect(ok.statusCode).toBe(200);

    const otherTeam = await makeTeam(organizationId, admin.id); // editor not member
    const denied = await post(
      remotePayload({
        clonedFrom: source.id,
        scope: "team",
        teams: [otherTeam.id],
      }),
    );
    expect(denied.statusCode).toBe(403);
  });

  test("team scope requires at least one team", async ({
    makeUser,
    makeMember,
  }) => {
    const admin = await makeUser();
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });

    currentUser = admin;
    const res = await post(remotePayload({ scope: "team", teams: [] }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/at least one team/i);
  });

  test("a team assigned without a level defaults to write", async ({
    makeUser,
    makeMember,
    makeTeam,
  }) => {
    const admin = await makeUser();
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });
    const team = await makeTeam(organizationId, admin.id);

    currentUser = admin;
    const created = await post(
      remotePayload({ scope: "team", teams: [team.id] }),
    );
    expect(created.statusCode).toBe(200);

    const teams = await McpCatalogTeamModel.getTeamDetailsForCatalog(
      created.json().id,
    );
    expect(teams).toEqual([
      expect.objectContaining({ id: team.id, level: "write" }),
    ]);
  });

  test("a levels-only edit persists the new level", async ({
    makeUser,
    makeMember,
    makeTeam,
  }) => {
    const admin = await makeUser();
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });
    const team = await makeTeam(organizationId, admin.id);

    currentUser = admin;
    const created = await post(
      remotePayload({
        scope: "team",
        teams: [{ id: team.id, level: "write" }],
      }),
    );
    expect(created.statusCode).toBe(200);

    const downgraded = await put(created.json().id, {
      ...remotePayload({ name: created.json().name }),
      scope: "team",
      teams: [{ id: team.id, level: "use" }],
    });
    expect(downgraded.statusCode).toBe(200);

    expect(
      await McpCatalogTeamModel.getTeamDetailsForCatalog(created.json().id),
    ).toEqual([expect.objectContaining({ id: team.id, level: "use" })]);
  });

  test("a shared (team) item cannot be demoted back to personal", async ({
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
  }) => {
    const editor = await makeUser();
    await makeMember(editor.id, organizationId, { role: EDITOR_ROLE_NAME });
    const team = await makeTeam(organizationId, editor.id);
    await makeTeamMember(team.id, editor.id, { role: ADMIN_ROLE_NAME });

    currentUser = editor;
    const created = await post(remotePayload());
    const promoted = await put(created.json().id, {
      ...remotePayload({ name: created.json().name }),
      scope: "team",
      teams: [team.id],
    });
    expect(promoted.statusCode).toBe(200);

    const res = await put(created.json().id, {
      ...remotePayload({ name: created.json().name }),
      scope: "personal",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/cannot be made personal/i);
  });
});
