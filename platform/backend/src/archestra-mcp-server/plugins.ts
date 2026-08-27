import {
  ResourceVisibilityScopeSchema,
  TOOL_CREATE_PLUGIN_SHORT_NAME,
  TOOL_DELETE_PLUGIN_SHORT_NAME,
  TOOL_EDIT_PLUGIN_SHORT_NAME,
  TOOL_GET_PLUGIN_SHORT_NAME,
  TOOL_LIST_PLUGINS_SHORT_NAME,
  TOOL_UPDATE_PLUGIN_SHORT_NAME,
} from "@archestra/shared";
import { z } from "zod";
import { userHasPermission } from "@/auth";
import config from "@/config";
import { PluginModel, PluginTeamModel } from "@/models";
import { validatePluginVisibility } from "@/services/plugin-visibility";
import {
  ApiError,
  ClientTypeSchema,
  PLUGIN_MAX_FILES,
  type PluginFileInput,
  PluginFileInputSchema,
  PluginFileSetSchema,
  PluginPlatformSchema,
  type PluginWithFiles,
  UuidIdSchema,
  validateFileSet,
} from "@/types";
import {
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
  structuredSuccessResult,
  successResult,
} from "./helpers";
import {
  type AppliedEditSpan,
  applyStrReplaceEdits,
  buildAppliedEditExcerpts,
  formatSkippedEditsNote,
  type SkippedEdit,
} from "./str-replace-edits";
import type { ArchestraContext } from "./types";

/**
 * Plugin management chat tools, mirroring the skill management tools.
 *
 * Plugins are client-native executable payloads (hooks, skills, scripts), so
 * the permission split is stricter than skills: `list_plugins` needs only
 * plugin:read and returns catalog metadata, while everything that touches
 * file bytes — `get_plugin`, and every mutation — requires plugin:admin,
 * matching the REST routes. GitHub-sourced plugin bytes stay read-only here,
 * exactly as in the UI: source updates go through the review-and-approve
 * flow, which is deliberately not reproduced in chat.
 *
 * The whole group follows the `plugins` deployment beta flag: tools are
 * filtered from the advertised surface when it is off, and every handler
 * re-checks it (a previously assigned tool can still be dispatched directly).
 */

const ListPluginsSchema = z.object({});

const GetPluginSchema = z.object({
  id: UuidIdSchema.describe("The plugin id, as listed by list_plugins."),
});

const pluginFilesField = z
  .array(PluginFileInputSchema)
  .min(1)
  .max(PLUGIN_MAX_FILES);

const CreatePluginToolSchema = z
  .object({
    displayName: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .describe("Human-readable plugin name."),
    description: z
      .string()
      .max(1_000)
      .default("")
      .describe("What the plugin does."),
    clientType: ClientTypeSchema.describe(
      "The coding client the payload targets: claude-code, codex, copilot-cli, or cursor.",
    ),
    supportedPlatforms: z
      .array(PluginPlatformSchema)
      .min(1)
      .default(["posix"])
      .describe("Operating systems the payload supports."),
    scope: ResourceVisibilityScopeSchema.default("personal").describe(
      "Who can discover the plugin: personal (author plus named users), team, or org.",
    ),
    teamIds: z
      .array(z.string().min(1))
      .max(100)
      .optional()
      .describe("Teams a team-scoped plugin is shared with."),
    userIds: z
      .array(z.string().min(1))
      .max(100)
      .optional()
      .describe("Organization members a personal plugin is shared with."),
    files: pluginFilesField.describe(
      "The plugin's files as { path, content, encoding?, mode? }. Hook " +
        "configuration bytes are stored verbatim — review them as code, " +
        "they execute on developer machines.",
    ),
  })
  .strict()
  .superRefine((value, ctx) => validateFileSet(value, ctx));

