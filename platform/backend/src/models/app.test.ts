import { deleteAppBacking } from "@/services/apps/app-mcp-backing";
import { describe, expect, test } from "@/test";
import AppModel from "./app";
import AppAccessModel from "./app-access";
import AppVersionModel from "./app-version";

describe("AppModel.create", () => {
  test("creates an app with an immutable version 1", async ({ makeApp }) => {
    const app = await makeApp({ html: "<h1>hi</h1>" });
    expect(app.latestVersion).toBe(1);

    const head = await AppVersionModel.findByAppAndVersion(app.id, 1);
    expect(head?.html).toBe("<h1>hi</h1>");
  });

  test("rejects a name conflict for the same author", async ({
    makeApp,
    makeUser,
  }) => {
    const author = await makeUser();
    const first = await makeApp({
      name: "Dup",
      scope: "org",
      authorId: author.id,
    });
    // Names are unique per author (apps_org_author_name_uidx), regardless of
    // scope, so the same author cannot reuse a name even across scopes.
    await expect(
      makeApp({
        name: "Dup",
        scope: "personal",
        authorId: author.id,
        organizationId: first.organizationId,
      }),
    ).rejects.toThrow();
  });

  test("lets distinct authors keep same-named personal apps", async ({
    makeApp,
    makeUser,
  }) => {
    const a = await makeUser();
    const b = await makeUser();
    const first = await makeApp({
      name: "Mine",
      scope: "personal",
      authorId: a.id,
    });
    const second = await makeApp({
      name: "Mine",
      scope: "personal",
      authorId: b.id,
      organizationId: first.organizationId,
    });
    expect(second.id).not.toBe(first.id);
  });
});

describe("AppModel.update", () => {
  test("metadata-only edit does not fork a version", async ({ makeApp }) => {
    const app = await makeApp();
    const updated = await AppModel.update({
      id: app.id,
      patch: { description: "now described" },
    });
    expect(updated?.description).toBe("now described");
    expect(updated?.latestVersion).toBe(1);
  });

  test("an html change forks v2 and bumps the head", async ({ makeApp }) => {
    const app = await makeApp({ html: "<h1>v1</h1>" });
    const updated = await AppModel.update({
      id: app.id,
      version: { html: "<h1>v2</h1>", uiPermissions: null },
    });
    expect(updated?.latestVersion).toBe(2);
    const v2 = await AppVersionModel.findByAppAndVersion(app.id, 2);
    expect(v2?.html).toBe("<h1>v2</h1>");
  });

  test("an identical payload is a no-op (suppressed fork)", async ({
    makeApp,
  }) => {
    const app = await makeApp({ html: "<h1>same</h1>" });
    const updated = await AppModel.update({
      id: app.id,
      version: { html: "<h1>same</h1>", uiPermissions: null },
    });
    expect(updated?.latestVersion).toBe(1);
  });
});

describe("AppModel spec", () => {
  const spec = {
    summary: "A todo app",
    features: ["add", "complete"],
    tools: ["archestra__app_data_get"],
  };

  test("snapshots the spec onto version 1 at create", async ({ makeApp }) => {
    const app = await makeApp({ spec });
    expect(app.spec).toEqual(spec);
    const v1 = await AppVersionModel.findByAppAndVersion(app.id, 1);
    expect(v1?.spec).toEqual(spec);
  });

  test("a spec-only edit updates the head without forking", async ({
    makeApp,
  }) => {
    const app = await makeApp({ spec });
    const nextSpec = { ...spec, summary: "A better todo app" };
    const updated = await AppModel.update({
      id: app.id,
      patch: { spec: nextSpec },
    });
    expect(updated?.spec).toEqual(nextSpec);
    expect(updated?.latestVersion).toBe(1);
  });

  test("snapshots the head spec onto a forked version", async ({ makeApp }) => {
    const app = await makeApp({ spec });
    const updated = await AppModel.update({
      id: app.id,
      version: { html: "<h1>v2</h1>", uiPermissions: null },
    });
    expect(updated?.latestVersion).toBe(2);
    const v2 = await AppVersionModel.findByAppAndVersion(app.id, 2);
    expect(v2?.spec).toEqual(spec);
  });

  test("a spec set in the same edit as an html fork lands on the new version", async ({
    makeApp,
  }) => {
    const app = await makeApp({ spec });
    const nextSpec = { ...spec, features: ["add", "complete", "filter"] };
    const updated = await AppModel.update({
      id: app.id,
      patch: { spec: nextSpec },
      version: { html: "<h1>v2</h1>", uiPermissions: null },
    });
    expect(updated?.latestVersion).toBe(2);
    const v2 = await AppVersionModel.findByAppAndVersion(app.id, 2);
    expect(v2?.spec).toEqual(nextSpec);
  });
});

