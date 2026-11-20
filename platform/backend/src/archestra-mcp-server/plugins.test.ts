import type { ResourcePermissionAction } from "@archestra/shared";
import {
  ADMIN_ROLE_NAME,
  ARCHESTRA_TOOL_PREFIX,
  EDITOR_ROLE_NAME,
  MEMBER_ROLE_NAME,
  TOOL_CREATE_PLUGIN_FULL_NAME,
  TOOL_DELETE_PLUGIN_FULL_NAME,
  TOOL_EDIT_PLUGIN_FULL_NAME,
  TOOL_GET_PLUGIN_FULL_NAME,
  TOOL_LIST_PLUGINS_FULL_NAME,
  TOOL_UPDATE_PLUGIN_FULL_NAME,
} from "@archestra/shared";
import { vi } from "vitest";
import config from "@/config";
import { AuditLogModel, PluginModel } from "@/models";
import {
  accessGrants,
  afterEach,
  beforeEach,
  describe,
  expect,
  type TestAccess,
  test,
} from "@/test";
import {
  type Agent,
  type CreatePlugin,
  PLUGIN_MAX_FILE_BYTES,
  PLUGIN_MAX_TOTAL_BYTES,
} from "@/types";
import {
  type ArchestraContext,
  executeArchestraTool,
  getArchestraMcpTools,
} from ".";

const HOOKS_BYTES = '{\n  "hooks": { "SessionStart": [] }\n}\n';

function pluginPayload(overrides: Partial<CreatePlugin> = {}): CreatePlugin {
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
    ...overrides,
  };
}

function textOf(result: { content: unknown[] }): string {
  return (result.content[0] as { text: string }).text;
}