const UpdatePluginToolSchema = z
  .object({
    id: UuidIdSchema.describe("The plugin id, as listed by list_plugins."),
    displayName: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional()
      .describe("Human-readable plugin name."),
    description: z
      .string()
      .max(1_000)
      .optional()
      .describe("What the plugin does."),
    enabled: z
      .boolean()
      .optional()
      .describe(
        "Disabled plugins are left out of future setup commands; already-installed copies are unaffected.",
      ),
    supportedPlatforms: z
      .array(PluginPlatformSchema)
      .min(1)
      .optional()
      .describe("Operating systems the payload supports."),
    scope: ResourceVisibilityScopeSchema.optional().describe(
      "Who can discover the plugin: personal (author plus named users), team, or org.",
    ),
    teamIds: z
      .array(z.string().min(1))
      .max(100)
      .optional()
      .describe("Teams a team-scoped plugin is shared with."),
    userIds: z
      .array(z.string().min(1))
      .max(100)
      .optional()
      .describe("Organization members a personal plugin is shared with."),
    baseContentHash: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Required when files is provided. Use the current contentHash from " +
          "get_plugin; the replacement is rejected if newer bytes landed first.",
      ),
    files: pluginFilesField
      .optional()
      .describe(
        "WHEN PROVIDED, REPLACES THE PLUGIN'S ENTIRE file set. Omit it to " +
          "edit only metadata/visibility. Manual plugins only — GitHub-sourced " +
          "files are read-only. For a small change to one file, prefer " +
          "edit_plugin over resending every file.",
      ),
  })
  .strict()
  .superRefine((value, ctx) => {
    const { id: _id, baseContentHash: _baseContentHash, ...changes } = value;
    if (Object.values(changes).every((field) => field === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "At least one field besides id is required",
      });
    }
    if (value.files && !value.baseContentHash) {
      ctx.addIssue({
        code: "custom",
        path: ["baseContentHash"],
        message: "baseContentHash is required when files is provided",
      });
    }
    validateFileSet(value, ctx);
  });

const EditPluginSchema = z
  .object({
    id: UuidIdSchema.describe("The plugin id, as listed by list_plugins."),
    baseContentHash: z
      .string()
      .min(1)
      .describe(
        "The plugin's current contentHash, as returned by get_plugin. The " +
          "edit is rejected when the plugin's bytes have moved past it.",
      ),
    path: z
      .string()
      .trim()
      .min(1)
      .describe(
        "The plugin file to edit, from the file list returned by get_plugin. " +
          "Only text (utf8) files are editable — binary files are not.",
      ),
    edits: z
      .array(
        z.strictObject({
          old_str: z
            .string()
            .min(1)
            .describe(
              "Exact text to replace; must occur exactly once in the target " +
                "(add surrounding context to disambiguate).",
            ),
          new_str: z
            .string()
            .describe("Replacement text (may be empty to delete)."),
        }),
      )
      .min(1)
      .optional()
      .describe(
        "str_replace edits applied in order to the target file; the whole " +
          "edit is atomic (any failure leaves the plugin unchanged). Pass " +
          "either edits or replacementContent, never both.",
      ),
    replacementContent: z
      .string()
      .optional()
      .describe(
        "The complete new content of the target file, replacing it outright " +
          "with no old_str matching. Pass either edits or " +
          "replacementContent, never both.",
      ),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (
      (data.edits !== undefined) ===
      (data.replacementContent !== undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Pass exactly one of `edits` (targeted str_replace) or " +
          "`replacementContent` (whole-file rewrite).",
      });
    }
  });

