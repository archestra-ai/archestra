import { ADMIN_ROLE_NAME } from "@archestra/shared";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

// Lock/unlock lifecycle + what the lock refuses over REST: a locked app keeps
// its content (PATCH with html is refused) and its existence (DELETE is
// refused) until unlocked, while settings-level metadata edits stay available.
// The chat-side total refusal lives in the archestra-mcp-server loadApp gate
// and is covered by apps.test.ts.
describe("POST /api/apps/:appId/(lock|unlock)", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let author: User;
  // The request principal, swapped between injects to act as different users.
  let currentUser: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    author = await makeUser();
    await makeMember(author.id, organizationId, { role: ADMIN_ROLE_NAME });
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

  test("a new app is created unlocked", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/apps",
      payload: { name: "Fresh", scope: "org" },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().locked).toBe(false);
  });

  test("lock and unlock round-trip through their endpoints", async ({
    makeApp,
  }) => {
    const target = await makeApp({
      organizationId,
      scope: "org",
      authorId: author.id,
    });

    const locked = await app.inject({
      method: "POST",
      url: `/api/apps/${target.id}/lock`,
    });
    expect(locked.statusCode).toBe(200);
    expect(locked.json().locked).toBe(true);

    const unlocked = await app.inject({
      method: "POST",
      url: `/api/apps/${target.id}/unlock`,
    });
    expect(unlocked.statusCode).toBe(200);
    expect(unlocked.json().locked).toBe(false);
  });

  test("a locked app refuses html replacement but still accepts metadata edits", async ({
    makeApp,
  }) => {
    const target = await makeApp({
      organizationId,
      scope: "org",
      authorId: author.id,
      locked: true,
    });

    const htmlEdit = await app.inject({
      method: "PATCH",
      url: `/api/apps/${target.id}`,
      payload: { html: "<!doctype html><title>overwrite</title>" },
    });
    expect(htmlEdit.statusCode).toBe(409);
    expect(htmlEdit.json().error.message).toContain("locked");

    const rename = await app.inject({
      method: "PATCH",
      url: `/api/apps/${target.id}`,
      payload: { name: "Renamed while locked" },
    });
    expect(rename.statusCode).toBe(200);
    expect(rename.json().name).toBe("Renamed while locked");
  });

  test("a locked app cannot be deleted until unlocked", async ({ makeApp }) => {
    const target = await makeApp({
      organizationId,
      scope: "org",
      authorId: author.id,
      locked: true,
    });

    const refused = await app.inject({
      method: "DELETE",
      url: `/api/apps/${target.id}`,
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toContain("locked");

    await app.inject({ method: "POST", url: `/api/apps/${target.id}/unlock` });
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/apps/${target.id}`,
    });
    expect(deleted.statusCode).toBe(200);
  });

  test("a viewer without modify rights cannot lock or unlock", async ({
    makeApp,
    makeUser,
    makeMember,
  }) => {
    const target = await makeApp({
      organizationId,
      scope: "org",
      authorId: author.id,
    });
    const member = await makeUser();
    await makeMember(member.id, organizationId, { role: "member" });

    currentUser = member;
    // Visible (org scope), so these are real 403s from the modify-rights gate.
    expect(
      (await app.inject({ method: "GET", url: `/api/apps/${target.id}` }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/apps/${target.id}/lock`,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/apps/${target.id}/unlock`,
        })
      ).statusCode,
    ).toBe(403);
  });

  test("the apps listing carries the locked flag", async ({ makeApp }) => {
    const target = await makeApp({
      organizationId,
      scope: "org",
      authorId: author.id,
      locked: true,
    });

    const list = await app.inject({ method: "GET", url: "/api/apps" });
    const item = (
      list.json().data as Array<{ id: string; locked: boolean }>
    ).find((a) => a.id === target.id);
    expect(item?.locked).toBe(true);
  });
});