describe("plugin tool execution", () => {
  let agent: Agent;
  let context: ArchestraContext;
  let organizationId: string;
  let adminUserId: string;

  beforeEach(async ({ makeAgent, makeUser, makeMember }) => {
    agent = await makeAgent({ name: "Plugin Agent" });
    organizationId = agent.organizationId;
    const user = await makeUser();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
    adminUserId = user.id;
    context = {
      agent: { id: agent.id, name: agent.name },
      organizationId,
      userId: adminUserId,
    };
    config.beta = false;
  });

  afterEach(() => vi.restoreAllMocks());

  async function seedPlugin(
    overrides: Partial<CreatePlugin> = {},
    access?: TestAccess,
  ) {
    const plugin = await PluginModel.create({
      organizationId,
      userId: adminUserId,
      input: pluginPayload(overrides),
      ...accessGrants(access),
    });
    if (!plugin) throw new Error("seed plugin creation failed");
    return plugin;
  }

  async function findAuditRows(action: string) {
    // the audit write is fire-and-forget; give it a beat to land
    await new Promise((r) => setTimeout(r, 100));
    const { data } = await AuditLogModel.findPaginated({
      organizationId,
      resourceType: "plugin",
      limit: 20,
      offset: 0,
    });
    return data.filter((row) => row.action === action);
  }

  test("plugin tools are registered with beta disabled", () => {
    const names = getArchestraMcpTools().map((tool) => tool.name);
    expect(names).toContain(TOOL_LIST_PLUGINS_FULL_NAME);
    expect(names).toContain(TOOL_GET_PLUGIN_FULL_NAME);
    expect(names).toContain(TOOL_CREATE_PLUGIN_FULL_NAME);
    expect(names).toContain(TOOL_UPDATE_PLUGIN_FULL_NAME);
    expect(names).toContain(TOOL_EDIT_PLUGIN_FULL_NAME);
    expect(names).toContain(TOOL_DELETE_PLUGIN_FULL_NAME);
    expect(names).not.toContain(`${ARCHESTRA_TOOL_PREFIX}import_plugin`);
  });

  test("handlers execute a direct dispatch with beta disabled", async () => {
    config.beta = false;

    const result = await executeArchestraTool(
      TOOL_LIST_PLUGINS_FULL_NAME,
      {},
      context,
    );

    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toContain("No plugins");
  });

  test("plugin dispatch still requires an authenticated user with beta disabled", async () => {
    const result = await executeArchestraTool(
      TOOL_LIST_PLUGINS_FULL_NAME,
      {},
      { ...context, userId: undefined },
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("requires an acting user");
  });

  test("plugin tools are denied without plugin permissions", async ({
    makeUser,
    makeMember,
  }) => {
    const member = await makeUser();
    await makeMember(member.id, organizationId, { role: MEMBER_ROLE_NAME });

    const result = await executeArchestraTool(
      TOOL_LIST_PLUGINS_FULL_NAME,
      {},
      { ...context, userId: member.id },
    );

    expect(result.isError).toBe(true);
  });

  test("the retired plugin:admin role action does not stand in for plugin:create", async ({
    makeCustomRole,
    makeMember,
    makeUser,
  }) => {
    const role = await makeCustomRole(organizationId, {
      permission: { plugin: ["admin"] },
    });
    const approver = await makeUser();
    await makeMember(approver.id, organizationId, { role: role.role });

    const result = await executeArchestraTool(
      TOOL_CREATE_PLUGIN_FULL_NAME,
      pluginPayload(),
      { ...context, userId: approver.id },
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("plugin:create");
  });

  test("plugin:create alone creates a plugin its author then reads, edits and deletes", async ({
    makeCustomRole,
    makeMember,
    makeUser,
  }) => {
    const role = await makeCustomRole(organizationId, {
      permission: { plugin: ["create"] },
    });
    const creator = await makeUser();
    await makeMember(creator.id, organizationId, { role: role.role });
    const as = { ...context, userId: creator.id };

    const created = await executeArchestraTool(
      TOOL_CREATE_PLUGIN_FULL_NAME,
      pluginPayload(),
      as,
    );
    expect(created.isError, textOf(created)).not.toBe(true);
    const id = (created.structuredContent as { id: string }).id;
    for (const [tool, args] of [
      [TOOL_LIST_PLUGINS_FULL_NAME, {}],
      [TOOL_GET_PLUGIN_FULL_NAME, { id }],
      [TOOL_UPDATE_PLUGIN_FULL_NAME, { id, displayName: "Renamed" }],
      [TOOL_DELETE_PLUGIN_FULL_NAME, { id }],
    ] as const) {
      const result = await executeArchestraTool(tool, args, as);
      expect(result.isError, `${tool}: ${textOf(result)}`).not.toBe(true);
    }
  });

  test("each plugin tool follows the caller's grant on that plugin", async ({
    makeMember,
    makeUser,
  }) => {
    const member = await makeUser();
    await makeMember(member.id, organizationId, { role: MEMBER_ROLE_NAME });
    const grant = (actions: ResourcePermissionAction[]) => ({
      initialPermissionGrants: [
        { subject: { type: "user" as const, id: member.id }, actions },
      ],
    });
    const readable = await PluginModel.create({
      organizationId,
      userId: adminUserId,
      input: pluginPayload({ displayName: "Readable" }),
      ...grant(["read"]),
    });
    const editable = await PluginModel.create({
      organizationId,
      userId: adminUserId,
      input: pluginPayload({ displayName: "Editable" }),
      ...grant(["read", "use", "update"]),
    });
    const hidden = await seedPlugin({ displayName: "Hidden" });
    if (!readable || !editable) throw new Error("seed plugin creation failed");
    const as = { ...context, userId: member.id };
    const run = (tool: string, args: Record<string, unknown>) =>
      executeArchestraTool(tool, args, as);

    const list = await run(TOOL_LIST_PLUGINS_FULL_NAME, {});
    expect(textOf(list)).toContain("Readable");
    expect(textOf(list)).toContain("Editable");
    expect(textOf(list)).not.toContain("Hidden");
    expect(
      (await run(TOOL_GET_PLUGIN_FULL_NAME, { id: readable.id })).isError,
    ).not.toBe(true);
    const refused = await run(TOOL_UPDATE_PLUGIN_FULL_NAME, {
      id: readable.id,
      displayName: "Taken",
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("permission to update");
    const renamed = await run(TOOL_UPDATE_PLUGIN_FULL_NAME, {
      id: editable.id,
      displayName: "Edited by a grant",
    });
    expect(renamed.isError, textOf(renamed)).not.toBe(true);
    expect(
      (await run(TOOL_DELETE_PLUGIN_FULL_NAME, { id: editable.id })).isError,
    ).toBe(true);
    const unseen = await run(TOOL_GET_PLUGIN_FULL_NAME, { id: hidden.id });
    expect(unseen.isError).toBe(true);
    expect(textOf(unseen)).toContain("No plugin with id");
  });

  test("create_plugin, list_plugins, and get_plugin round-trip exact bytes", async () => {
    const created = await executeArchestraTool(
      TOOL_CREATE_PLUGIN_FULL_NAME,
      pluginPayload(),
      context,
    );
    expect(created.isError).toBeFalsy();
    const pluginId = (created.structuredContent as { id: string }).id;
    expect(pluginId).toBeTruthy();

    const list = await executeArchestraTool(
      TOOL_LIST_PLUGINS_FULL_NAME,
      {},
      context,
    );
    expect(list.isError).toBeFalsy();
    expect(textOf(list)).toContain("Session attribution");
    expect(textOf(list)).toContain(pluginId);
    expect(textOf(list)).toContain("2 file(s)");

    const detail = await executeArchestraTool(
      TOOL_GET_PLUGIN_FULL_NAME,
      { id: pluginId },
      context,
    );
    expect(detail.isError).toBeFalsy();
    const plugin = detail.structuredContent as {
      displayName: string;
      contentHash: string;
      files: Array<{ path: string; content: string; mode: string }>;
    };
    expect(plugin.displayName).toBe("Session attribution");
    expect(plugin.contentHash).toBeTruthy();
    expect(plugin.files).toEqual(
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
  });

  test("list_plugins hides plugins outside the caller's visibility", async ({
    makeUser,
    makeMember,
  }) => {
    // an editor holds plugin:read but no grant at `*`, so the catalog is
    // grant-filtered: org plugins show, someone else's own plugin does not.
    const editor = await makeUser();
    await makeMember(editor.id, organizationId, { role: EDITOR_ROLE_NAME });
    await seedPlugin({ displayName: "Org hooks" }, "org");
    await seedPlugin({ displayName: "Admin only" });

    const result = await executeArchestraTool(
      TOOL_LIST_PLUGINS_FULL_NAME,
      {},
      { ...context, userId: editor.id },
    );

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("Org hooks");
    expect(textOf(result)).not.toContain("Admin only");
  });

  test("create_plugin and update_plugin no longer take the retired audience fields", async () => {
    // Audience is set with initialGrants on create and through the resource
    // permissions API afterwards; the strict tool schemas refuse the old
    // scope/team/user fields rather than ignoring them.
    const created = await executeArchestraTool(
      TOOL_CREATE_PLUGIN_FULL_NAME,
      {
        ...pluginPayload({ displayName: "Team hooks" }),
        scope: "team",
        teamIds: ["00000000-0000-0000-0000-000000000000"],
      },
      context,
    );
    expect(created.isError).toBe(true);

    const plugin = await seedPlugin();
    const updated = await executeArchestraTool(
      TOOL_UPDATE_PLUGIN_FULL_NAME,
      { id: plugin.id, scope: "org" },
      context,
    );
    expect(updated.isError).toBe(true);
  });

  test("update_plugin edits metadata", async () => {
    const plugin = await seedPlugin();

    const renamed = await executeArchestraTool(
      TOOL_UPDATE_PLUGIN_FULL_NAME,
      { id: plugin.id, displayName: "Renamed hooks", enabled: false },
      context,
    );
    expect(renamed.isError).toBeFalsy();

    const stored = await PluginModel.findById({
      id: plugin.id,
      organizationId,
    });
    expect(stored?.displayName).toBe("Renamed hooks");
    expect(stored?.enabled).toBe(false);
  });

  test("update_plugin refuses files on a GitHub-sourced plugin", async () => {
    const plugin = await PluginModel.create({
      organizationId,
      userId: adminUserId,
      input: pluginPayload(),
      source: {
        repo: "acme/policy-hooks",
        ref: "main",
        sha: "a".repeat(40),
        subdir: "",
        exclude: [],
      },
    });
    if (!plugin) throw new Error("seed plugin creation failed");

    const result = await executeArchestraTool(
      TOOL_UPDATE_PLUGIN_FULL_NAME,
      {
        id: plugin.id,
        baseContentHash: plugin.contentHash,
        files: [
          {
            path: "hooks/hooks.json",
            content: "{}",
            encoding: "utf8",
            mode: "100644",
          },
        ],
      },
      context,
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("read-only");
    const stored = await PluginModel.findById({
      id: plugin.id,
      organizationId,
    });
    expect(
      stored?.files.find((file) => file.path === "hooks/hooks.json")?.content,
    ).toBe(HOOKS_BYTES);
  });

  test("update_plugin rejects a stale full-file replacement", async () => {
    const plugin = await seedPlugin();
    const replacement = plugin.files.map((file) => ({
      path: file.path,
      content:
        file.path === "hooks/hooks.json"
          ? '{ "winner": true }\n'
          : file.content,
      encoding: file.encoding,
      mode: file.mode,
    }));

    const first = await executeArchestraTool(
      TOOL_UPDATE_PLUGIN_FULL_NAME,
      {
        id: plugin.id,
        baseContentHash: plugin.contentHash,
        files: replacement,
      },
      context,
    );
    expect(first.isError).toBeFalsy();

    const stale = await executeArchestraTool(
      TOOL_UPDATE_PLUGIN_FULL_NAME,
      {
        id: plugin.id,
        baseContentHash: plugin.contentHash,
        files: replacement.map((file) => ({
          ...file,
          content:
            file.path === "hooks/hooks.json"
              ? '{ "stale": true }\n'
              : file.content,
        })),
      },
      context,
    );
    expect(stale.isError).toBe(true);
    expect(textOf(stale)).toContain("changed since you read it");
    const stored = await PluginModel.findById({
      id: plugin.id,
      organizationId,
    });
    expect(
      stored?.files.find((file) => file.path === "hooks/hooks.json")?.content,
    ).toBe('{ "winner": true }\n');
  });

  test("edit_plugin applies str_replace and rejects a stale base", async () => {
    const plugin = await seedPlugin();

    const edited = await executeArchestraTool(
      TOOL_EDIT_PLUGIN_FULL_NAME,
      {
        id: plugin.id,
        baseContentHash: plugin.contentHash,
        path: "hooks/hooks.json",
        edits: [{ old_str: "SessionStart", new_str: "UserPromptSubmit" }],
      },
      context,
    );
    expect(edited.isError).toBeFalsy();

    const stored = await PluginModel.findById({
      id: plugin.id,
      organizationId,
    });
    const target = stored?.files.find(
      (file) => file.path === "hooks/hooks.json",
    );
    expect(target?.content).toContain("UserPromptSubmit");
    expect(target?.content).not.toContain("SessionStart");
    // untouched files keep their exact bytes
    expect(
      stored?.files.find((file) => file.path === "scripts/attribute.sh")
        ?.content,
    ).toBe("#!/bin/sh\necho attributed\n");

    // a second edit against the pre-edit hash is a conflict, not an overwrite
    const stale = await executeArchestraTool(
      TOOL_EDIT_PLUGIN_FULL_NAME,
      {
        id: plugin.id,
        baseContentHash: plugin.contentHash,
        path: "hooks/hooks.json",
        edits: [{ old_str: "UserPromptSubmit", new_str: "Stop" }],
      },
      context,
    );
    expect(stale.isError).toBe(true);
    expect(textOf(stale)).toContain("changed since you read it");
  });

  test("edit_plugin refuses a GitHub-sourced plugin", async () => {
    const plugin = await PluginModel.create({
      organizationId,
      userId: adminUserId,
      input: pluginPayload(),
      source: {
        repo: "acme/policy-hooks",
        ref: "main",
        sha: "b".repeat(40),
        subdir: "",
        exclude: [],
      },
    });
    if (!plugin) throw new Error("seed plugin creation failed");

    const result = await executeArchestraTool(
      TOOL_EDIT_PLUGIN_FULL_NAME,
      {
        id: plugin.id,
        baseContentHash: plugin.contentHash,
        path: "hooks/hooks.json",
        edits: [{ old_str: "SessionStart", new_str: "Stop" }],
      },
      context,
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("read-only");
  });

  test("edit_plugin enforces the aggregate plugin byte limit", async () => {
    const files = Array.from({ length: 7 }, (_, index) => ({
      path: `assets/${index}.txt`,
      content: "x".repeat(
        index < 6
          ? PLUGIN_MAX_FILE_BYTES
          : PLUGIN_MAX_TOTAL_BYTES - 6 * PLUGIN_MAX_FILE_BYTES - 1,
      ),
      encoding: "utf8" as const,
      mode: "100644" as const,
    }));
    const created = await executeArchestraTool(
      TOOL_CREATE_PLUGIN_FULL_NAME,
      pluginPayload({ displayName: "Large plugin", files }),
      context,
    );
    expect(created.isError).toBeFalsy();
    const pluginId = (created.structuredContent as { id: string }).id;
    const plugin = await PluginModel.findById({ id: pluginId, organizationId });
    if (!plugin) throw new Error("created plugin missing");

    const result = await executeArchestraTool(
      TOOL_EDIT_PLUGIN_FULL_NAME,
      {
        id: plugin.id,
        baseContentHash: plugin.contentHash,
        path: "assets/6.txt",
        replacementContent: "y".repeat(PLUGIN_MAX_FILE_BYTES),
      },
      context,
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Plugin exceeds");
  });

  test("delete_plugin removes the plugin from the catalog", async () => {
    const plugin = await seedPlugin();

    const deleted = await executeArchestraTool(
      TOOL_DELETE_PLUGIN_FULL_NAME,
      { id: plugin.id },
      context,
    );
    expect(deleted.isError).toBeFalsy();

    const list = await executeArchestraTool(
      TOOL_LIST_PLUGINS_FULL_NAME,
      {},
      context,
    );
    expect(textOf(list)).not.toContain("Session attribution");

    const detail = await executeArchestraTool(
      TOOL_GET_PLUGIN_FULL_NAME,
      { id: plugin.id },
      context,
    );
    expect(detail.isError).toBe(true);
  });

  test("mutations write plugin audit rows", async () => {
    const created = await executeArchestraTool(
      TOOL_CREATE_PLUGIN_FULL_NAME,
      pluginPayload(),
      context,
    );
    const pluginId = (created.structuredContent as { id: string }).id;

    await executeArchestraTool(
      TOOL_UPDATE_PLUGIN_FULL_NAME,
      { id: pluginId, displayName: "Audited rename" },
      context,
    );
    await executeArchestraTool(
      TOOL_DELETE_PLUGIN_FULL_NAME,
      { id: pluginId },
      context,
    );

    const createdRows = await findAuditRows("plugin.created");
    expect(createdRows.at(-1)).toMatchObject({
      resourceId: pluginId,
      outcome: "success",
      httpPath: `mcp-tool:${TOOL_CREATE_PLUGIN_FULL_NAME}`,
    });
    const updatedRows = await findAuditRows("plugin.updated");
    expect(updatedRows.at(-1)).toMatchObject({
      resourceId: pluginId,
      outcome: "success",
    });
    expect(updatedRows.at(-1)?.before).toMatchObject({
      displayName: "Session attribution",
    });
    expect(updatedRows.at(-1)?.after).toMatchObject({
      displayName: "Audited rename",
    });
    const deletedRows = await findAuditRows("plugin.deleted");
    expect(deletedRows.at(-1)).toMatchObject({
      resourceId: pluginId,
      outcome: "success",
    });
    // a plugin audit snapshot carries file digests, never file bytes
    const snapshot = updatedRows.at(-1)?.before as {
      files?: Array<Record<string, unknown>>;
    };
    expect(snapshot.files?.length).toBeGreaterThan(0);
    expect(snapshot.files?.[0]).not.toHaveProperty("content");
  });
});
