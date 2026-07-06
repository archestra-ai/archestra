import { AppModel, AppPinModel, McpServerModel } from "@/models";
import { describe, expect, test } from "@/test";

describe("AppPinModel", () => {
  test("owned pin then unpin round-trip, idempotent", async ({
    makeUser,
    makeOrganization,
    makeApp,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const app = await makeApp({ organizationId: org.id, authorId: user.id });

    await AppPinModel.pinOwned({ userId: user.id, appId: app.id });
    let pins = await AppPinModel.getPinnedAtForApps({
      userId: user.id,
      appIds: [app.id],
    });
    expect(pins.get(app.id)).toBeInstanceOf(Date);

    // re-pin does not throw and keeps a single row
    await AppPinModel.pinOwned({ userId: user.id, appId: app.id });

    await AppPinModel.unpinOwned({ userId: user.id, appId: app.id });
    pins = await AppPinModel.getPinnedAtForApps({
      userId: user.id,
      appIds: [app.id],
    });
    expect(pins.has(app.id)).toBe(false);

    // unpin again is a no-op
    await AppPinModel.unpinOwned({ userId: user.id, appId: app.id });
  });

  test("external pin round-trip keyed by (install, resource)", async ({
    makeUser,
    makeMcpServer,
  }) => {
    const user = await makeUser();
    const server = await makeMcpServer();
    const ref = {
      mcpServerId: server.id,
      resourceUri: "ui://pm/board.html",
    };

    await AppPinModel.pinExternal({ userId: user.id, ...ref });
    // re-pin is idempotent
    await AppPinModel.pinExternal({ userId: user.id, ...ref });

    const key = AppPinModel.externalPinKey(ref);
    let pins = await AppPinModel.getPinnedAtForExternalApps({
      userId: user.id,
      refs: [ref],
    });
    expect(pins.get(key)).toBeInstanceOf(Date);

    // a different resource of the same install is a distinct pin
    const otherRef = { mcpServerId: server.id, resourceUri: "ui://pm/x.html" };
    pins = await AppPinModel.getPinnedAtForExternalApps({
      userId: user.id,
      refs: [otherRef],
    });
    expect(pins.size).toBe(0);

    await AppPinModel.unpinExternal({ userId: user.id, ...ref });
    pins = await AppPinModel.getPinnedAtForExternalApps({
      userId: user.id,
      refs: [ref],
    });
    expect(pins.has(key)).toBe(false);
  });

  test("pins are per-user (one user's pin is invisible to another)", async ({
    makeUser,
    makeOrganization,
    makeApp,
  }) => {
    const org = await makeOrganization();
    const a = await makeUser();
    const b = await makeUser({ email: "app-pin-b@test.com" });
    const app = await makeApp({ organizationId: org.id, authorId: a.id });

    await AppPinModel.pinOwned({ userId: a.id, appId: app.id });

    const aPins = await AppPinModel.getPinnedAtForApps({
      userId: a.id,
      appIds: [app.id],
    });
    const bPins = await AppPinModel.getPinnedAtForApps({
      userId: b.id,
      appIds: [app.id],
    });
    expect(aPins.has(app.id)).toBe(true);
    expect(bPins.has(app.id)).toBe(false);
  });

  test("hard-deleting an app cascade-removes its pins", async ({
    makeUser,
    makeOrganization,
    makeApp,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const app = await makeApp({ organizationId: org.id, authorId: user.id });
    await AppPinModel.pinOwned({ userId: user.id, appId: app.id });

    await AppModel.purge(app.id);

    const pins = await AppPinModel.getPinnedAtForApps({
      userId: user.id,
      appIds: [app.id],
    });
    expect(pins.has(app.id)).toBe(false);
  });

  test("deleting an MCP server cascade-removes its external pins", async ({
    makeUser,
    makeMcpServer,
  }) => {
    const user = await makeUser();
    const server = await makeMcpServer();
    const ref = { mcpServerId: server.id, resourceUri: "ui://pm/board.html" };
    await AppPinModel.pinExternal({ userId: user.id, ...ref });

    await McpServerModel.delete(server.id);

    const pins = await AppPinModel.getPinnedAtForExternalApps({
      userId: user.id,
      refs: [ref],
    });
    expect(pins.has(AppPinModel.externalPinKey(ref))).toBe(false);
  });
});
