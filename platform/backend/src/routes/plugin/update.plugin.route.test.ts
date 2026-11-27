import { ADMIN_ROLE_NAME } from "@archestra/shared";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import pluginRoutes from "./plugin.routes";

const file = (path: string, content: string) => ({
  path,
  content,
  encoding: "utf8" as const,
  mode: "100644" as const,
});

describe("PUT /api/plugins/:id", () => {
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

  const create = async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/plugins",
      payload: {
        displayName: "Saved twice",
        description: "A plugin two people edit.",
        clientType: "claude-code",
        supportedPlatforms: ["posix"],
        files: [file("README.md", "one")],
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as { id: string; contentHash: string };
  };
  const save = (id: string, payload: Record<string, unknown>) =>
    app.inject({ method: "PUT", url: `/api/plugins/${id}`, payload });
  const read = async (id: string) =>
    (await app.inject({ method: "GET", url: `/api/plugins/${id}` })).json() as {
      contentHash: string;
      clientType: string;
      files: Array<{ path: string; content: string }>;
    };

  test("refuses a save based on files that have changed since, and keeps the files", async () => {
    const plugin = await create();
    const other = await save(plugin.id, { files: [file("README.md", "two")] });
    expect(other.statusCode, other.body).toBe(200);

    const stale = await save(plugin.id, {
      files: [file("README.md", "overwrites two")],
      baseContentHash: plugin.contentHash,
    });

    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.message).toContain("changed since");
    const now = await read(plugin.id);
    expect(now.files).toEqual([
      expect.objectContaining({ path: "README.md", content: "two" }),
    ]);

    // Based on the files as they are now, the same save goes through.
    const current = await save(plugin.id, {
      files: [file("README.md", "three")],
      baseContentHash: now.contentHash,
    });
    expect(current.statusCode, current.body).toBe(200);
  });

  test("asks for the hash only when files are sent, and replaces them without one", async () => {
    const plugin = await create();
    await save(plugin.id, { files: [file("README.md", "two")] });

    // No files: the stale hash guards nothing.
    const described = await save(plugin.id, {
      description: "Described from a stale page.",
      baseContentHash: plugin.contentHash,
    });
    expect(described.statusCode, described.body).toBe(200);

    // No hash: the files are replaced whatever they are now.
    const replaced = await save(plugin.id, {
      files: [file("README.md", "three")],
    });
    expect(replaced.statusCode, replaced.body).toBe(200);
    expect((await read(plugin.id)).files).toEqual([
      expect.objectContaining({ content: "three" }),
    ]);
  });

  test("answers 404, not 409, for a guarded save of a plugin that is gone", async () => {
    const plugin = await create();
    await app.inject({ method: "DELETE", url: `/api/plugins/${plugin.id}` });

    const response = await save(plugin.id, {
      files: [file("README.md", "late")],
      baseContentHash: plugin.contentHash,
    });

    expect(response.statusCode).toBe(404);
  });

  test("moves a manual plugin to another client, leaving its files as they are", async () => {
    const plugin = await create();

    const moved = await save(plugin.id, { clientType: "cursor" });

    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json()).toMatchObject({
      clientType: "cursor",
      files: [expect.objectContaining({ path: "README.md", content: "one" })],
    });
  });
});
