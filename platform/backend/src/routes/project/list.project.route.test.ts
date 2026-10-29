import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { and, eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { ProjectPinModel } from "@/models";
import { projectService } from "@/services/project";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { shareForTest } from "@/test/sharing";
import type { ProjectVisibility, User } from "@/types";

/** Names of the projects returned by GET /api/projects, in response order. */
function names(json: string): string[] {
  return (JSON.parse(json) as { data: Array<{ name: string }> }).data.map(
    (p) => p.name,
  );
}

/**
 * GET /api/projects scope + search, mirroring the Agents filter: scope is the
 * project's share visibility (personal/team/org), with an admin-only owner
 * sub-filter (authorIds / excludeAuthorIds) under personal.
 */
describe("GET /api/projects (scope + search)", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let viewer: User;
  let actingUser: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    viewer = await makeUser();
    await makeMember(viewer.id, organizationId, {});
    actingUser = viewer;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
      (request as typeof request & { user: User }).user = actingUser;
    });
    const { default: projectRoutes } = await import("./project.routes");
    await app.register(projectRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  const create = (
    owner: User,
    name: string,
    description: string | null = null,
  ) =>
    projectService.create({
      organizationId,
      userId: owner.id,
      name,
      description,
    });
  const share = (
    _owner: User,
    id: string,
    visibility: ProjectVisibility,
    teamIds: string[] = [],
  ) =>
    shareForTest({
      resource: "project",
      scope: id,
      organizationId,
      visibility,
      teamIds,
    });
  const list = (query = "") =>
    app.inject({ method: "GET", url: `/api/projects${query}` });

  test("returns labels and filters by them", async () => {
    await projectService.create({
      organizationId,
      userId: viewer.id,
      name: "ready-project",
      description: null,
      labels: [{ key: "stage", value: "ready" }],
    });
    await create(viewer, "plain-project");

    const response = await list("?labels=stage%3Aready");
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject([
      {
        name: "ready-project",
        labels: [{ key: "stage", value: "ready" }],
      },
    ]);
    expect((await list("?labels=stage%3Amissing")).json()).toMatchObject({
      data: [],
      pagination: { total: 0 },
    });

    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/projects/labels/keys",
        })
      ).json(),
    ).toEqual(["stage"]);
  });

  test("scope filters by share visibility (personal / team / org)", async ({
    makeTeam,
    makeTeamMember,
  }) => {
    const team = await makeTeam(organizationId, viewer.id, { name: "T" });
    await makeTeamMember(team.id, viewer.id);
    await create(viewer, "private-one");
    const orgP = await create(viewer, "org-one");
    await share(viewer, orgP.id, "organization");
    const teamP = await create(viewer, "team-one");
    await share(viewer, teamP.id, "team", [team.id]);

    expect(names((await list()).body).sort()).toEqual([
      "org-one",
      "private-one",
      "team-one",
    ]);
    expect(names((await list("?scope=personal")).body)).toEqual([
      "private-one",
    ]);
    expect(names((await list("?scope=org")).body)).toEqual(["org-one"]);

    // The owner's team-shared project carries its team name(s) for the badge.
    const teamItems = JSON.parse((await list("?scope=team")).body)
      .data as Array<{
      name: string;
      shareTeamNames: string[] | null;
    }>;
    expect(teamItems.map((p) => p.name)).toEqual(["team-one"]);
    expect(teamItems[0]?.shareTeamNames).toEqual(["T"]);
  });

  test("scope=team + teamIds narrows to the chosen team", async ({
    makeTeam,
    makeTeamMember,
  }) => {
    const teamA = await makeTeam(organizationId, viewer.id, { name: "A" });
    await makeTeamMember(teamA.id, viewer.id);
    const teamB = await makeTeam(organizationId, viewer.id, { name: "B" });
    await makeTeamMember(teamB.id, viewer.id);
    const a = await create(viewer, "shared-A");
    await share(viewer, a.id, "team", [teamA.id]);
    const b = await create(viewer, "shared-B");
    await share(viewer, b.id, "team", [teamB.id]);

    expect(names((await list("?scope=team")).body).sort()).toEqual([
      "shared-A",
      "shared-B",
    ]);
    expect(names((await list(`?scope=team&teamIds=${teamA.id}`)).body)).toEqual(
      ["shared-A"],
    );
  });

  test("admin Personal: My (authorIds) vs Other users (excludeAuthorIds); viewerRole reflects access", async ({
    makeUser,
    makeMember,
  }) => {
    const admin = await makeUser({ email: "list-admin@test.com" });
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });
    const other = await makeUser({ email: "list-other@test.com" });
    await makeMember(other.id, organizationId, {});
    await create(admin, "admin-private");
    await create(other, "other-private");
    actingUser = admin;

    // personal with no owner filter → every private project. The admin role's
    // Full grant on every project is real read access, so another member's
    // private project reads as "shared", not read-only oversight.
    const all = JSON.parse((await list("?scope=personal")).body).data as Array<{
      name: string;
      viewerRole: string;
    }>;
    expect(all.map((p) => p.name).sort()).toEqual([
      "admin-private",
      "other-private",
    ]);
    expect(all.find((p) => p.name === "admin-private")?.viewerRole).toBe(
      "owner",
    );
    expect(all.find((p) => p.name === "other-private")?.viewerRole).toBe(
      "shared",
    );

    expect(
      names((await list(`?scope=personal&authorIds=${admin.id}`)).body),
    ).toEqual(["admin-private"]); // "My"
    expect(
      names((await list(`?scope=personal&excludeAuthorIds=${admin.id}`)).body),
    ).toEqual(["other-private"]); // "Other users"
    expect(
      names((await list(`?scope=personal&authorIds=${other.id}`)).body),
    ).toEqual(["other-private"]); // a specific other user
  });

  test("default 'All' shows exactly the projects the caller's grants reach", async ({
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
  }) => {
    const admin = await makeUser({ email: "list-admin-all@test.com" });
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });
    const other = await makeUser({ email: "list-other-all@test.com" });
    await makeMember(other.id, organizationId, {});

    // A team the admin belongs to, and one they don't. `other` does the
    // sharing, so they belong to both.
    const myTeam = await makeTeam(organizationId, admin.id, { name: "Mine" });
    await makeTeamMember(myTeam.id, admin.id);
    await makeTeamMember(myTeam.id, other.id);
    const foreignTeam = await makeTeam(organizationId, other.id, {
      name: "Foreign",
    });
    await makeTeamMember(foreignTeam.id, other.id);

    await create(admin, "admin-private");
    await create(other, "other-private");
    const otherOrg = await create(other, "other-org");
    await share(other, otherOrg.id, "organization");
    const sharedToMe = await create(other, "other-team-mine");
    await share(other, sharedToMe.id, "team", [myTeam.id]);
    const oversight = await create(other, "other-team-foreign");
    await share(other, oversight.id, "team", [foreignTeam.id]);
    actingUser = admin;

    // The admin role holds Full on every project, so "All" reaches every
    // project in the org, other members' private ones included.
    expect(names((await list()).body).sort()).toEqual([
      "admin-private",
      "other-org",
      "other-private",
      "other-team-foreign",
      "other-team-mine",
    ]);
    expect(
      names((await list(`?scope=team&teamIds=${foreignTeam.id}`)).body),
    ).toEqual(["other-team-foreign"]);

    // A plain member of "Mine" sees only what reaches them: the org-shared
    // project and the one shared with their team. Other members' private
    // projects and teams they aren't in stay hidden.
    await makeTeamMember(myTeam.id, viewer.id);
    actingUser = viewer;
    expect(names((await list()).body).sort()).toEqual([
      "other-org",
      "other-team-mine",
    ]);
    expect(
      names((await list(`?scope=team&teamIds=${foreignTeam.id}`)).body),
    ).toEqual([]);
  });

  test("access filter splits rows by how the caller reaches them, ignoring wildcard grants", async ({
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
  }) => {
    const admin = await makeUser();
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });
    const other = await makeUser();
    await makeMember(other.id, organizationId, {});
    const myTeam = await makeTeam(organizationId, admin.id);
    await makeTeamMember(myTeam.id, admin.id);
    const otherTeam = await makeTeam(organizationId, other.id);

    await create(admin, "mine");
    await create(other, "other-personal");
    const org = await create(other, "org");
    await share(other, org.id, "organization");
    const mineTeam = await create(other, "my-team");
    await share(other, mineTeam.id, "team", [myTeam.id]);
    const foreignTeam = await create(other, "other-team");
    await share(other, foreignTeam.id, "team", [otherTeam.id]);
    const sharedWithMe = await create(other, "shared-with-me");
    await shareForTest({
      resource: "project",
      scope: sharedWithMe.id,
      organizationId,
      visibility: "user",
      userIds: [admin.id],
    });
    actingUser = admin;

    const listNames = async (access?: string) => {
      const response = await list(access ? `?access=${access}` : "");
      expect(response.statusCode, response.body).toBe(200);
      return names(response.body).sort();
    };

    // The admin reads every project through a `*` grant, which the filter
    // must not count as "shared".
    expect(await listNames()).toEqual([
      "mine",
      "my-team",
      "org",
      "other-personal",
      "other-team",
      "shared-with-me",
    ]);
    expect(await listNames("mine,shared,org")).toEqual([
      "mine",
      "my-team",
      "org",
      "shared-with-me",
    ]);
    expect(await listNames("others")).toEqual(["other-personal", "other-team"]);
    expect(await listNames("mine")).toEqual(["mine"]);
    expect(await listNames("shared")).toEqual(["my-team", "shared-with-me"]);
    expect(await listNames("org")).toEqual(["org"]);
  });

  test("admin oversight of a team-shared project exposes its team names", async ({
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
  }) => {
    const admin = await makeUser({ email: "list-admin-teamnames@test.com" });
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });
    const other = await makeUser({ email: "list-other-teamnames@test.com" });
    await makeMember(other.id, organizationId, {});
    const team = await makeTeam(organizationId, other.id, { name: "Finance" });
    await makeTeamMember(team.id, other.id);
    const p = await create(other, "team-proj");
    await share(other, p.id, "team", [team.id]);
    actingUser = admin;

    // The admin isn't a Finance member; they reach the project through the
    // admin role's Full grant on every project (viewerRole "shared"), and as
    // someone who may manage it they still get the team name(s) for the pill
    // tooltip.
    const items = JSON.parse((await list("?scope=team")).body).data as Array<{
      name: string;
      viewerRole: string;
      shareTeamNames: string[] | null;
    }>;
    const item = items.find((i) => i.name === "team-proj");
    expect(item?.viewerRole).toBe("shared");
    expect(item?.shareTeamNames).toEqual(["Finance"]);
  });

  test("the owner sub-filter is ignored for non-admins", async ({
    makeUser,
    makeMember,
  }) => {
    const other = await makeUser({ email: "list-other2@test.com" });
    await makeMember(other.id, organizationId, {});
    await create(viewer, "viewer-private");
    await create(other, "other-private");

    // The owner sub-filter is admin-only, so both params are ignored: a non-admin
    // just sees their OWN private project, never another member's — regardless of
    // what authorIds/excludeAuthorIds they pass.
    expect(
      names((await list(`?scope=personal&excludeAuthorIds=${viewer.id}`)).body),
    ).toEqual(["viewer-private"]);
    expect(
      names((await list(`?scope=personal&authorIds=${other.id}`)).body),
    ).toEqual(["viewer-private"]);
  });

  /** Every page of a listing, walked with the given page size. */
  const walk = async (query: string, limit: number) => {
    const pages: { names: string[]; pagination: Record<string, unknown> }[] =
      [];
    for (let offset = 0; ; offset += limit) {
      const response = await list(
        `?${query}${query ? "&" : ""}limit=${limit}&offset=${offset}`,
      );
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json();
      pages.push({ names: names(response.body), pagination: body.pagination });
      if (!body.pagination.hasNext) return pages;
    }
  };

  test("pages are disjoint, cover every match, and keep owner-first order even when timestamps tie", async ({
    makeUser,
    makeMember,
  }) => {
    const other = await makeUser({ email: "paging-other@test.com" });
    await makeMember(other.id, organizationId, {});
    const own = await Promise.all(
      ["own-a", "own-b", "own-c", "own-d"].map((name) => create(viewer, name)),
    );
    const shared = await Promise.all(
      ["shared-a", "shared-b", "shared-c"].map((name) => create(other, name)),
    );
    for (const project of shared)
      await share(other, project.id, "organization");
    // Identical timestamps leave only the id to order by.
    await db
      .update(schema.projectsTable)
      .set({ createdAt: new Date("2026-01-01T00:00:00Z") })
      .where(
        inArray(
          schema.projectsTable.id,
          [...own, ...shared].map((p) => p.id),
        ),
      );

    const pages = await walk("", 3);
    expect(pages.map((p) => p.pagination)).toEqual([
      {
        currentPage: 1,
        limit: 3,
        total: 7,
        totalPages: 3,
        hasNext: true,
        hasPrev: false,
      },
      {
        currentPage: 2,
        limit: 3,
        total: 7,
        totalPages: 3,
        hasNext: true,
        hasPrev: true,
      },
      {
        currentPage: 3,
        limit: 3,
        total: 7,
        totalPages: 3,
        hasNext: false,
        hasPrev: true,
      },
    ]);
    const byId = (rows: { id: string; name: string }[]) =>
      [...rows].sort((a, b) => (a.id < b.id ? -1 : 1)).map((p) => p.name);
    expect(pages.flatMap((p) => p.names)).toEqual([
      ...byId(own),
      ...byId(shared),
    ]);
    // The same request gives the same page every time.
    expect((await walk("", 3)).flatMap((p) => p.names)).toEqual(
      pages.flatMap((p) => p.names),
    );
  });

  test("pinned=true lists only the caller's pins, pinned=false the rest, and both page with filters", async ({
    makeUser,
    makeMember,
  }) => {
    const other = await makeUser({ email: "pinned-other@test.com" });
    await makeMember(other.id, organizationId, {});
    const created = [];
    for (const name of [
      "report-1",
      "report-2",
      "report-3",
      "notes-1",
      "notes-2",
    ]) {
      created.push(await create(viewer, name));
    }
    const sharedReport = await create(other, "report-shared");
    await share(other, sharedReport.id, "organization");
    for (const project of [created[0], created[3], sharedReport]) {
      await ProjectPinModel.pin({ userId: viewer.id, projectId: project.id });
    }
    // Another member's pin is not the caller's.
    await ProjectPinModel.pin({ userId: other.id, projectId: created[1].id });

    const pinned = await list("?pinned=true&limit=100");
    expect(names(pinned.body).sort()).toEqual([
      "notes-1",
      "report-1",
      "report-shared",
    ]);
    expect(
      pinned.json().data.every((p: { pinnedAt: string | null }) => p.pinnedAt),
    ).toBe(true);

    const unpinned = await list("?pinned=false&limit=100");
    expect(names(unpinned.body).sort()).toEqual([
      "notes-2",
      "report-2",
      "report-3",
    ]);
    expect(unpinned.json().pagination.total).toBe(3);

    // Filters narrow before the page is cut: the total counts matches only.
    const pages = await walk("pinned=false&search=report", 1);
    expect(pages.flatMap((p) => p.names).sort()).toEqual([
      "report-2",
      "report-3",
    ]);
    expect(pages[0].pagination.total).toBe(2);
    expect(
      names((await list("?pinned=true&search=report")).body).sort(),
    ).toEqual(["report-1", "report-shared"]);
  });

  test("pinned=true drops a pin on a project the caller can no longer read", async ({
    makeUser,
    makeMember,
  }) => {
    const other = await makeUser({ email: "unshared-other@test.com" });
    await makeMember(other.id, organizationId, {});
    const project = await create(other, "was-shared");
    await share(other, project.id, "organization");
    await ProjectPinModel.pin({ userId: viewer.id, projectId: project.id });
    expect(names((await list("?pinned=true")).body)).toEqual(["was-shared"]);

    await shareForTest({
      resource: "project",
      scope: project.id,
      organizationId,
      visibility: null,
    });
    const after = await list("?pinned=true");
    expect(after.json()).toMatchObject({ data: [], pagination: { total: 0 } });
  });

  test("a page carries icons, counts and badge recipients for its own rows", async ({
    makeTeam,
  }) => {
    const team = await makeTeam(organizationId, viewer.id, {
      name: "Paging Team",
    });
    const project = await projectService.create({
      organizationId,
      userId: viewer.id,
      name: "with-icon",
      description: null,
      icon: "data:image/png;base64,AAAA",
    });
    await share(viewer, project.id, "team", [team.id]);

    const response = await list("?limit=1");
    expect(response.json().data).toEqual([
      expect.objectContaining({
        name: "with-icon",
        icon: "data:image/png;base64,AAAA",
        visibility: "team",
        shareTeamNames: ["Paging Team"],
        conversationCount: 0,
      }),
    ]);
  });

  test("the deleted slice pages newest first for a project admin", async ({
    makeUser,
    makeMember,
  }) => {
    const admin = await makeUser({ email: "trash-admin@test.com" });
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });
    for (const name of ["gone-1", "gone-2", "gone-3"]) {
      const project = await create(viewer, name);
      await db
        .update(schema.projectsTable)
        .set({ createdAt: new Date(`2026-01-0${name.at(-1)}T00:00:00Z`) })
        .where(inArray(schema.projectsTable.id, [project.id]));
      await projectService.delete({
        id: project.id,
        organizationId,
        userId: viewer.id,
      });
    }
    await create(viewer, "still-active");
    actingUser = admin;

    const pages = await walk("status=deleted", 2);
    expect(pages.map((p) => p.names)).toEqual([
      ["gone-3", "gone-2"],
      ["gone-1"],
    ]);
    expect(pages[0].pagination).toMatchObject({ total: 3, totalPages: 2 });
  });

  test("an overseer's own project stays in the All view without an owner grant", async () => {
    const own = await create(viewer, "own-ungranted");
    await create(viewer, "own-granted");
    // Strip every grant from the project's own policy, the owner's included.
    await db
      .update(schema.resourcePermissionPoliciesTable)
      .set({ grants: [] })
      .where(
        and(
          eq(schema.resourcePermissionPoliciesTable.resource, "project"),
          eq(schema.resourcePermissionPoliciesTable.scope, own.id),
        ),
      );

    const all = await projectService.list({
      organizationId,
      userId: viewer.id,
      isProjectAdmin: true,
    });
    expect(all.data.map((p) => [p.name, p.viewerRole]).sort()).toEqual([
      ["own-granted", "owner"],
      ["own-ungranted", "owner"],
    ]);
    expect(all.total).toBe(2);
  });

  test("teamIds narrows before paging", async ({ makeTeam }) => {
    const teamA = await makeTeam(organizationId, viewer.id, { name: "Pg A" });
    const teamB = await makeTeam(organizationId, viewer.id, { name: "Pg B" });
    for (const [name, team] of [
      ["a-1", teamA],
      ["a-2", teamA],
      ["a-3", teamA],
      ["b-1", teamB],
    ] as const) {
      const project = await create(viewer, name);
      await share(viewer, project.id, "team", [team.id]);
    }

    const pages = await walk(`scope=team&teamIds=${teamA.id}`, 2);
    expect(pages.map((p) => p.names.length)).toEqual([2, 1]);
    expect(pages.flatMap((p) => p.names).sort()).toEqual(["a-1", "a-2", "a-3"]);
    expect(pages[0].pagination.total).toBe(3);
  });

  test("with no pins, pinned=true is empty and pinned=false is everything", async () => {
    await create(viewer, "unpinned-1");
    await create(viewer, "unpinned-2");

    expect((await list("?pinned=true")).json()).toMatchObject({
      data: [],
      pagination: { total: 0 },
    });
    expect(names((await list("?pinned=false")).body).sort()).toEqual([
      "unpinned-1",
      "unpinned-2",
    ]);
  });

  test("rejects a pinned value other than true or false", async () => {
    expect((await list("?pinned=yes")).statusCode).toBe(400);
    expect((await list("?pinned=1")).statusCode).toBe(400);
  });

  test("search matches name and description (case-insensitive)", async () => {
    await create(viewer, "Alpha", "about cats");
    await create(viewer, "Beta", "about dogs");

    expect(names((await list("?search=ALPHA")).body)).toEqual(["Alpha"]);
    expect(names((await list("?search=cats")).body)).toEqual(["Alpha"]);
    expect(names((await list("?search=zzz")).body)).toEqual([]);
  });
});