const DeletePluginSchema = z.object({
  id: UuidIdSchema.describe("The plugin id, as listed by list_plugins."),
});

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_LIST_PLUGINS_SHORT_NAME,
    title: "List Plugins",
    description:
      "List the plugins available to you in this organization — one line per " +
      "plugin with its id, client, platforms, visibility, and file count. " +
      "Call get_plugin with a plugin id to read its files (requires the " +
      "plugin admin permission).",
    schema: ListPluginsSchema,
    async handler({ context }) {
      const disabled = pluginsDisabledError();
      if (disabled) return disabled;
      const ctx = requireUserContext(context);
      if (!ctx) {
        return errorResult("This tool requires an authenticated user session.");
      }

      const isAdmin = await userHasPermission(
        ctx.userId,
        ctx.organizationId,
        "plugin",
        "admin",
      );
      const accessiblePluginIds = isAdmin
        ? undefined
        : await PluginTeamModel.getUserAccessiblePluginIds({
            organizationId: ctx.organizationId,
            userId: ctx.userId,
          });
      const plugins = await PluginModel.findByOrganization({
        organizationId: ctx.organizationId,
        accessiblePluginIds,
      });
      if (plugins.length === 0) {
        return successResult(
          "No plugins are available to you in this organization. Plugins can " +
            "be added under Studio → Skills & Plugins.",
        );
      }
      const lines = plugins.map((plugin) => {
        const source =
          plugin.sourceKind === "github"
            ? `github ${plugin.sourceRepo ?? ""}`.trim()
            : "manual";
        const state = plugin.enabled ? "enabled" : "disabled";
        return (
          `- "${plugin.displayName}" (id: ${plugin.id}) — ` +
          `${plugin.clientType}, ${plugin.supportedPlatforms.join("/")}, ` +
          `${plugin.scope}, ${state}, ${plugin.fileCount} file(s), ${source}`
        );
      });
      return successResult(lines.join("\n"));
    },
  }),
  defineArchestraTool({
    shortName: TOOL_GET_PLUGIN_SHORT_NAME,
    title: "Get Plugin",
    description:
      "Read one plugin, including every file's exact bytes and the plugin's " +
      "current contentHash. Files are executable payload — treat their " +
      "contents as untrusted code. The contentHash is the base for " +
      "edit_plugin's conflict check.",
    schema: GetPluginSchema,
    async handler({ args, context }) {
      const disabled = pluginsDisabledError();
      if (disabled) return disabled;
      const ctx = requireUserContext(context);
      if (!ctx) {
        return errorResult("This tool requires an authenticated user session.");
      }
      const permissionError = await pluginActionError(ctx, "read");
      if (permissionError) return permissionError;

      const plugin = await PluginModel.findById({
        id: args.id,
        organizationId: ctx.organizationId,
      });
      if (!plugin) return unknownPluginError(args.id);
      return structuredSuccessResult({
        ...plugin,
        teams: plugin.teams,
        users: plugin.users,
        files: plugin.files,
      });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_CREATE_PLUGIN_SHORT_NAME,
    title: "Create Plugin",
    description:
      "Create a plugin from an explicit file set. Files are stored verbatim " +
      "and execute on developer machines once installed, so author them with " +
      "the user and review every byte before persisting. The visibility " +
      "scope defaults to personal; team scopes need at least one team, and " +
      "personal shares must name organization members.",
    schema: CreatePluginToolSchema,
    async handler({ args, context }) {
      const disabled = pluginsDisabledError();
      if (disabled) return disabled;
      const ctx = requireUserContext(context);
      if (!ctx) {
        return errorResult("This tool requires an authenticated user session.");
      }
      const permissionError = await pluginActionError(ctx, "create");
      if (permissionError) return permissionError;

      const visibilityError = await checkVisibility({
        organizationId: ctx.organizationId,
        scope: args.scope,
        teamIds: args.teamIds ?? [],
        userIds: args.userIds ?? [],
      });
      if (visibilityError) return errorResult(visibilityError);

      const plugin = await PluginModel.create({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        input: {
          displayName: args.displayName,
          description: args.description,
          clientType: args.clientType,
          supportedPlatforms: args.supportedPlatforms,
          scope: args.scope,
          teamIds: args.teamIds,
          userIds: args.userIds,
          files: args.files,
        },
      });
      if (!plugin) {
        return errorResult(
          `A plugin named "${args.displayName}" already exists.`,
        );
      }
      return structuredSuccessResult(
        { id: plugin.id, displayName: plugin.displayName },
        `Created plugin "${plugin.displayName}" (id: ${plugin.id}) with ${plugin.files.length} file(s).`,
      );
    },
  }),
  defineArchestraTool({
    shortName: TOOL_UPDATE_PLUGIN_SHORT_NAME,
    title: "Update Plugin",
    description:
      "Update a plugin's metadata, visibility, or entire file set. Passing " +
      "`files` replaces every file — read the current set with get_plugin " +
      "first and pass its contentHash as `baseContentHash`; for a small " +
      "change to one file, prefer edit_plugin. " +
      "GitHub-sourced plugin files are read-only and stay managed through " +
      "the source review flow in the Plugins UI.",
    schema: UpdatePluginToolSchema,
    async handler({ args, context }) {
      const disabled = pluginsDisabledError();
      if (disabled) return disabled;
      const ctx = requireUserContext(context);
      if (!ctx) {
        return errorResult("This tool requires an authenticated user session.");
      }
      const permissionError = await pluginActionError(ctx, "update");
      if (permissionError) return permissionError;

      const existing = await PluginModel.findById({
        id: args.id,
        organizationId: ctx.organizationId,
      });
      if (!existing) return unknownPluginError(args.id);
      const githubFilesError = checkManualFilesUpdate(existing, args.files);
      if (githubFilesError) return errorResult(githubFilesError);

      const visibilityError = await checkVisibility({
        organizationId: ctx.organizationId,
        scope: args.scope ?? existing.scope,
        teamIds: args.teamIds ?? existing.teams.map((team) => team.id),
        userIds: args.userIds ?? existing.users.map((member) => member.id),
      });
      if (visibilityError) return errorResult(visibilityError);

      const { id, baseContentHash, ...input } = args;
      const plugin = await PluginModel.update({
        id,
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        input,
        expectedContentHash: args.files ? baseContentHash : undefined,
      });
      if (!plugin) {
        const stillThere = await PluginModel.findById({
          id: args.id,
          organizationId: ctx.organizationId,
        });
        if (!stillThere) return unknownPluginError(args.id);
        return errorResult(
          `Plugin "${existing.displayName}" changed since you read it ` +
            "(contentHash no longer matches baseContentHash). Read it again " +
            "with get_plugin and retry the replacement.",
        );
      }
      return successResult(
        `Updated plugin "${plugin.displayName}" (id: ${plugin.id}).`,
      );
    },
  }),
  defineArchestraTool({
    shortName: TOOL_EDIT_PLUGIN_SHORT_NAME,
    title: "Edit Plugin",
    description:
      "Make a targeted edit to one file of a plugin without resending the " +
      "whole file set. Read the plugin first with get_plugin, then pass " +
      "str_replace `edits` (or `replacementContent` for a full rewrite of " +
      "the file) against the plugin's current contentHash as " +
      "`baseContentHash`. The edit is rejected when the plugin changed since " +
      "you read it. Manual plugins only — GitHub-sourced files are read-only.",
    schema: EditPluginSchema,
    async handler({ args, context }) {
      const disabled = pluginsDisabledError();
      if (disabled) return disabled;
      const ctx = requireUserContext(context);
      if (!ctx) {
        return errorResult("This tool requires an authenticated user session.");
      }
      const permissionError = await pluginActionError(ctx, "update");
      if (permissionError) return permissionError;

      const plugin = await PluginModel.findById({
        id: args.id,
        organizationId: ctx.organizationId,
      });
      if (!plugin) return unknownPluginError(args.id);
      if (plugin.sourceKind === "github") {
        return errorResult(githubReadOnlyMessage(plugin));
      }

      const file = plugin.files.find(
        (candidate) => candidate.path === args.path,
      );
      if (!file) {
        const paths = plugin.files.map((candidate) => candidate.path);
        return errorResult(
          `Plugin "${plugin.displayName}" has no file at "${args.path}". ` +
            `Available files: ${paths.join(", ")}.`,
        );
      }
      if (file.encoding !== "utf8") {
        return errorResult(
          `Plugin "${plugin.displayName}" file "${args.path}" is a binary ` +
            "file and cannot be edited as text.",
        );
      }

      let newContent: string;
      let editSpans: AppliedEditSpan[] = [];
      let skippedEdits: SkippedEdit[] = [];
      try {
        if (args.replacementContent !== undefined) {
          newContent = args.replacementContent;
        } else {
          const applied = applyStrReplaceEdits(file.content, args.edits ?? [], {
            sourceNoun: args.path,
            rereadHint: "Reload the plugin with get_plugin.",
          });
          newContent = applied.content;
          editSpans = applied.spans;
          skippedEdits = applied.skipped;
        }
      } catch (error) {
        if (error instanceof ApiError) return errorResult(error.message);
        throw error;
      }

      const files: PluginFileInput[] = plugin.files.map((candidate) => ({
        path: candidate.path,
        content: candidate.path === args.path ? newContent : candidate.content,
        encoding: candidate.encoding,
        mode: candidate.mode,
      }));
      const validatedFiles = PluginFileSetSchema.safeParse({ files });
      if (!validatedFiles.success) {
        return errorResult(
          validatedFiles.error.issues[0]?.message ?? "Invalid file set",
        );
      }
      const updated = await PluginModel.update({
        id: plugin.id,
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        input: { files },
        expectedContentHash: args.baseContentHash,
      });
      if (!updated) {
        const stillThere = await PluginModel.findById({
          id: args.id,
          organizationId: ctx.organizationId,
        });
        if (!stillThere) return unknownPluginError(args.id);
        return errorResult(
          `Plugin "${plugin.displayName}" changed since you read it ` +
            `(contentHash no longer matches baseContentHash). Read it again ` +
            "with get_plugin and retry the edit.",
        );
      }

      const appliedEditCount =
        args.edits !== undefined ? args.edits.length - skippedEdits.length : 0;
      const editLabel =
        args.replacementContent !== undefined
          ? "a full replacement"
          : `${appliedEditCount} edit${appliedEditCount === 1 ? "" : "s"}`;
      const byteIdentical = updated.contentHash === args.baseContentHash;
      const summary =
        args.edits !== undefined && appliedEditCount === 0
          ? `No edits were applied to plugin "${updated.displayName}" — every edit was skipped; its files are unchanged.`
          : byteIdentical
            ? `Applied ${editLabel} to file "${args.path}" of plugin "${updated.displayName}", but the result is byte-identical to the current content; nothing changed.`
            : `Applied ${editLabel} to file "${args.path}" of plugin "${updated.displayName}".`;
      const skippedNote = formatSkippedEditsNote(skippedEdits);
      const excerptsNote =
        args.edits !== undefined && !byteIdentical
          ? buildAppliedEditExcerpts(newContent, editSpans)
          : "";
      return successResult(`${summary}${skippedNote}${excerptsNote}`);
    },
  }),
  defineArchestraTool({
    shortName: TOOL_DELETE_PLUGIN_SHORT_NAME,
    title: "Delete Plugin",
    description:
      "Delete a plugin. The plugin disappears from the catalog and future " +
      "setup commands, and its GitHub sync stops. Copies already installed " +
      "on developer machines are not removed.",
    schema: DeletePluginSchema,
    async handler({ args, context }) {
      const disabled = pluginsDisabledError();
      if (disabled) return disabled;
      const ctx = requireUserContext(context);
      if (!ctx) {
        return errorResult("This tool requires an authenticated user session.");
      }
      const permissionError = await pluginActionError(ctx, "delete");
      if (permissionError) return permissionError;

      const existing = await PluginModel.findById({
        id: args.id,
        organizationId: ctx.organizationId,
      });
      if (!existing) return unknownPluginError(args.id);
      const plugin = await PluginModel.delete({
        id: args.id,
        organizationId: ctx.organizationId,
      });
      if (!plugin) return unknownPluginError(args.id);
      return successResult(
        `Deleted plugin "${existing.displayName}" (id: ${existing.id}). It ` +
          "no longer appears in the catalog or future setup commands; " +
          "installed copies on developer machines are unaffected.",
      );
    },
  }),
] as const);

