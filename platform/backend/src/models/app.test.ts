import { describe, expect, test } from "@/test";
import { ApiError } from "@/types";
import { APP_DATA_MAX_VALUE_BYTES } from "@/types/app";
import AppModel from "./app";
import AppDataModel from "./app-data";
import AppTeamModel from "./app-team";
import AppToolModel from "./app-tool";
import AppVersionModel from "./app-version";

describe("AppModel.create", () => {
  test("creates an app with an immutable version 1", async ({ makeApp }) => {
    const app = await makeApp({ html: "<h1>hi</h1>" });
    expect(app.latestVersion).toBe(1);

    const head = await AppVersionModel.findByAppAndVersion(app.id, 1);
    expect(head?.html).toBe("<h1>hi</h1>");
    expect(head?.uiCsp).toBeNull();
  });

  test("returns null on a name conflict in the same shared namespace", async ({
    makeApp,
  }) => {
    const first = await makeApp({ name: "Dup", scope: "org" });
    const dup = await AppModel.create({
      app: { name: "Dup", scope: "org", organizationId: first.organizationId },
      payload: { html: "<p/>", uiCsp: null, uiPermissions: null },
    });
    expect(dup).toBeNull();
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
    const second = await AppModel.create({
      app: {
        name: "Mine",
        scope: "personal",
        authorId: b.id,
        organizationId: first.organizationId,
      },
      payload: { html: "<p/>", uiCsp: null, uiPermissions: null },
    });
    expect(second).not.toBeNull();
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
      version: { html: "<h1>v2</h1>", uiCsp: null, uiPermissions: null },
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
      version: { html: "<h1>same</h1>", uiCsp: null, uiPermissions: null },
    });
    expect(updated?.latestVersion).toBe(1);
  });
});

describe("AppModel.delete (soft)", () => {
  test("hides the app and frees its name for re-use", async ({ makeApp }) => {
    const app = await makeApp({ name: "Reusable", scope: "org" });
    expect(await AppModel.delete(app.id)).toBe(true);
    expect(await AppModel.findById(app.id)).toBeNull();

    const recreated = await AppModel.create({
      app: {
        name: "Reusable",
        scope: "org",
        organizationId: app.organizationId,
      },
      payload: { html: "<p/>", uiCsp: null, uiPermissions: null },
    });
    expect(recreated).not.toBeNull();
  });
});

describe("AppVersionModel.computeContentHash", () => {
  test("is stable across CSP key ordering", () => {
    const a = AppVersionModel.computeContentHash({
      html: "<p/>",
      uiCsp: { connectDomains: ["https://a"], resourceDomains: ["https://b"] },
      uiPermissions: null,
    });
    const b = AppVersionModel.computeContentHash({
      html: "<p/>",
      uiCsp: { resourceDomains: ["https://b"], connectDomains: ["https://a"] },
      uiPermissions: null,
    });
    expect(a).toBe(b);
  });

  test("differs when html differs", () => {
    const a = AppVersionModel.computeContentHash({
      html: "<p>1</p>",
      uiCsp: null,
      uiPermissions: null,
    });
    const b = AppVersionModel.computeContentHash({
      html: "<p>2</p>",
      uiCsp: null,
      uiPermissions: null,
    });
    expect(a).not.toBe(b);
  });
});

describe("AppToolModel.isToolAllowed", () => {
  test("is fail-closed for unassigned tools", async ({
    makeApp,
    makeTool,
    makeAppTool,
  }) => {
    const app = await makeApp();
    const tool = await makeTool({ name: "allowed-tool" });
    expect(await AppToolModel.isToolAllowed(app.id, "allowed-tool")).toBe(
      false,
    );

    await makeAppTool(app.id, tool.id);
    expect(await AppToolModel.isToolAllowed(app.id, "allowed-tool")).toBe(true);
    expect(await AppToolModel.isToolAllowed(app.id, "other")).toBe(false);
  });
});

describe("AppDataModel", () => {
  test("round-trips get/set/list/keys/delete", async ({ makeApp }) => {
    const app = await makeApp();
    await AppDataModel.set(app.id, "k1", { n: 1 });
    await AppDataModel.set(app.id, "k2", "two");

    expect(await AppDataModel.get(app.id, "k1")).toEqual({ n: 1 });
    expect(await AppDataModel.keys(app.id)).toEqual(["k1", "k2"]);
    expect(await AppDataModel.list(app.id)).toEqual([
      { key: "k1", value: { n: 1 } },
      { key: "k2", value: "two" },
    ]);

    // set on an existing key updates in place
    await AppDataModel.set(app.id, "k1", { n: 2 });
    expect(await AppDataModel.get(app.id, "k1")).toEqual({ n: 2 });

    expect(await AppDataModel.delete(app.id, "k1")).toBe(true);
    expect(await AppDataModel.get(app.id, "k1")).toBeNull();
  });

  test("rejects an oversized value cleanly", async ({ makeApp }) => {
    const app = await makeApp();
    const big = "x".repeat(APP_DATA_MAX_VALUE_BYTES + 1);
    await expect(AppDataModel.set(app.id, "big", big)).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  test("isolates entries per app", async ({ makeApp }) => {
    const a = await makeApp();
    const b = await makeApp();
    await AppDataModel.set(a.id, "shared", "from-a");
    expect(await AppDataModel.get(b.id, "shared")).toBeNull();
  });
});

describe("AppTeamModel accessibility", () => {
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

    const authorIds = await AppTeamModel.getUserAccessibleAppIds({
      organizationId: org.id,
      userId: author.id,
    });
    expect(new Set(authorIds)).toEqual(
      new Set([orgApp.id, personalApp.id, teamApp.id]),
    );

    const memberIds = await AppTeamModel.getUserAccessibleAppIds({
      organizationId: org.id,
      userId: member.id,
    });
    expect(new Set(memberIds)).toEqual(new Set([orgApp.id, teamApp.id]));

    const outsiderIds = await AppTeamModel.getUserAccessibleAppIds({
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
      await AppTeamModel.userHasAppAccess({
        organizationId: org.id,
        userId: author.id,
        app: personalApp,
        isAppAdmin: false,
      }),
    ).toBe(true);
    expect(
      await AppTeamModel.userHasAppAccess({
        organizationId: org.id,
        userId: other.id,
        app: personalApp,
        isAppAdmin: false,
      }),
    ).toBe(false);
    expect(
      await AppTeamModel.userHasAppAccess({
        organizationId: org.id,
        userId: other.id,
        app: personalApp,
        isAppAdmin: true,
      }),
    ).toBe(true);
  });
});
