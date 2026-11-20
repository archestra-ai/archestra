// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type { ResourcePermissionAction } from "@archestra/shared";
import { vi } from "vitest";
import { PluginModel } from "@/models";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { createGithubPat } from "@/services/github-pat";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  authenticatedRouteApp,
  USER_HEADER,
} from "@/test/authenticated-route-app";
import { stubGithub } from "@/test/github-skills-stub";
import type { CreatePlugin, User } from "@/types";
import pluginRoutes from "./plugin.routes";

/**
 * Who may do what with a plugin, through the real authentication middleware:
 * creating one is the `plugin:create` role action, and everything else is a
 * grant on the plugin itself. Its author starts with full access.
 */
describe("plugin permissions", () => {
  let app: Awaited<ReturnType<typeof authenticatedRouteApp>>;
  let organizationId: string;

  beforeEach(async ({ makeOrganization }) => {
    organizationId = (await makeOrganization()).id;
    app = await authenticatedRouteApp({
      organizationId,
      routes: [pluginRoutes],
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  const as = (
    user: User,
    request: {
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      url: string;
    } & {
      payload?: object;
    },
  ) => app.inject({ ...request, headers: { [USER_HEADER]: user.id } });

  const create = (user: User, payload: Partial<CreatePlugin> = {}) =>
    as(user, {
      method: "POST",
      url: "/api/plugins",
      payload: { ...createPayload(), ...payload },
    });

  test("a Plugin Writer manages their own plugins and cannot reach a colleague's private one", async ({
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const writerRole = await makeCustomRole(organizationId, {
      permission: { plugin: ["read", "create", "update", "delete"] },
    });
    const writer = await makeUser();
    const colleague = await makeUser();
    for (const user of [writer, colleague])
      await makeMember(user.id, organizationId, {
        role: writerRole.role,
      });

    const mine = await create(writer, { displayName: "Mine" });
    expect(mine.statusCode, mine.body).toBe(200);
    const theirs = await create(colleague, { displayName: "Theirs" });
    expect(theirs.statusCode, theirs.body).toBe(200);
    const mineUrl = `/api/plugins/${mine.json().id}`;
    const theirsUrl = `/api/plugins/${theirs.json().id}`;

    const list = await as(writer, { method: "GET", url: "/api/plugins" });
    expect(list.statusCode).toBe(200);
    expect(list.json().map((plugin: { id: string }) => plugin.id)).toEqual([
      mine.json().id,
    ]);
    expect((await as(writer, { method: "GET", url: mineUrl })).statusCode).toBe(
      200,
    );
    const renamed = await as(writer, {
      method: "PUT",
      url: mineUrl,
      payload: { displayName: "Mine, renamed" },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);

    // The colleague's plugin reads as absent, so its existence stays private.
    for (const request of [
      { method: "GET", url: theirsUrl },
      { method: "PUT", url: theirsUrl, payload: { displayName: "Taken" } },
      { method: "DELETE", url: theirsUrl },
    ] as const) {
      expect((await as(writer, request)).statusCode).toBe(404);
    }
    expect(
      await PluginModel.findById({ id: theirs.json().id, organizationId }),
    ).toMatchObject({ displayName: "Theirs" });

    expect(
      (await as(writer, { method: "DELETE", url: mineUrl })).statusCode,
    ).toBe(200);
  });

  test("plugin:create alone creates a plugin its author then reads, edits and deletes; without it creating is refused", async ({
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const creatorRole = await makeCustomRole(organizationId, {
      permission: { plugin: ["create"] },
    });
    const creator = await makeUser();
    await makeMember(creator.id, organizationId, { role: creatorRole.role });
    const member = await makeUser();
    await makeMember(member.id, organizationId);

    expect((await create(member)).statusCode).toBe(403);
    expect(
      (
        await as(member, {
          method: "POST",
          url: "/api/plugins/github/preview",
          payload: { repoUrl: "trusted/example" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await as(member, { method: "GET", url: "/api/plugins" })).statusCode,
    ).toBe(403);

    const created = await create(creator);
    expect(created.statusCode, created.body).toBe(200);
    const url = `/api/plugins/${created.json().id}`;
    const list = await as(creator, { method: "GET", url: "/api/plugins" });
    expect(list.json().map((plugin: { id: string }) => plugin.id)).toEqual([
      created.json().id,
    ]);
    expect((await as(creator, { method: "GET", url })).statusCode).toBe(200);
    expect(
      (
        await as(creator, {
          method: "PUT",
          url,
          payload: { displayName: "Renamed by its author" },
        })
      ).statusCode,
    ).toBe(200);
    expect((await as(member, { method: "GET", url })).statusCode).toBe(404);
    expect((await as(creator, { method: "DELETE", url })).statusCode).toBe(200);
  });

  test("sharing a new plugin with the whole organization takes Full access to every plugin", async ({
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const writerRole = await makeCustomRole(organizationId, {
      permission: { plugin: ["read", "create", "update", "delete"] },
    });
    const writer = await makeUser();
    await makeMember(writer.id, organizationId, {
      role: writerRole.role,
    });
    const admin = await makeUser();
    await makeMember(admin.id, organizationId, { role: "admin" });
    const initialGrants = [
      {
        subject: { type: "organization" as const, id: "*" as const },
        actions: ["read", "use"] as ResourcePermissionAction[],
      },
    ];

    const refused = await create(writer, { initialGrants });
    expect(refused.statusCode).toBe(403);
    expect(
      await PluginModel.findByOrganization({ organizationId }),
    ).toHaveLength(0);
    expect((await create(admin, { initialGrants })).statusCode).toBe(200);
  });

  test("a grant on one plugin decides what its holder may do with it", async ({
    makeUser,
    makeMember,
  }) => {
    const [author, viewer, user, editor, stranger] = await Promise.all(
      Array.from({ length: 5 }, () => makeUser()),
    );
    for (const person of [author, viewer, user, editor, stranger])
      await makeMember(person.id, organizationId);
    const grant = (who: User, actions: ResourcePermissionAction[]) => ({
      subject: { type: "user" as const, id: who.id },
      actions,
    });
    const plugin = await PluginModel.create({
      organizationId,
      userId: author.id,
      input: createPayload(),
      initialPermissionGrants: [
        grant(viewer, ["read"]),
        grant(user, ["read", "use"]),
        grant(editor, ["read", "use", "update"]),
      ],
    });
    if (!plugin) throw new Error("Missing plugin");
    const url = `/api/plugins/${plugin.id}`;
    const rename = (who: User) =>
      as(who, { method: "PUT", url, payload: { displayName: who.id } });

    for (const reader of [viewer, user, editor]) {
      expect((await as(reader, { method: "GET", url })).statusCode).toBe(200);
      const list = await as(reader, { method: "GET", url: "/api/plugins" });
      expect(list.json().map((row: { id: string }) => row.id)).toEqual([
        plugin.id,
      ]);
    }
    expect(
      (await as(viewer, { method: "GET", url: "/api/plugins/labels/keys" }))
        .statusCode,
    ).toBe(200);
    expect(
      (await as(viewer, { method: "GET", url: "/api/plugins/labels/values" }))
        .statusCode,
    ).toBe(200);
    expect(
      (await as(stranger, { method: "GET", url: "/api/plugins/labels/keys" }))
        .statusCode,
    ).toBe(403);
    expect((await rename(viewer)).statusCode).toBe(403);
    expect((await rename(user)).statusCode).toBe(403);
    expect((await rename(editor)).statusCode).toBe(200);
    expect((await as(editor, { method: "DELETE", url })).statusCode).toBe(403);
    expect((await as(stranger, { method: "GET", url })).statusCode).toBe(404);
    expect((await rename(stranger)).statusCode).toBe(404);
  });

  test("plugin label keys and values only include labels from readable plugins", async ({
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const readerRole = await makeCustomRole(organizationId, {
      permission: { plugin: ["read"] },
    });
    const [author, viewer, readerWithNoGrants] = await Promise.all([
      makeUser(),
      makeUser(),
      makeUser(),
    ]);
    await makeMember(author.id, organizationId, { role: "admin" });
    await makeMember(viewer.id, organizationId);
    await makeMember(readerWithNoGrants.id, organizationId, {
      role: readerRole.role,
    });

    await PluginModel.create({
      organizationId,
      userId: author.id,
      input: {
        ...createPayload(),
        displayName: "Private labeled plugin",
        labels: [{ key: "secret", value: "classified" }],
      },
    });
    await PluginModel.create({
      organizationId,
      userId: author.id,
      input: {
        ...createPayload(),
        displayName: "Shared labeled plugin",
        labels: [{ key: "env", value: "shared" }],
      },
      initialPermissionGrants: [
        { subject: { type: "user", id: viewer.id }, actions: ["read"] },
      ],
    });

    const viewerKeys = await as(viewer, {
      method: "GET",
      url: "/api/plugins/labels/keys",
    });
    expect(viewerKeys.statusCode).toBe(200);
    expect(viewerKeys.json()).toEqual(["env"]);

    const viewerValues = await as(viewer, {
      method: "GET",
      url: "/api/plugins/labels/values",
    });
    expect(viewerValues.statusCode).toBe(200);
    expect(viewerValues.json()).toEqual(["shared"]);

    const viewerSecretValues = await as(viewer, {
      method: "GET",
      url: "/api/plugins/labels/values?key=secret",
    });
    expect(viewerSecretValues.statusCode).toBe(200);
    expect(viewerSecretValues.json()).toEqual([]);

    const viewerEnvValues = await as(viewer, {
      method: "GET",
      url: "/api/plugins/labels/values?key=env",
    });
    expect(viewerEnvValues.statusCode).toBe(200);
    expect(viewerEnvValues.json()).toEqual(["shared"]);

    const emptyReaderKeys = await as(readerWithNoGrants, {
      method: "GET",
      url: "/api/plugins/labels/keys",
    });
    expect(emptyReaderKeys.statusCode).toBe(200);
    expect(emptyReaderKeys.json()).toEqual([]);

    const adminKeys = await as(author, {
      method: "GET",
      url: "/api/plugins/labels/keys",
    });
    expect(adminKeys.statusCode).toBe(200);
    expect(adminKeys.json()).toEqual(["env", "secret"]);
  });

  test("a Can edit grantee cannot repoint or fetch through a stored Git credential without use access on it", async ({
    makeUser,
    makeMember,
  }) => {
    const [admin, editor] = await Promise.all([makeUser(), makeUser()]);
    await makeMember(admin.id, organizationId, { role: "admin" });
    // Default members hold credential:read; that alone must not unlock org PATs.
    await makeMember(editor.id, organizationId);

    const orgPat = await createGithubPat({
      organizationId,
      userId: admin.id,
      data: { name: "Org private PAT", token: "ghp_org_secret" },
    });
    // Restrict the credential to admin only (removing default org-wide use).
    const patPolicy = await ResourcePermissionPolicyModel.find({
      organizationId,
      resource: "credential",
      scope: orgPat.id,
    });
    await ResourcePermissionPolicyModel.replace({
      organizationId,
      resource: "credential",
      scope: orgPat.id,
      revision: patPolicy?.revision ?? 0,
      grants: [
        {
          subject: { type: "user", id: admin.id },
          actions: ["read", "use", "update", "delete", "manage-permissions"],
        },
      ],
    });
    const plugin = await PluginModel.create({
      organizationId,
      userId: admin.id,
      input: createPayload(),
      source: {
        repo: "acme/plugins",
        ref: "main",
        sha: "approved-commit",
        subdir: "",
        exclude: [],
        syncInterval: "1d",
        syncRef: "main",
        githubPatId: orgPat.id,
      },
      initialPermissionGrants: [
        {
          subject: { type: "user", id: editor.id },
          actions: ["read", "use", "update"],
        },
      ],
    });
    if (!plugin) throw new Error("Missing Git-backed plugin");

    // Metadata-only edits stay allowed without touching the Git credential.
    expect(
      (
        await as(editor, {
          method: "PUT",
          url: `/api/plugins/${plugin.id}`,
          payload: { displayName: "Renamed by editor" },
        })
      ).statusCode,
    ).toBe(200);

    // Repointing githubSource while omitting authentication would retain orgPat.
    const repointWithoutAuth = await as(editor, {
      method: "PUT",
      url: `/api/plugins/${plugin.id}`,
      payload: {
        githubSource: {
          repoUrl: "acme/secret-infra",
          ref: "main",
          syncInterval: "1d",
        },
      },
    });
    expect(repointWithoutAuth.statusCode).toBe(403);

    // Explicitly referencing orgPat is also rejected without a use grant on it.
    const repointWithOrgPat = await as(editor, {
      method: "PUT",
      url: `/api/plugins/${plugin.id}`,
      payload: {
        githubSource: {
          repoUrl: "acme/secret-infra",
          ref: "main",
          syncInterval: "1d",
          authentication: {
            githubAppConfigId: null,
            githubPatId: orgPat.id,
          },
        },
      },
    });
    expect(repointWithOrgPat.statusCode).toBe(403);

    // Source remains untouched.
    expect(
      (
        await PluginModel.findById({
          id: plugin.id,
          organizationId,
        })
      )?.sourceRepo,
    ).toBe("acme/plugins");

    // Preview, manual check, and scheduled sync cannot use the stored PAT either.
    const fetchMock = stubGithub([
      {
        owner: "acme",
        repo: "plugins",
        files: { "hooks/hooks.json": "{}\n" },
      },
      {
        owner: "acme",
        repo: "secret-infra",
        files: { "hooks/hooks.json": '{"secret":true}\n' },
      },
    ]);
    expect(
      (
        await as(editor, {
          method: "POST",
          url: `/api/plugins/${plugin.id}/github/preview-update`,
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await as(editor, {
          method: "POST",
          url: `/api/plugins/${plugin.id}/github/check`,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await as(editor, {
          method: "PATCH",
          url: `/api/plugins/${plugin.id}/github/sync`,
          payload: { interval: "1h" },
        })
      ).statusCode,
    ).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();

    // Granting `use` on the credential authorizes previewing and repointing with it.
    await ResourcePermissionPolicyModel.addSubjectGrant({
      organizationId,
      resource: "credential",
      scope: orgPat.id,
      subject: { type: "user", id: editor.id },
      actions: ["read", "use"],
    });
    expect(
      (
        await as(editor, {
          method: "POST",
          url: `/api/plugins/${plugin.id}/github/preview-update`,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);

    // Explicitly clearing authentication lets an editor without credential use switch to public.
    const editorWithoutCred = await makeUser();
    await makeMember(editorWithoutCred.id, organizationId);
    await ResourcePermissionPolicyModel.addSubjectGrant({
      organizationId,
      resource: "plugin",
      scope: plugin.id,
      subject: { type: "user", id: editorWithoutCred.id },
      actions: ["read", "use", "update"],
    });
    const clearedToPublic = await as(editorWithoutCred, {
      method: "PUT",
      url: `/api/plugins/${plugin.id}`,
      payload: {
        githubSource: {
          repoUrl: "public-owner/public-plugin",
          ref: "main",
          syncInterval: "1d",
          authentication: {
            githubAppConfigId: null,
            githubPatId: null,
          },
        },
      },
    });
    expect(clearedToPublic.statusCode).toBe(200);
    expect(clearedToPublic.json()).toMatchObject({
      sourceRepo: "public-owner/public-plugin",
      githubPatId: null,
      githubAppConfigId: null,
    });
  });
});

function createPayload(): CreatePlugin {
  return {
    displayName: "Permission test plugin",
    description: "Executable plugin bytes",
    clientType: "claude-code",
    supportedPlatforms: ["posix"],
    files: [
      {
        path: "hooks/hooks.json",
        content: "{}\n",
        encoding: "utf8",
        mode: "100644",
      },
    ],
  };
}
