import { vi } from "vitest";
import { userHasPermission } from "@/auth";
import config from "@/config";
import { PluginModel, PluginSkillUsageEventModel } from "@/models";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  useRouteTestApp,
} from "@/test";
import type { CreatePlugin } from "@/types";
import { drainBackgroundWork } from "@/utils/background-work";
import pluginSkillRoutes from "./plugin-skill.routes";

vi.mock("@/auth");

const mockUserHasPermission = vi.mocked(userHasPermission);

const SKILL_MD = [
  "---",
  "name: ste-writing",
  "description: Write without AI slop.",
  "compatibility: Requires node 20+.",
  "allowed-tools: Bash Read",
  "---",
  "",
  "# ste-writing",
  "",
  "Write plainly.",
].join("\n");

const ROOT_SKILL_MD = [
  "---",
  "name: root-guide",
  "description: A root-level skill.",
  "---",
  "",
  "# root-guide",
  "",
  "Top-level instructions.",
].join("\n");

function stePlugin(overrides: Partial<CreatePlugin> = {}): CreatePlugin {
  return {
    displayName: "STE bundle",
    description: "Hooks and a writing skill",
    clientType: "claude-code",
    supportedPlatforms: ["posix", "windows"],
    files: [
      {
        path: "skills/ste-writing/SKILL.md",
        content: SKILL_MD,
        encoding: "utf8",
        mode: "100644",
      },
      {
        path: "skills/ste-writing/scripts/ste-lint.py",
        content: "print('lint')\n",
        encoding: "utf8",
        mode: "100755",
      },
      {
        path: "skills/ste-writing/references/NOTES.md",
        content: "# Notes\n",
        encoding: "utf8",
        mode: "100644",
      },
      {
        path: "hooks/hooks.json",
        content: '{ "hooks": {} }\n',
        encoding: "utf8",
        mode: "100644",
      },
    ],
    ...overrides,
  };
}

