import { ADMIN_ROLE_NAME, EDITOR_ROLE_NAME } from "@archestra/shared";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import { PluginModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import pluginRoutes from "./plugin.routes";

const file = (path: string, content: string) => ({
  path,
  content,
  encoding: "utf8" as const,
  mode: "100644" as const,
});

describe("a plugin's version history", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeAdmin, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeAdmin();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    await app.register(pluginRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  const create = async (files = [file("README.md", "one")]) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/plugins",
      payload: {
        displayName: "Versioned",
        description: "A plugin with a history.",
        clientType: "claude-code",
        supportedPlatforms: ["posix"],
        files,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as { id: string };
  };
  const save = (id: string, payload: Record<string, unknown>) =>
    app.inject({ method: "PUT", url: `/api/plugins/${id}`, payload });
  const versions = async (id: string, query = "") => {
    const response = await app.inject({
      method: "GET",
      url: `/api/plugins/${id}/versions${query}`,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as {
      data: Array<{ version: number; contentHash: string }>;
      pagination: { total: number };
    };
  };
  const version = (id: string, number: number) =>
    app.inject({
      method: "GET",
      url: `/api/plugins/${id}/versions/${number}`,
    });

  test("starts at version 1 with the files the plugin was created with", async () => {
    const plugin = await create([
      file("README.md", "one"),
      file("hooks/hooks.json", "{}"),
    ]);

    const history = await versions(plugin.id);
    expect(history.data.map((entry) => entry.version)).toEqual([1]);

    const first = await version(plugin.id, 1);
    expect(first.statusCode).toBe(200);
    expect(
      first
        .json()
        .files.map((entry: { path: string; content: string }) => [
          entry.path,
          entry.content,
        ]),
    ).toEqual([
      ["README.md", "one"],
      ["hooks/hooks.json", "{}"],
    ]);
  });

  test("adds a version for each save that changes the files, newest first, and keeps the older ones as they were", async () => {
    const plugin = await create();
    expect(
      (await save(plugin.id, { files: [file("README.md", "two")] })).statusCode,
    ).toBe(200);
    expect(
      (
        await save(plugin.id, {
          files: [file("README.md", "two"), file("run.sh", "echo hi")],
        })
      ).statusCode,
    ).toBe(200);

    const history = await versions(plugin.id);
    expect(history.data.map((entry) => entry.version)).toEqual([3, 2, 1]);
    expect(history.pagination.total).toBe(3);
    // Each version has its own content hash.
    expect(new Set(history.data.map((entry) => entry.contentHash)).size).toBe(
      3,
    );

    const contents = async (number: number) =>
      (await version(plugin.id, number))
        .json()
        .files.map((entry: { path: string; content: string }) => [
          entry.path,
          entry.content,
        ]);
    expect(await contents(1)).toEqual([["README.md", "one"]]);
    expect(await contents(2)).toEqual([["README.md", "two"]]);
    expect(await contents(3)).toEqual([
      ["README.md", "two"],
      ["run.sh", "echo hi"],
    ]);
  });

  test("adds no version for a save that leaves the files as they are", async () => {
    const plugin = await create();

    // A settings-only edit, and one that sends the same files again.
    expect(
      (await save(plugin.id, { description: "Renamed." })).statusCode,
    ).toBe(200);
    expect(
      (
        await save(plugin.id, {
          description: "Renamed again.",
          files: [file("README.md", "one")],
        })
      ).statusCode,
    ).toBe(200);

    expect((await versions(plugin.id)).data.map((v) => v.version)).toEqual([1]);
  });

  test("restoring an earlier version is a save of its files: a new version, with the history kept", async () => {
    const plugin = await create();
    await save(plugin.id, { files: [file("README.md", "two")] });
    const first = (await version(plugin.id, 1)).json();

    const restored = await save(plugin.id, {
      files: first.files.map(
        (entry: {
          path: string;
          content: string;
          encoding: string;
          mode: string;
        }) => ({
          path: entry.path,
          content: entry.content,
          encoding: entry.encoding,
          mode: entry.mode,
        }),
      ),
    });

    expect(restored.statusCode, restored.body).toBe(200);
    const history = await versions(plugin.id);
    expect(history.data.map((entry) => entry.version)).toEqual([3, 2, 1]);
    // The same files as version 1, so the same hash.
    expect(history.data[0].contentHash).toBe(history.data[2].contentHash);
  });

  test("refuses a save based on files that have changed since, and writes no version", async () => {
    const plugin = await create();
    const staleHash = (await versions(plugin.id)).data[0].contentHash;
    await save(plugin.id, { files: [file("README.md", "two")] });

    const stale = await save(plugin.id, {
      files: [file("README.md", "overwrites two")],
      baseContentHash: staleHash,
    });

    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.message).toContain("changed since");
    const history = await versions(plugin.id);
    expect(history.data.map((entry) => entry.version)).toEqual([2, 1]);

    // Based on the files as they are now, the same save goes through.
    const current = await save(plugin.id, {
      files: [file("README.md", "three")],
      baseContentHash: history.data[0].contentHash,
    });
    expect(current.statusCode, current.body).toBe(200);
  });

  test("moves a manual plugin to another client, leaving its files and history as they are", async () => {
    const plugin = await create();

    const moved = await save(plugin.id, { clientType: "cursor" });

    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json()).toMatchObject({
      clientType: "cursor",
      files: [expect.objectContaining({ path: "README.md", content: "one" })],
    });
    // The files did not change, so no version was added.
    expect((await versions(plugin.id)).data.map((v) => v.version)).toEqual([1]);
  });

  test("refuses a move to a client where the owner already has a plugin of that name", async () => {
    const plugin = await create();
    const twin = await app.inject({
      method: "POST",
      url: "/api/plugins",
      payload: {
        displayName: "Versioned",
        description: "The same name, for another client.",
        clientType: "cursor",
        supportedPlatforms: ["posix"],
        files: [file("README.md", "cursor")],
      },
    });
    expect(twin.statusCode, twin.body).toBe(200);

    const moved = await save(plugin.id, { clientType: "cursor" });

    expect(moved.statusCode).toBe(409);
    expect(moved.json().error.message).toContain(
      'You already have a plugin named "Versioned" for this client.',
    );
  });

  test("pages the history", async () => {
    const plugin = await create();
    await save(plugin.id, { files: [file("README.md", "two")] });
    await save(plugin.id, { files: [file("README.md", "three")] });

    const page = await versions(plugin.id, "?limit=2&offset=2");

    expect(page.data.map((entry) => entry.version)).toEqual([1]);
    expect(page.pagination.total).toBe(3);
  });

  test("keeps the history of a deleted plugin for its restore", async () => {
    const plugin = await create();
    await save(plugin.id, { files: [file("README.md", "two")] });
    await app.inject({ method: "DELETE", url: `/api/plugins/${plugin.id}` });
    await app.inject({
      method: "POST",
      url: `/api/plugins/${plugin.id}/restore`,
    });

    expect((await versions(plugin.id)).data.map((v) => v.version)).toEqual([
      2, 1,
    ]);
  });

  test("404 for a version the plugin does not have", async () => {
    const plugin = await create();

    expect((await version(plugin.id, 2)).statusCode).toBe(404);
  });

  test("is closed to someone who cannot read the plugin, and to another organization", async ({
    makeUser,
    makeMember,
    makeOrganization,
  }) => {
    const plugin = await create();
    const stranger = await makeUser();
    await makeMember(stranger.id, organizationId, { role: EDITOR_ROLE_NAME });
    user = stranger;

    const list = await app.inject({
      method: "GET",
      url: `/api/plugins/${plugin.id}/versions`,
    });
    expect(list.statusCode).toBe(404);
    expect((await version(plugin.id, 1)).statusCode).toBe(404);

    // The model fences by organization too, whatever the caller's grants.
    const elsewhere = (await makeOrganization()).id;
    expect(
      await PluginModel.findById({ id: plugin.id, organizationId: elsewhere }),
    ).toBeNull();
  });
});
