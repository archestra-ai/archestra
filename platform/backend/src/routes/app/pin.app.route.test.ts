import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { AppModel, AppPinModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("PUT/DELETE /api/apps pin routes", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;
  let actingUser: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
    actingUser = user;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
      (request as typeof request & { user: User }).user = actingUser;
    });
    const { default: appRoutes } = await import("./app.routes");
    await app.register(appRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  async function listItems() {
    const res = await app.inject({
      method: "GET",
      url: "/api/apps?limit=100&offset=0",
    });
    expect(res.statusCode).toBe(200);
    return res.json().data as Array<Record<string, unknown>>;
  }

  test("owned app: pin and unpin; pinnedAt surfaces in GET /api/apps", async ({
    makeApp,
  }) => {
    const owned = await makeApp({
      organizationId,
      scope: "org",
      authorId: user.id,
      name: "Pinnable",
    });

    const pin = await app.inject({
      method: "PUT",
      url: `/api/apps/${owned.id}/pin`,
    });
    expect(pin.statusCode).toBe(200);
    let item = (await listItems()).find((i) => i.id === owned.id);
    expect(typeof item?.pinnedAt).toBe("string");

    const unpin = await app.inject({
      method: "DELETE",
      url: `/api/apps/${owned.id}/pin`,
    });
    expect(unpin.statusCode).toBe(200);
    item = (await listItems()).find((i) => i.id === owned.id);
    expect(item?.pinnedAt).toBeNull();
  });

  test("external app: pin and unpin by (install, resource); pinnedAt surfaces in the listing", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Archestra PM",
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
      scope: "org",
    });
    const server = await makeMcpServer({ catalogId: catalog.id, scope: "org" });
    await makeTool({
      catalogId: catalog.id,
      name: "show_board",
      meta: { _meta: { ui: { resourceUri: "ui://pm/board.html" } } },
    });

    const pin = await app.inject({
      method: "PUT",
      url: `/api/apps/external/${server.id}/pin`,
      payload: { resourceUri: "ui://pm/board.html" },
    });
    expect(pin.statusCode).toBe(200);
    let item = (await listItems()).find(
      (i) => i.source === "external" && i.mcpServerId === server.id,
    );
    expect(typeof item?.pinnedAt).toBe("string");

    const unpin = await app.inject({
      method: "DELETE",
      url: `/api/apps/external/${server.id}/pin?resourceUri=${encodeURIComponent("ui://pm/board.html")}`,
    });
    expect(unpin.statusCode).toBe(200);
    item = (await listItems()).find(
      (i) => i.source === "external" && i.mcpServerId === server.id,
    );
    expect(item?.pinnedAt).toBeNull();
  });

  // Every /api/ route must be registered in requiredEndpointPermissionsMap or
  // the auth middleware 403s it for everyone (deny-by-default). A missing
  // registration is invisible from this file's bare fastify instance (routes
  // are registered without the auth plugin), so assert on the map directly,
  // like the knowledge-base route tests do. app:read matches project pins'
  // project:read — any member-level viewer may pin; per-instance visibility is
  // gated in the handlers.
  test("pin routes are registered in the endpoint permissions map for members", async () => {
    const { requiredEndpointPermissionsMap } = await import(
      "@archestra/shared/access-control"
    );
    const { RouteId } = await import("@archestra/shared");

    expect(requiredEndpointPermissionsMap[RouteId.PinApp]).toEqual({
      app: ["read"],
    });
    expect(requiredEndpointPermissionsMap[RouteId.UnpinApp]).toEqual({
      app: ["read"],
    });
    expect(requiredEndpointPermissionsMap[RouteId.PinExternalApp]).toEqual({
      app: ["read"],
    });
    expect(requiredEndpointPermissionsMap[RouteId.UnpinExternalApp]).toEqual({
      app: ["read"],
    });
  });

  test("a plain (non-admin) member can pin an org-visible app; pins are per-user", async ({
    makeUser,
    makeMember,
    makeApp,
  }) => {
    const member = await makeUser({ email: "app-pin-plain-member@test.com" });
    await makeMember(member.id, organizationId, {});
    const owned = await makeApp({
      organizationId,
      scope: "org",
      authorId: user.id,
      name: "Org Shared",
    });

    actingUser = member;
    const pin = await app.inject({
      method: "PUT",
      url: `/api/apps/${owned.id}/pin`,
    });
    expect(pin.statusCode).toBe(200);

    // Pinned for the member…
    const item = (await listItems()).find((i) => i.id === owned.id);
    expect(typeof item?.pinnedAt).toBe("string");

    // …but not for the author (pins are personal, like project pins).
    actingUser = user;
    const authorItem = (await listItems()).find((i) => i.id === owned.id);
    expect(authorItem?.pinnedAt).toBeNull();
  });

  test("pinning an owned app you cannot view returns 404", async ({
    makeUser,
    makeMember,
    makeApp,
  }) => {
    const otherAuthor = await makeUser({ email: "app-pin-author@test.com" });
    const foreignPersonal = await makeApp({
      organizationId,
      scope: "personal",
      authorId: otherAuthor.id,
    });
    const stranger = await makeUser({ email: "app-pin-stranger@test.com" });
    await makeMember(stranger.id, organizationId, {});
    actingUser = stranger;

    const res = await app.inject({
      method: "PUT",
      url: `/api/apps/${foreignPersonal.id}/pin`,
    });
    expect(res.statusCode).toBe(404);
  });

  test("pinning an external app on an inaccessible install returns 404", async ({
    makeUser,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
  }) => {
    const otherUser = await makeUser({ email: "app-pin-owner@test.com" });
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Private PM",
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
      scope: "personal",
      authorId: otherUser.id,
    });
    const server = await makeMcpServer({
      catalogId: catalog.id,
      scope: "personal",
      ownerId: otherUser.id,
    });
    await makeTool({
      catalogId: catalog.id,
      name: "show_board",
      meta: { _meta: { ui: { resourceUri: "ui://pm/board.html" } } },
    });

    const res = await app.inject({
      method: "PUT",
      url: `/api/apps/external/${server.id}/pin`,
      payload: { resourceUri: "ui://pm/board.html" },
    });
    expect(res.statusCode).toBe(404);
  });

  test("can unpin after the app is deleted (no 404, pin removed)", async ({
    makeApp,
  }) => {
    const owned = await makeApp({
      organizationId,
      scope: "org",
      authorId: user.id,
    });
    await app.inject({ method: "PUT", url: `/api/apps/${owned.id}/pin` });

    // Soft-delete drops the app from listings; the stale pin must still clear.
    await AppModel.delete(owned.id);

    const unpin = await app.inject({
      method: "DELETE",
      url: `/api/apps/${owned.id}/pin`,
    });
    expect(unpin.statusCode).toBe(200);
    const pins = await AppPinModel.getPinnedAtForApps({
      userId: user.id,
      appIds: [owned.id],
    });
    expect(pins.has(owned.id)).toBe(false);
  });
});