describe("plugin Skill routes", () => {
  const ctx = useRouteTestApp(pluginSkillRoutes);
  let originalEnabled: boolean;

  beforeEach(() => {
    originalEnabled = config.plugins.enabled;
    config.plugins.enabled = true;
    mockUserHasPermission.mockReset();
    // the catalog reader is not a plugin admin, so visibility is scope-based
    mockUserHasPermission.mockImplementation(
      async (_userId, _organizationId, _resource, action) => action === "read",
    );
  });

  afterEach(() => {
    config.plugins.enabled = originalEnabled;
    vi.restoreAllMocks();
  });

  async function seedPlugin(input: CreatePlugin) {
    const plugin = await PluginModel.create({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      input,
    });
    if (!plugin) throw new Error("seed plugin creation failed");
    return plugin;
  }

  test("routes are absent while the plugins beta gate is off", async () => {
    config.plugins.enabled = false;

    const list = await ctx.app.inject({
      method: "GET",
      url: "/api/skills/plugins",
    });
    expect(list.statusCode).toBe(404);

    const detail = await ctx.app.inject({
      method: "GET",
      url: "/api/skills/plugins/00000000-0000-4000-8000-000000000000",
    });
    expect(detail.statusCode).toBe(404);
  });

  test("lists portable skills across plugins, skipping invalid manifests", async () => {
    const ste = await seedPlugin(stePlugin({ scope: "org" }));
    PluginSkillUsageEventModel.recordUsage({
      pluginId: ste.id,
      skillPath: "skills/ste-writing",
      userId: ctx.user.id,
    });
    await drainBackgroundWork();
    // a plugin without any SKILL.md contributes nothing
    await seedPlugin({
      displayName: "Hooks only",
      description: "",
      clientType: "codex",
      scope: "org",
      files: [
        {
          path: "hooks/hooks.json",
          content: "{}\n",
          encoding: "utf8",
          mode: "100644",
        },
      ],
    });
    // an invalid manifest (no description) is not a skill
    await seedPlugin({
      displayName: "Broken skill",
      description: "",
      clientType: "cursor",
      scope: "org",
      files: [
        {
          path: "skills/broken/SKILL.md",
          content: "---\nname: broken\n---\nno description\n",
          encoding: "utf8",
          mode: "100644",
        },
      ],
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/skills/plugins",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({
        source: "plugin",
        pluginId: ste.id,
        pluginName: "STE bundle",
        sourceRepo: null,
        sourceMarketplaceRepo: null,
        pluginEnabled: true,
        scope: "org",
        clientType: "claude-code",
        supportedPlatforms: ["posix", "windows"],
        skillPath: "skills/ste-writing",
        name: "ste-writing",
        description: "Write without AI slop.",
        compatibility: "Requires node 20+.",
        fileCount: 2,
        usageCount: 1,
        usageUserCount: 1,
        lastUsedAt: expect.any(String),
      }),
    ]);
  });

  test("list hides plugins outside the caller's visibility", async ({
    makeUser,
    makeMember,
  }) => {
    await seedPlugin(stePlugin({ displayName: "Org bundle", scope: "org" }));
    const other = await makeUser();
    await makeMember(other.id, ctx.organizationId);
    const personal = await PluginModel.create({
      organizationId: ctx.organizationId,
      userId: other.id,
      input: stePlugin({ displayName: "Personal bundle", scope: "personal" }),
    });
    if (!personal) throw new Error("seed plugin creation failed");

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/skills/plugins",
    });
    expect(response.statusCode).toBe(200);
    const names = response
      .json()
      .map((item: { pluginName: string }) => item.pluginName);
    expect(names).toContain("Org bundle");
    expect(names).not.toContain("Personal bundle");

    mockUserHasPermission.mockResolvedValue(false);
    const withoutPluginRead = await ctx.app.inject({
      method: "GET",
      url: "/api/skills/plugins",
    });
    expect(withoutPluginRead.json()).toEqual([]);

    // a plugin admin sees the whole org catalog
    mockUserHasPermission.mockResolvedValue(true);
    const adminResponse = await ctx.app.inject({
      method: "GET",
      url: "/api/skills/plugins",
    });
    const adminNames = adminResponse
      .json()
      .map((item: { pluginName: string }) => item.pluginName);
    expect(adminNames).toContain("Org bundle");
    expect(adminNames).toContain("Personal bundle");
  });

  test("detail returns the parsed manifest and relative resource files", async () => {
    const plugin = await seedPlugin(stePlugin({ scope: "org" }));

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/skills/plugins/${plugin.id}?skillPath=skills/ste-writing`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      pluginId: plugin.id,
      skillPath: "skills/ste-writing",
      name: "ste-writing",
      description: "Write without AI slop.",
      compatibility: "Requires node 20+.",
      allowedTools: "Bash Read",
      fileCount: 2,
    });
    expect(body.manifest).toBe(SKILL_MD);
    expect(body.content).toBe("# ste-writing\n\nWrite plainly.");
    expect(body.files).toEqual([
      expect.objectContaining({
        path: "references/NOTES.md",
        content: "# Notes\n",
        kind: "reference",
      }),
      expect.objectContaining({
        path: "scripts/ste-lint.py",
        content: "print('lint')\n",
        kind: "script",
      }),
    ]);
  });

  test("returns usage statistics only for a visible plugin skill", async () => {
    const plugin = await seedPlugin(stePlugin({ scope: "org" }));
    PluginSkillUsageEventModel.recordUsage({
      pluginId: plugin.id,
      skillPath: "skills/ste-writing",
      userId: ctx.user.id,
    });
    await drainBackgroundWork();

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/skills/plugins/${plugin.id}/usage-statistics?skillPath=skills/ste-writing`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().users).toEqual([
      expect.objectContaining({ userId: ctx.user.id, total: 1 }),
    ]);

    const missing = await ctx.app.inject({
      method: "GET",
      url: `/api/skills/plugins/${plugin.id}/usage-statistics?skillPath=missing`,
    });
    expect(missing.statusCode).toBe(404);
  });

  test("nested skill trees keep their own files", async () => {
    mockUserHasPermission.mockResolvedValue(true);
    const plugin = await seedPlugin(
      stePlugin({
        scope: "org",
        files: [
          {
            path: "SKILL.md",
            content: ROOT_SKILL_MD,
            encoding: "utf8",
            mode: "100644",
          },
          {
            path: "notes.md",
            content: "root note\n",
            encoding: "utf8",
            mode: "100644",
          },
          {
            path: "skills/ste-writing/SKILL.md",
            content: SKILL_MD,
            encoding: "utf8",
            mode: "100644",
          },
          {
            path: "skills/ste-writing/scripts/ste-lint.py",
            content: "print('lint')\n",
            encoding: "utf8",
            mode: "100755",
          },
        ],
      }),
    );

    const list = await ctx.app.inject({
      method: "GET",
      url: "/api/skills/plugins",
    });
    const items = list.json();
    expect(items).toHaveLength(2);
    const rootItem = items.find(
      (item: { skillPath: string }) => item.skillPath === "",
    );
    const nestedItem = items.find(
      (item: { skillPath: string }) => item.skillPath === "skills/ste-writing",
    );
    // the root tree owns only its note; the nested tree owns its script
    expect(rootItem).toMatchObject({ name: "root-guide", fileCount: 1 });
    expect(nestedItem).toMatchObject({ name: "ste-writing", fileCount: 1 });

    const rootDetail = await ctx.app.inject({
      method: "GET",
      url: `/api/skills/plugins/${plugin.id}`,
    });
    expect(rootDetail.statusCode).toBe(200);
    expect(rootDetail.json().files).toEqual([
      expect.objectContaining({ path: "notes.md" }),
    ]);
  });

  test("plugin readers can reuse instructions and bundled resource bytes", async () => {
    const plugin = await seedPlugin(stePlugin({ scope: "org" }));

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/skills/plugins/${plugin.id}?skillPath=skills/ste-writing`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      manifest: SKILL_MD,
      content: "# ste-writing\n\nWrite plainly.",
      fileCount: 2,
      files: [
        expect.objectContaining({ path: "references/NOTES.md" }),
        expect.objectContaining({ path: "scripts/ste-lint.py" }),
      ],
    });
  });

  test("detail is a 404 for an unknown skill path or an invisible plugin", async ({
    makeUser,
    makeMember,
  }) => {
    const plugin = await seedPlugin(stePlugin({ scope: "org" }));

    const wrongPath = await ctx.app.inject({
      method: "GET",
      url: `/api/skills/plugins/${plugin.id}?skillPath=skills/nope`,
    });
    expect(wrongPath.statusCode).toBe(404);

    const other = await makeUser();
    await makeMember(other.id, ctx.organizationId);
    const personal = await PluginModel.create({
      organizationId: ctx.organizationId,
      userId: other.id,
      input: stePlugin({ displayName: "Personal bundle", scope: "personal" }),
    });
    if (!personal) throw new Error("seed plugin creation failed");
    const invisible = await ctx.app.inject({
      method: "GET",
      url: `/api/skills/plugins/${personal.id}?skillPath=skills/ste-writing`,
    });
    expect(invisible.statusCode).toBe(404);
  });

  test("a deleted plugin's skills disappear", async () => {
    const plugin = await seedPlugin(stePlugin({ scope: "org" }));
    await PluginModel.delete({
      id: plugin.id,
      organizationId: ctx.organizationId,
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/skills/plugins",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });
});
