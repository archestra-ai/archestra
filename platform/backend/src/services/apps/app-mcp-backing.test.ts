import { AppModel, InternalMcpCatalogModel, McpServerModel } from "@/models";
import { describe, expect, mustExist, test } from "@/test";
import { purgePersonalAppsForUser } from "./app-mcp-backing";

describe("purgePersonalAppsForUser", () => {
  test("deletes a personal app with its backing catalog and launch tool, scoped to the organization", async ({
    makeApp,
    makeOrganization,
    makeUser,
  }) => {
    const user = await makeUser();
    const orgA = await makeOrganization();
    const orgB = await makeOrganization();
    const appInA = await makeApp({
      scope: "personal",
      authorId: user.id,
      organizationId: orgA.id,
    });
    const appInB = await makeApp({
      scope: "personal",
      authorId: user.id,
      organizationId: orgB.id,
    });
    const backingServerId = mustExist(appInA.mcpServerId);
    const backingCatalogId = mustExist(
      (await McpServerModel.findById(backingServerId))?.catalogId,
    );

    const purged = await purgePersonalAppsForUser({
      userId: user.id,
      organizationId: orgA.id,
    });

    expect(purged).toEqual([appInA.id]);
    // The canonical deletion pair ran: app soft-deleted, backing server and
    // catalog (with its launch tool) soft-deleted with it.
    expect(await AppModel.findById(appInA.id)).toBeNull();
    expect(await McpServerModel.findById(backingServerId)).toBeNull();
    expect(await InternalMcpCatalogModel.findById(backingCatalogId)).toBeNull();
    // The other organization's app is untouched.
    expect(await AppModel.findById(appInB.id)).not.toBeNull();
  });

  test("spans every organization when none is given, and leaves shared apps alone", async ({
    makeApp,
    makeOrganization,
    makeUser,
  }) => {
    const user = await makeUser();
    const orgA = await makeOrganization();
    const orgB = await makeOrganization();
    const personalA = await makeApp({
      scope: "personal",
      authorId: user.id,
      organizationId: orgA.id,
    });
    const personalB = await makeApp({
      scope: "personal",
      authorId: user.id,
      organizationId: orgB.id,
    });
    // Org-scoped apps outlive their author, like org-scoped installs.
    const shared = await makeApp({
      scope: "org",
      authorId: user.id,
      organizationId: orgA.id,
    });

    const purged = await purgePersonalAppsForUser({ userId: user.id });

    expect(purged.sort()).toEqual([personalA.id, personalB.id].sort());
    expect(await AppModel.findById(personalA.id)).toBeNull();
    expect(await AppModel.findById(personalB.id)).toBeNull();
    expect(await AppModel.findById(shared.id)).not.toBeNull();
  });
});
