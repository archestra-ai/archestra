import { PLUGIN_MARKETPLACE_IMPORT_LIMIT } from "@archestra/shared";
import { vi } from "vitest";
import { userHasPermission } from "@/auth";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { AuditLogModel, PluginModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  useRouteTestApp,
} from "@/test";
import { STUB_COMMIT_SHA, stubGithub } from "@/test/github-skills-stub";
import type { CreatePlugin, User } from "@/types";
import pluginRoutes from "./plugin.routes";

vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    plugins: { enabled: true },
  }),
);
vi.mock("@/auth");

const mockUserHasPermission = vi.mocked(userHasPermission);

beforeEach(() => {
  mockUserHasPermission.mockReset();
  mockUserHasPermission.mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const HOOKS_BYTES = `{
    "description": "keep four-space indentation",
    "hooks": { "SessionStart": [] }
}
`;

function createPayload(): CreatePlugin {
  return {
    displayName: "Session attribution",
    description: "Attributes local client sessions",
    clientType: "claude-code",
    files: [
      {
        path: "hooks/hooks.json",
        content: HOOKS_BYTES,
        encoding: "utf8",
        mode: "100644",
      },
      {
        path: "scripts/attribute.sh",
        content: "#!/bin/sh\necho attributed\n",
        encoding: "utf8",
        mode: "100755",
      },
    ],
  };
}

describe("plugin routes", () => {
  const ctx = useRouteTestApp(pluginRoutes);

  test("creates, lists, and reads an opaque plugin without rewriting files", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/plugins",
      payload: createPayload(),
    });

    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      displayName: "Session attribution",
      clientType: "claude-code",
      supportedPlatforms: ["posix"],
      enabled: true,
      approvedContentHash: expect.any(String),
    });
    expect(created.json().contentHash).toBe(created.json().approvedContentHash);
    expect(created.json().pluginSlug).toMatch(
      /^session-attribution-[a-f0-9]{8}$/,
    );
    expect(created.json().files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "hooks/hooks.json",
          content: HOOKS_BYTES,
          mode: "100644",
        }),
        expect.objectContaining({
          path: "scripts/attribute.sh",
          mode: "100755",
        }),
      ]),
    );

    const list = await ctx.app.inject({
      method: "GET",
      url: "/api/plugins",
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([
      expect.objectContaining({ id: created.json().id, fileCount: 2 }),
    ]);

    const detail = await ctx.app.inject({
      method: "GET",
      url: `/api/plugins/${created.json().id}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(
      detail
        .json()
        .files.find(
          (file: { path: string }) => file.path === "hooks/hooks.json",
        ).content,
    ).toBe(HOOKS_BYTES);
  });

  test("atomically replaces files and records a new approved content hash", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/plugins",
      payload: createPayload(),
    });
    const originalHash = created.json().contentHash;
    const replacement = `${HOOKS_BYTES}\n`;

    const updated = await ctx.app.inject({
      method: "PUT",
      url: `/api/plugins/${created.json().id}`,
      payload: {
        displayName: "Renamed in Archestra",
        supportedPlatforms: ["posix", "windows"],
        files: [
          {
            path: "hooks/hooks.json",
            content: replacement,
            encoding: "utf8",
            mode: "100644",
          },
        ],
      },
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json().pluginSlug).toBe(created.json().pluginSlug);
    expect(updated.json().supportedPlatforms).toEqual(["posix", "windows"]);
    expect(updated.json().contentHash).not.toBe(originalHash);
    expect(updated.json().approvedContentHash).toBe(updated.json().contentHash);
    expect(updated.json().files).toHaveLength(1);
    expect(updated.json().files[0].content).toBe(replacement);
  });

  test("rejects unsafe, duplicate, and malformed file sets", async () => {
    const invalidFileSets = [
      [{ path: "../hooks/hooks.json", content: "{}" }],
      [
        { path: "hooks/hooks.json", content: "{}" },
        { path: "HOOKS/HOOKS.JSON", content: "{}" },
      ],
      [
        {
          path: "hooks/hooks.json",
          content: "not base64",
          encoding: "base64",
        },
      ],
    ];

    for (const files of invalidFileSets) {
      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/plugins",
        payload: {
          displayName: "Invalid plugin",
          clientType: "claude-code",
          files,
        },
      });
      expect(response.statusCode).toBe(400);
    }
  });

  test("creates a hookless Claude plugin", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/plugins",
      payload: {
        displayName: "Agent toolkit",
        clientType: "claude-code",
        files: [
          {
            path: "agents/reviewer.md",
            content: "Review changes.\n",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().files).toEqual([
      expect.objectContaining({ path: "agents/reviewer.md" }),
    ]);
  });

  test("hides plugins belonging to another organization", async ({
    makeOrganization,
  }) => {
    const other = await makeOrganization();
    const foreign = await PluginModel.create({
      organizationId: other.id,
      userId: ctx.user.id,
      input: createPayload(),
    });
    if (!foreign) throw new Error("failed to seed foreign plugin");

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/plugins/${foreign.id}`,
    });
    expect(response.statusCode).toBe(404);
  });

  test("soft-deletes the plugin and removes it from reads", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/plugins",
      payload: createPayload(),
    });

    const deleted = await ctx.app.inject({
      method: "DELETE",
      url: `/api/plugins/${created.json().id}`,
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ success: true });

    const detail = await ctx.app.inject({
      method: "GET",
      url: `/api/plugins/${created.json().id}`,
    });
    expect(detail.statusCode).toBe(404);
  });

  test("persists team and named-user visibility", async ({
    makeTeam,
    makeUser,
    makeMember,
  }) => {
    const team = await makeTeam(ctx.organizationId, ctx.user.id, {
      name: "Plugin reviewers",
    });
    const member = await makeUser();
    await makeMember(member.id, ctx.organizationId);

    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/plugins",
      payload: {
        ...createPayload(),
        scope: "team",
        teamIds: [team.id],
      },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      scope: "team",
      teams: [{ id: team.id, name: "Plugin reviewers" }],
      users: [],
    });

    const updated = await ctx.app.inject({
      method: "PUT",
      url: `/api/plugins/${created.json().id}`,
      payload: {
        scope: "personal",
        teamIds: [],
        userIds: [member.id],
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      scope: "personal",
      teams: [],
      users: [expect.objectContaining({ id: member.id })],
    });
  });

  test("previews and imports a GitHub subtree by immutable commit", async () => {
    stubGithub([
      {
        owner: "route-plugin",
        repo: "plugin",
        files: {
          "hooks/hooks.json": '{ "hooks": {} }\n',
          "scripts/run.sh": "#!/bin/sh\ntrue\n",
          ".mcp.json": "{}",
        },
        modes: { "scripts/run.sh": "100755" },
      },
    ]);

    const preview = await ctx.app.inject({
      method: "POST",
      url: "/api/plugins/github/preview",
      payload: { repoUrl: "route-plugin/plugin", ref: "main" },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      repo: "route-plugin/plugin",
      commitSha: STUB_COMMIT_SHA,
      skippedFiles: [],
    });
    expect(preview.json().files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "scripts/run.sh", mode: "100755" }),
        expect.objectContaining({ path: ".mcp.json", mode: "100644" }),
      ]),
    );

    const imported = await ctx.app.inject({
      method: "POST",
      url: "/api/plugins/github/import",
      payload: {
        repoUrl: "https://github.com/route-plugin/plugin/tree/release",
        displayName: "Imported plugin",
        description: "Imported from GitHub",
        clientType: "claude-code",
        supportedPlatforms: ["windows"],
        approvedCommitSha: STUB_COMMIT_SHA,
      },
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json()).toMatchObject({
      sourceKind: "github",
      sourceRepo: "route-plugin/plugin",
      sourceRef: "release",
      sourceSha: STUB_COMMIT_SHA,
      supportedPlatforms: ["windows"],
      approvedContentHash: expect.any(String),
    });
  });

  test("discovers and batch-imports selected marketplace plugins", async () => {
    stubGithub([
      {
        owner: "plugin-marketplace",
        repo: "catalog",
        files: {
          ".claude-plugin/marketplace.json": JSON.stringify({
            plugins: [
              {
                name: "first-plugin",
                description: "First plugin",
                version: "1.0.0",
                source: "./plugins/first",
              },
              {
                name: "second-plugin",
                description: "Second plugin",
                version: "2.0.0",
                source: "./plugins/second",
              },
            ],
          }),
          "plugins/first/hooks/hooks.json": "{}\n",
          "plugins/second/.mcp.json": '{ "mcpServers": {} }\n',
          "plugins/second/agents/reviewer.md": "Review changes.\n",
        },
      },
    ]);

    const discovered = await ctx.app.inject({
      method: "POST",
      url: "/api/plugins/github/marketplace/discover",
      payload: { repoUrl: "plugin-marketplace/catalog", ref: "main" },
    });
    expect(discovered.statusCode).toBe(200);
    expect(discovered.json().entries).toHaveLength(2);
    expect(discovered.json().entries).toEqual([
      expect.objectContaining({ name: "first-plugin", fileCount: 1 }),
      expect.objectContaining({ name: "second-plugin", fileCount: 2 }),
    ]);
    expect(discovered.headers["cache-control"]).toBe("no-store");

    const selected = discovered
      .json()
      .entries.map(
        (entry: {
          name: string;
          description: string;
          clientType: "claude-code";
          sourceRepoUrl: string;
          sourceRef: string;
          sourceSubdir: string;
          sourceCommitSha: string;
        }) => ({
          name: entry.name,
          displayName: entry.name === "first-plugin" ? "First" : "Second",
          description: entry.description,
          clientType: entry.clientType,
          supportedPlatforms: ["posix"],
          sourceRepoUrl: entry.sourceRepoUrl,
          sourceRef: entry.sourceRef,
          sourceSubdir: entry.sourceSubdir,
          approvedSourceSha: entry.sourceCommitSha,
          exclude: [],
        }),
      );
    const importPayload = {
      repoUrl: "plugin-marketplace/catalog",
      ref: "main",
      marketplacePath: ".claude-plugin/marketplace.json",
      approvedCommitSha: STUB_COMMIT_SHA,
      trackingRef: "main",
      selected,
      scope: "org",
      teamIds: [],
      userIds: [],
      syncInterval: "1d",
    } as const;
    const imported = await ctx.app.inject({
      method: "POST",
      url: "/api/plugins/github/marketplace/import",
      payload: importPayload,
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json().failed).toEqual([]);
    expect(imported.json().created).toEqual([
      expect.objectContaining({
        displayName: "First",
        sourceMarketplaceRepo: "plugin-marketplace/catalog",
        sourceMarketplacePluginName: "first-plugin",
        githubSyncInterval: "1d",
      }),
      expect.objectContaining({
        displayName: "Second",
        sourceMarketplaceRepo: "plugin-marketplace/catalog",
        sourceMarketplacePluginName: "second-plugin",
        githubSyncInterval: "1d",
        files: expect.arrayContaining([
          expect.objectContaining({ path: ".mcp.json" }),
          expect.objectContaining({ path: "agents/reviewer.md" }),
        ]),
      }),
    ]);

    const duplicate = await ctx.app.inject({
      method: "POST",
      url: "/api/plugins/github/marketplace/import",
      payload: {
        ...importPayload,
        selected: selected.map((entry: { displayName: string }) => ({
          ...entry,
          displayName: `${entry.displayName} Copy`,
        })),
      },
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().created).toEqual([]);
    expect(duplicate.json().failed).toEqual([
      expect.objectContaining({ name: "first-plugin" }),
      expect.objectContaining({ name: "second-plugin" }),
    ]);
  });

  test("rejects marketplace imports above the beta batch limit", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/plugins/github/marketplace/import",
      payload: {
        repoUrl: "https://github.com/plugin-marketplace/catalog",
        ref: "main",
        marketplacePath: ".claude-plugin/marketplace.json",
        approvedCommitSha: STUB_COMMIT_SHA,
        trackingRef: "main",
        selected: Array.from(
          { length: PLUGIN_MARKETPLACE_IMPORT_LIMIT + 1 },
          (_, index) => ({
            name: `plugin-${index}`,
            displayName: `Plugin ${index}`,
            description: "Marketplace plugin",
            clientType: "claude-code",
            supportedPlatforms: ["posix"],
            sourceRepoUrl: `https://github.com/plugin-source/plugin-${index}`,
            sourceRef: "main",
            sourceSubdir: "",
            approvedSourceSha: STUB_COMMIT_SHA,
            exclude: [],
          }),
        ),
        scope: "org",
        teamIds: [],
        userIds: [],
        syncInterval: null,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain(
      `Select at most ${PLUGIN_MARKETPLACE_IMPORT_LIMIT} plugins per import`,
    );
  });

  test("keeps approved bytes live until a GitHub update is explicitly applied", async () => {
    const plugin = await PluginModel.create({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      input: {
        displayName: "Tracked plugin",
        description: "Tracked from GitHub",
        clientType: "claude-code",
        files: [
          {
            path: "hooks/hooks.json",
            content: "old bytes\n",
            encoding: "utf8",
            mode: "100644",
          },
        ],
      },
      source: {
        repo: "route-update/plugin",
        ref: "main",
        sha: "old-commit",
        subdir: "",
        exclude: [],
      },
    });
    if (!plugin) throw new Error("failed to seed tracked plugin");
    const oldHash = plugin.contentHash;

    const directEdit = await ctx.app.inject({
      method: "PUT",
      url: `/api/plugins/${plugin.id}`,
      payload: {
        files: [
          {
            path: "hooks/hooks.json",
            content: "bypassed approval\n",
            encoding: "utf8",
            mode: "100644",
          },
        ],
      },
    });
    expect(directEdit.statusCode).toBe(409);

    const fetchMock = stubGithub([
      {
        owner: "route-update",
        repo: "plugin",
        files: { "hooks/hooks.json": "new bytes\n" },
      },
    ]);

    const preview = await ctx.app.inject({
      method: "POST",
      url: `/api/plugins/${plugin.id}/github/preview-update`,
      payload: {},
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().commitSha).toBe(STUB_COMMIT_SHA);
    expect(preview.json().files[0].content).toBe("new bytes\n");

    const beforeApply = await PluginModel.findById({
      id: plugin.id,
      organizationId: ctx.organizationId,
    });
    expect(beforeApply?.sourceSha).toBe("old-commit");
    expect(beforeApply?.contentHash).toBe(oldHash);
    expect(beforeApply?.files[0].content).toBe("old bytes\n");

    const applied = await ctx.app.inject({
      method: "POST",
      url: `/api/plugins/${plugin.id}/github/apply-update`,
      payload: { approvedCommitSha: STUB_COMMIT_SHA },
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().sourceSha).toBe(STUB_COMMIT_SHA);
    expect(applied.json().contentHash).not.toBe(oldHash);
    expect(applied.json().approvedContentHash).toBe(applied.json().contentHash);
    expect(applied.json().files[0].content).toBe("new bytes\n");
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes(`/commits/${STUB_COMMIT_SHA}`),
      ),
    ).toBe(true);

    const mismatched = await ctx.app.inject({
      method: "POST",
      url: `/api/plugins/${plugin.id}/github/apply-update`,
      payload: {
        approvedCommitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    });
    expect(mismatched.statusCode).toBe(409);
  });
});

describe("plugin audit records", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    const actor = await makeUser();
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { organizationId: string; user: User }
      ).organizationId = organizationId;
      (request as typeof request & { user: User }).user = actor;
    });
    registerAuditLogHook(app);
    await app.register(pluginRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("create, update, and delete record non-secret before/after diffs", async () => {
    const createdResponse = await app.inject({
      method: "POST",
      url: "/api/plugins",
      payload: createPayload(),
    });
    const created = createdResponse.json();
    await app.inject({
      method: "PUT",
      url: `/api/plugins/${created.id}`,
      payload: { displayName: "Renamed plugin" },
    });
    await app.inject({
      method: "DELETE",
      url: `/api/plugins/${created.id}`,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const { data } = await AuditLogModel.findPaginated({
      organizationId,
      resourceType: "plugin",
      sortDirection: "asc",
      limit: 20,
      offset: 0,
    });
    expect(data.map((row) => row.action)).toEqual([
      "plugin.created",
      "plugin.updated",
      "plugin.deleted",
    ]);
    for (const row of data) {
      expect(row.resourceId).toBe(created.id);
      expect(JSON.stringify(row.before)).not.toContain(HOOKS_BYTES);
      expect(JSON.stringify(row.after)).not.toContain(HOOKS_BYTES);
    }
    expect(data[0].after).toMatchObject({ displayName: "Session attribution" });
    expect(data[1].before).toMatchObject({
      displayName: "Session attribution",
    });
    expect(data[1].after).toMatchObject({ displayName: "Renamed plugin" });
    expect(data[2].before).toMatchObject({ displayName: "Renamed plugin" });
  });
});
