import { ADMIN_ROLE_NAME } from "@archestra/shared";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

// Enable/disable lifecycle + the disabled "author-only" access rule: a
// disabled app is visible to no one but its author, overriding app:admin
// oversight; enabling makes it live at its scope; disabling pulls it back.
describe("POST /api/apps/:appId/(enable|disable)", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let author: User;
  let otherAdmin: User;
  // The request principal, swapped between injects to act as different users.
  let currentUser: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    author = await makeUser();
    otherAdmin = await makeUser();
    // Both are app admins: the point is that admin oversight still does NOT
    // reveal another author's disabled app.
    await makeMember(author.id, organizationId, { role: ADMIN_ROLE_NAME });
    await makeMember(otherAdmin.id, organizationId, { role: ADMIN_ROLE_NAME });
    currentUser = author;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
      (request as typeof request & { user: User }).user = currentUser;
    });

    const { default: appRoutes } = await import("./app.routes");
    await app.register(appRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  const get = (appId: string) =>
    app.inject({ method: "GET", url: `/api/apps/${appId}` });

  test("a new app is created enabled", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/apps",
      payload: { name: "Fresh", scope: "org" },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().enabled).toBe(true);
  });

  test("a disabled org app is author-only, hidden even from another app admin", async ({
    makeApp,
  }) => {
    const disabled = await makeApp({
      organizationId,
      scope: "org",
      authorId: author.id,
      enabled: false,
    });

    currentUser = author;
    const asAuthor = await get(disabled.id);
    expect(asAuthor.statusCode).toBe(200);
    expect(asAuthor.json().enabled).toBe(false);

    currentUser = otherAdmin;
    expect((await get(disabled.id)).statusCode).toBe(404);
  });

  test("enabling makes a disabled app visible at its scope", async ({
    makeApp,
  }) => {
    const disabled = await makeApp({
      organizationId,
      scope: "org",
      authorId: author.id,
      enabled: false,
    });

    currentUser = author;
    const enabled = await app.inject({
      method: "POST",
      url: `/api/apps/${disabled.id}/enable`,
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().enabled).toBe(true);

    // The org-scoped app is now visible to another admin.
    currentUser = otherAdmin;
    expect((await get(disabled.id)).statusCode).toBe(200);
  });

  test("disabling returns a live app to author-only", async ({ makeApp }) => {
    const live = await makeApp({
      organizationId,
      scope: "org",
      authorId: author.id,
      enabled: true,
    });

    // Visible to another admin while live.
    currentUser = otherAdmin;
    expect((await get(live.id)).statusCode).toBe(200);

    currentUser = author;
    const disabled = await app.inject({
      method: "POST",
      url: `/api/apps/${live.id}/disable`,
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().enabled).toBe(false);

    // ...and hidden from the other admin again.
    currentUser = otherAdmin;
    expect((await get(live.id)).statusCode).toBe(404);
  });

  test("another admin cannot enable an author's disabled app (cannot even see it)", async ({
    makeApp,
  }) => {
    const disabled = await makeApp({
      organizationId,
      scope: "org",
      authorId: author.id,
      enabled: false,
    });

    currentUser = otherAdmin;
    const attempt = await app.inject({
      method: "POST",
      url: `/api/apps/${disabled.id}/enable`,
    });
    expect(attempt.statusCode).toBe(404);
  });

  test("a plain member who can view a live org app but lacks modify rights cannot enable/disable it", async ({
    makeApp,
    makeUser,
    makeMember,
  }) => {
    const live = await makeApp({
      organizationId,
      scope: "org",
      authorId: author.id,
      enabled: true,
    });
    const member = await makeUser();
    await makeMember(member.id, organizationId, { role: "member" });

    currentUser = member;
    // Visible (org scope), so this is a real 403 (modify-rights gate), not a
    // 404 from the disabled/view gate.
    expect((await get(live.id)).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/apps/${live.id}/disable`,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/apps/${live.id}/enable`,
        })
      ).statusCode,
    ).toBe(403);
  });

  test("a disabled app is excluded from another user's app listing", async ({
    makeApp,
  }) => {
    const disabled = await makeApp({
      organizationId,
      scope: "org",
      authorId: author.id,
      enabled: false,
    });

    currentUser = author;
    const authorList = await app.inject({ method: "GET", url: "/api/apps" });
    expect(
      (authorList.json().data as Array<{ id: string }>).map((a) => a.id),
    ).toContain(disabled.id);

    currentUser = otherAdmin;
    const otherList = await app.inject({ method: "GET", url: "/api/apps" });
    expect(
      (otherList.json().data as Array<{ id: string }>).map((a) => a.id),
    ).not.toContain(disabled.id);
  });
});
