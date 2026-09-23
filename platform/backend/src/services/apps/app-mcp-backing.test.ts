import { AppModel, InternalMcpCatalogModel, McpServerModel } from "@/models";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { ResourcePermissions } from "@/services/resource-permissions";
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

describe("app backing install scope", () => {
  test("follows the app's grants, and re-syncs when the app's permissions are edited", async ({
    makeApp,
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const author = await makeUser();
    await makeMember(author.id, org.id, { role: "member" });
    const team = await makeTeam(org.id, author.id);
    const app = await makeApp({
      scope: "personal",
      authorId: author.id,
      organizationId: org.id,
    });
    const serverId = mustExist(app.mcpServerId);
    const installScope = async () =>
      (await McpServerModel.findById(serverId))?.scope;
    const key = {
      organizationId: org.id,
      resource: "app" as const,
      scope: app.id,
    };
    const authorGrant = {
      subject: { type: "user" as const, id: author.id },
      actions: [
        "delete" as const,
        "manage-permissions" as const,
        "read" as const,
        "update" as const,
        "use" as const,
      ],
    };
    const edit = async (
      grants: Parameters<typeof ResourcePermissions.updatePolicy>[0]["grants"],
    ) =>
      ResourcePermissions.updatePolicy({
        ...key,
        userId: author.id,
        revision:
          (await ResourcePermissionPolicyModel.find(key))?.revision ?? 0,
        grants,
      });

    // Only the author: per-user installs.
    expect(await installScope()).toBe("personal");

    // Reaching the whole organization: one shared install.
    await edit([
      authorGrant,
      {
        subject: { type: "organization", id: "*" },
        actions: ["read", "use"],
      },
    ]);
    expect(await installScope()).toBe("org");

    // A team is narrower than the organization: back to per-user installs.
    await edit([
      authorGrant,
      { subject: { type: "team", id: team.id }, actions: ["read", "use"] },
    ]);
    expect(await installScope()).toBe("personal");

    // A role reaches everyone holding it: shared again.
    await edit([
      authorGrant,
      { subject: { type: "role", id: "member" }, actions: ["read", "use"] },
    ]);
    expect(await installScope()).toBe("org");
  });

  test("a new app's install takes its scope from the grants written with it", async ({
    makeApp,
    makeOrganization,
    makeUser,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const author = await makeUser();
    const team = await makeTeam(org.id, author.id);
    const orgApp = await makeApp({ scope: "org", organizationId: org.id });
    const teamApp = await makeApp({
      scope: "team",
      teamIds: [team.id],
      authorId: author.id,
      organizationId: org.id,
    });
    expect(
      (await McpServerModel.findById(mustExist(orgApp.mcpServerId)))?.scope,
    ).toBe("org");
    const teamServer = await McpServerModel.findById(
      mustExist(teamApp.mcpServerId),
    );
    expect(teamServer?.scope).toBe("personal");
    expect(teamServer?.teamId).toBeNull();
  });
});
