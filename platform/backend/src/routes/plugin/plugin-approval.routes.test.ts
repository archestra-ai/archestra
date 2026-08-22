import { vi } from "vitest";
import { userHasPermission } from "@/auth";
import { PluginModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { CreatePlugin, User } from "@/types";

vi.mock("@/auth");
vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    plugins: { enabled: true },
  }),
);

const mockUserHasPermission = vi.mocked(userHasPermission);

describe("plugin executable-content approval", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeUser();
    mockUserHasPermission.mockReset();
    mockUserHasPermission.mockResolvedValue(false);
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { organizationId: string; user: User }
      ).organizationId = organizationId;
      (request as typeof request & { user: User }).user = user;
    });
    const { default: pluginRoutes } = await import("./plugin.routes");
    await app.register(pluginRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("requires plugin:admin to create approved executable bytes", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/plugins",
      payload: createPayload(),
    });
    expect(response.statusCode).toBe(403);
  });

  test("requires plugin:admin to import or apply GitHub bytes", async () => {
    const preview = await app.inject({
      method: "POST",
      url: "/api/plugins/github/preview",
      payload: { repoUrl: "trusted/example" },
    });
    expect(preview.statusCode).toBe(403);

    const imported = await app.inject({
      method: "POST",
      url: "/api/plugins/github/import",
      payload: {
        repoUrl: "trusted/example",
        displayName: "Imported plugin",
        clientType: "claude-code",
        approvedCommitSha: "a".repeat(40),
      },
    });
    expect(imported.statusCode).toBe(403);

    const tracked = await PluginModel.create({
      organizationId,
      userId: user.id,
      input: createPayload(),
      source: {
        repo: "trusted/example",
        ref: "main",
        sha: "b".repeat(40),
        subdir: "",
        exclude: [],
      },
    });
    if (!tracked) throw new Error("failed to seed tracked plugin");
    const read = await app.inject({
      method: "GET",
      url: `/api/plugins/${tracked.id}`,
    });
    expect(read.statusCode).toBe(403);

    const previewUpdate = await app.inject({
      method: "POST",
      url: `/api/plugins/${tracked.id}/github/preview-update`,
      payload: {},
    });
    expect(previewUpdate.statusCode).toBe(403);

    const applied = await app.inject({
      method: "POST",
      url: `/api/plugins/${tracked.id}/github/apply-update`,
      payload: { approvedCommitSha: "c".repeat(40) },
    });
    expect(applied.statusCode).toBe(403);
  });

  test("requires plugin:admin to replace bytes, enable, or widen platforms", async () => {
    const plugin = await PluginModel.create({
      organizationId,
      userId: user.id,
      input: createPayload(),
    });
    if (!plugin) throw new Error("failed to seed plugin");

    for (const payload of [
      { files: createPayload().files },
      { enabled: false },
      { supportedPlatforms: ["posix", "windows"] },
    ]) {
      const response = await app.inject({
        method: "PUT",
        url: `/api/plugins/${plugin.id}`,
        payload,
      });
      expect(response.statusCode).toBe(403);
    }

    const metadataOnly = await app.inject({
      method: "PUT",
      url: `/api/plugins/${plugin.id}`,
      payload: { displayName: "Renamed without republishing" },
    });
    expect(metadataOnly.statusCode).toBe(403);
  });
});

function createPayload(): CreatePlugin {
  return {
    displayName: "Approval test plugin",
    description: "Executable approval boundary",
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