export const toolEntries = registry.toolEntries;
export const tools = registry.tools;

// ===== Internal helpers =====

interface UserContext {
  organizationId: string;
  userId: string;
}

/** Every plugin tool needs both an org and a user to authorize against. */
function requireUserContext(context: ArchestraContext): UserContext | null {
  if (!context.organizationId || !context.userId) return null;
  return { organizationId: context.organizationId, userId: context.userId };
}

/**
 * Defense in depth behind the tools/list filtering: a plugin tool can still
 * be dispatched directly (previously assigned, or called through run_tool),
 * so every handler re-checks the deployment flag.
 */
function pluginsDisabledError() {
  if (config.plugins.enabled) return null;
  return errorResult("Plugins are not enabled on this deployment.");
}

/**
 * TOOL_PERMISSIONS applies the plugin:admin floor. REST plugin routes also
 * require the action-specific permission, so handlers apply that second half
 * for custom roles that intentionally split approval from CRUD access.
 */
async function pluginActionError(
  ctx: UserContext,
  action: "read" | "create" | "update" | "delete",
) {
  const allowed = await userHasPermission(
    ctx.userId,
    ctx.organizationId,
    "plugin",
    action,
  );
  return allowed
    ? null
    : errorResult(`This tool also requires plugin:${action} permission.`);
}

function unknownPluginError(id: string) {
  return errorResult(`No plugin with id "${id}" exists.`);
}

/** A GitHub-sourced plugin's bytes are owned by its source repository. */
function githubReadOnlyMessage(
  plugin: Pick<PluginWithFiles, "displayName" | "sourceRepo">,
): string {
  return (
    `Plugin "${plugin.displayName}" is synced from GitHub` +
    (plugin.sourceRepo ? ` (${plugin.sourceRepo})` : "") +
    " and its files are read-only here. Tell the user to edit them in the " +
    "source repository, then review and apply the update in the Plugins UI."
  );
}

function checkManualFilesUpdate(
  plugin: Pick<PluginWithFiles, "displayName" | "sourceKind" | "sourceRepo">,
  files: PluginFileInput[] | undefined,
): string | null {
  if (files && plugin.sourceKind === "github") {
    return githubReadOnlyMessage(plugin);
  }
  return null;
}

async function checkVisibility(params: {
  organizationId: string;
  scope: "personal" | "team" | "org";
  teamIds: string[];
  userIds: string[];
}): Promise<string | null> {
  try {
    await validatePluginVisibility(params);
    return null;
  } catch (error) {
    if (error instanceof ApiError) return error.message;
    throw error;
  }
}