describe("AppModel.delete (soft)", () => {
  test("hides the app and frees its name for re-use", async ({ makeApp }) => {
    const app = await makeApp({ name: "Reusable", scope: "org" });
    // The delete flow soft-deletes the app and tears down its backing catalog,
    // which owns the name-uniqueness — freeing the name.
    await deleteAppBacking(app);
    expect(await AppModel.delete(app.id)).toBe(true);
    expect(await AppModel.findById(app.id)).toBeNull();

    const recreated = await makeApp({
      name: "Reusable",
      scope: "org",
      organizationId: app.organizationId,
    });
    expect(recreated.id).not.toBe(app.id);
  });
});

describe("AppVersionModel.computeContentHash", () => {
  test("is stable across permission key ordering", () => {
    const a = AppVersionModel.computeContentHash({
      html: "<p/>",
      uiPermissions: { camera: {}, clipboardWrite: {} },
    });
    const b = AppVersionModel.computeContentHash({
      html: "<p/>",
      uiPermissions: { clipboardWrite: {}, camera: {} },
    });
    expect(a).toBe(b);
  });

  test("differs when html differs", () => {
    const a = AppVersionModel.computeContentHash({
      html: "<p>1</p>",
      uiPermissions: null,
    });
    const b = AppVersionModel.computeContentHash({
      html: "<p>2</p>",
      uiPermissions: null,
    });
    expect(a).not.toBe(b);
  });
});

describe("AppAccessModel accessibility", () => {
  test("scopes visibility by org/personal/team and excludes deleted", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
    makeApp,
  }) => {
    const org = await makeOrganization();
    const author = await makeUser();
    const member = await makeUser();
    const outsider = await makeUser();
    await makeMember(author.id, org.id);
    await makeMember(member.id, org.id);
    await makeMember(outsider.id, org.id);
    const team = await makeTeam(org.id, author.id);
    await makeTeamMember(team.id, author.id);
    await makeTeamMember(team.id, member.id);

    const orgApp = await makeApp({ organizationId: org.id, scope: "org" });
    const personalApp = await makeApp({
      organizationId: org.id,
      scope: "personal",
      authorId: author.id,
    });
    const teamApp = await makeApp({
      organizationId: org.id,
      scope: "team",
      authorId: author.id,
      teamIds: [team.id],
    });
    const deletedApp = await makeApp({ organizationId: org.id, scope: "org" });
    await AppModel.delete(deletedApp.id);

    const authorIds = await AppAccessModel.getUserAccessibleAppIds({
      organizationId: org.id,
      userId: author.id,
    });
    expect(new Set(authorIds)).toEqual(
      new Set([orgApp.id, personalApp.id, teamApp.id]),
    );

    const memberIds = await AppAccessModel.getUserAccessibleAppIds({
      organizationId: org.id,
      userId: member.id,
    });
    expect(new Set(memberIds)).toEqual(new Set([orgApp.id, teamApp.id]));

    const outsiderIds = await AppAccessModel.getUserAccessibleAppIds({
      organizationId: org.id,
      userId: outsider.id,
    });
    expect(outsiderIds).toEqual([orgApp.id]);
  });

  test("userHasAppAccess honors scope and admin bypass", async ({
    makeOrganization,
    makeUser,
    makeApp,
  }) => {
    const org = await makeOrganization();
    const author = await makeUser();
    const other = await makeUser();
    const personalApp = await makeApp({
      organizationId: org.id,
      scope: "personal",
      authorId: author.id,
    });

    expect(
      await AppAccessModel.userHasAppAccess({
        organizationId: org.id,
        userId: author.id,
        app: personalApp,
        isAppAdmin: false,
      }),
    ).toBe(true);
    expect(
      await AppAccessModel.userHasAppAccess({
        organizationId: org.id,
        userId: other.id,
        app: personalApp,
        isAppAdmin: false,
      }),
    ).toBe(false);
    expect(
      await AppAccessModel.userHasAppAccess({
        organizationId: org.id,
        userId: other.id,
        app: personalApp,
        isAppAdmin: true,
      }),
    ).toBe(true);
  });
});
