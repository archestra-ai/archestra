import { ADMIN_ROLE_NAME } from "@archestra/shared";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { projectService } from "@/services/project";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { ProjectShareVisibility, User } from "@/types";

/** Names of the projects returned by GET /api/projects, in response order. */
function names(json: string): string[] {
  return (JSON.parse(json) as Array<{ name: string }>).map((p) => p.name);
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
    owner: User,
    id: string,
    visibility: ProjectShareVisibility,
    teamIds: string[] = [],
  ) =>
    projectService.setShare({
      id,
      organizationId,
      userId: owner.id,
      visibility,
      teamIds,
    });
  const list = (query = "") =>
    app.inject({ method: "GET", url: `/api/projects${query}` });

  test("scope filters by share visibility (personal / team / org)", async ({
    makeTeam,
  }) => {
    const team = await makeTeam(organizationId, viewer.id, { name: "T" });
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
    const teamItems = JSON.parse((await list("?scope=team")).body) as Array<{
      name: string;
      shareTeamNames: string[] | null;
    }>;
    expect(teamItems.map((p) => p.name)).toEqual(["team-one"]);
    expect(teamItems[0]?.shareTeamNames).toEqual(["T"]);
  });

  test("scope=team + teamIds narrows to the chosen team", async ({
    makeTeam,
  }) => {
    const teamA = await makeTeam(organizationId, viewer.id, { name: "A" });
    const teamB = await makeTeam(organizationId, viewer.id, { name: "B" });
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

    // personal with no owner filter → every private project, tagged by access.
    const all = JSON.parse((await list("?scope=personal")).body) as Array<{
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
      "admin",
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

  test("admin default 'All' shows only accessible projects, hiding all oversight", async ({
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
  }) => {
    const admin = await makeUser({ email: "list-admin-all@test.com" });
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });
    const other = await makeUser({ email: "list-other-all@test.com" });
    await makeMember(other.id, organizationId, {});

    // A team the admin belongs to, and one they don't.
    const myTeam = await makeTeam(organizationId, admin.id, { name: "Mine" });
    await makeTeamMember(myTeam.id, admin.id);
    const foreignTeam = await makeTeam(organizationId, other.id, {
      name: "Foreign",
    });

    await create(admin, "admin-private");
    await create(other, "other-private");
    const otherOrg = await create(other, "other-org");
    await share(other, otherOrg.id, "organization");
    const sharedToMe = await create(other, "other-team-mine");
    await share(other, sharedToMe.id, "team", [myTeam.id]);
    const oversight = await create(other, "other-team-foreign");
    await share(other, oversight.id, "team", [foreignTeam.id]);
    actingUser = admin;

    // "All" shows only what the admin can actually access: their own projects,
    // org-shared ones, and team-shared ones for a team they belong to. Every
    // oversight row — other members' PRIVATE projects AND team-shared projects
    // for teams the admin isn't in — is dropped. Those stay reachable via
    // Personal → Other users and Team → pick that team.
    expect(names((await list()).body).sort()).toEqual([
      "admin-private",
      "other-org",
      "other-team-mine",
    ]);

    // The team-oversight project is still reachable by explicitly picking its team.
    expect(
      names((await list(`?scope=team&teamIds=${foreignTeam.id}`)).body),
    ).toEqual(["other-team-foreign"]);
  });

  test("admin oversight of a team-shared project exposes its team names", async ({
    makeUser,
    makeMember,
    makeTeam,
  }) => {
    const admin = await makeUser({ email: "list-admin-teamnames@test.com" });
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });
    const other = await makeUser({ email: "list-other-teamnames@test.com" });
    await makeMember(other.id, organizationId, {});
    const team = await makeTeam(organizationId, other.id, { name: "Finance" });
    const p = await create(other, "team-proj");
    await share(other, p.id, "team", [team.id]);
    actingUser = admin;

    // The admin isn't a Finance member, so they reach the project via oversight
    // (viewerRole "admin") — and still get the team name(s) for the pill tooltip.
    const items = JSON.parse((await list("?scope=team")).body) as Array<{
      name: string;
      viewerRole: string;
      shareTeamNames: string[] | null;
    }>;
    const item = items.find((i) => i.name === "team-proj");
    expect(item?.viewerRole).toBe("admin");
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

  test("search matches name and description (case-insensitive)", async () => {
    await create(viewer, "Alpha", "about cats");
    await create(viewer, "Beta", "about dogs");

    expect(names((await list("?search=ALPHA")).body)).toEqual(["Alpha"]);
    expect(names((await list("?search=cats")).body)).toEqual(["Alpha"]);
    expect(names((await list("?search=zzz")).body)).toEqual([]);
  });
});
