import {
  TOOL_CREATE_SKILL_SHORT_NAME,
  TOOL_EDIT_SKILL_SHORT_NAME,
  TOOL_LIST_SKILLS_SHORT_NAME,
  TOOL_LOAD_SKILL_SHORT_NAME,
  TOOL_UPDATE_SKILL_SHORT_NAME,
} from "@archestra/shared";
import { z } from "zod";
import {
  getSkillPermissionChecker,
  requireSkillModifyPermission,
} from "@/auth/skill-permissions";
import logger from "@/logging";
import {
  SkillModel,
  SkillTeamModel,
  SkillVersionModel,
  TeamModel,
} from "@/models";
import {
  MAX_FILES_PER_SKILL,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FILE_CONTENT_CHARS,
} from "@/skills/github-import";
import { parseSkillManifest, SkillParseError } from "@/skills/parser";
import {
  buildSkillActivationPromptContext,
  escapeXmlAttr,
  formatSkillActivation,
  neutralizeFrameTags,
} from "@/skills/skill-activation";
import { buildSkillCatalogPrompt } from "@/skills/skill-catalog-prompt";
import { isSkillSandboxAvailableForAgent } from "@/skills/skill-sandbox-availability";
import { resolveActivationVersion } from "@/skills/skill-version-resolution";
import {
  isSkillNameConflict,
  refineUniqueFilePaths,
  SkillFileInputSchema,
  SkillManifestContentSchema,
  toSkillFiles,
  toSkillInsertFields,
} from "@/skills/validation";
import {
  ApiError,
  type InsertSkillFile,
  type Skill,
  type SkillVersion,
} from "@/types";
import { archestraMcpBranding } from "./branding";
import {
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
  structuredToolErrorResult,
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
 * Agent Skills chat tools.
 *
 * `list_skills` and `load_skill` implement the progressive-disclosure tiers of
 * the Agent Skills spec: `list_skills` returns the catalog, `load_skill` with a
 * name returns that skill's SKILL.md body and bundled-file list, and `load_skill`
 * with a name + path returns one bundled resource file. Touching a skill through
 * either `load_skill` mode also mounts it into the conversation's code sandbox
 * (when the sandbox feature + `sandbox:execute` are present), so its scripts
 * become runnable under `/skills` via `run_command`.
 *
 * `create_skill` and `update_skill` let an agent author skills during a
 * conversation. Chat-authored skills are always `personal` to their author;
 * sharing a skill with a team or the whole org stays a deliberate action in
 * the Skills UI. `update_skill` re-checks the target skill's scope so a user
 * cannot edit a skill they only have read access to.
 *
 * Model-facing text in this file follows the skill terminology glossary in
 * `skills/skill-activation.ts` and is pinned by `skill-tool-text.test.ts`.
 *
 * @see https://agentskills.io/specification
 */

const ListSkillsSchema = z.object({});

const LoadSkillSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .describe("The skill to load, as named by list_skills."),
  path: z
    .string()
    .trim()
    .optional()
    .describe(
      "Optional. Omit (or pass an empty string) to load the skill's " +
        "instructions and bundled-file list. Pass a resource path from that " +
        "list (e.g. references/REFERENCE.md) to read one bundled file instead.",
    ),
});

const CreateSkillSchema = z
  .object({
    content: SkillManifestContentSchema,
    files: z
      .array(SkillFileInputSchema)
      .max(MAX_FILES_PER_SKILL)
      .optional()
      .describe(
        "Optional bundled resource files. Each is `{ path, content }` with " +
          "text content; the path prefix classifies the file — `references/` " +
          "for docs, `scripts/` for code, `assets/` for other files.",
      ),
  })
  .strict()
  .superRefine((data, ctx) => refineUniqueFilePaths(data.files, ctx));

const UpdateSkillSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .describe(
        "The current name of the skill to update, as named by list_skills.",
      ),
    content: SkillManifestContentSchema,
    files: z
      .array(SkillFileInputSchema)
      .max(MAX_FILES_PER_SKILL)
      .optional()
      .describe(
        "Optional. WHEN PROVIDED, REPLACES THE SKILL'S ENTIRE bundled file " +
          "set. Omit it to leave the existing resource files untouched. There " +
          "is no per-file patch: to change one file you must resend all of " +
          "them — read the current files back first with load_skill (with and " +
          "without a path).",
      ),
  })
  .strict()
  .superRefine((data, ctx) => refineUniqueFilePaths(data.files, ctx));

const EditSkillSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .describe(
        "The current name of the skill to edit, as named by list_skills.",
      ),
    baseVersion: z
      .number()
      .int()
      .positive()
      .describe(
        "The version the edit is based on — the `version` shown on the " +
          "<skill_content>/<skill_file> frame you loaded with load_skill. The " +
          "edit is rejected if the skill's head has moved past it.",
      ),
    path: z
      .string()
      .trim()
      .optional()
      .describe(
        "Omit (or pass an empty string) to edit the SKILL.md body; pass a " +
          "bundled file path (from the <skill_resources> list) to edit that " +
          "file instead. Only text (utf8) files are editable — binary assets " +
          "are not.",
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
        "str_replace edits applied in order to the target; the whole edit is " +
          "atomic (any failure leaves the skill unchanged). This is the way to " +
          "change a large SKILL.md without resending it all. Pass either edits " +
          "or replacementContent, never both.",
      ),
    replacementContent: z
      .string()
      .optional()
      .describe(
        "The complete new content of the target, replacing it outright with no " +
          "old_str matching — use it for a small file or a full rewrite. Prefer " +
          "edits for the SKILL.md body so you don't resend the whole thing. Pass " +
          "either edits or replacementContent, never both.",
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
          "`replacementContent` (whole-target rewrite).",
      });
    }
  });

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_LIST_SKILLS_SHORT_NAME,
    title: "List Skills",
    description:
      "List the Agent Skills available in this organization — one line per " +
      "skill (name and description). Call load_skill with a skill name " +
      "to load its full instructions.",
    schema: ListSkillsSchema,
    async handler({ context }) {
      const ctx = requireOrgContext(context);
      if (!ctx) {
        return errorResult("This tool requires an organization context.");
      }

      return listSkillCatalog(ctx, context.agent.id);
    },
  }),
  defineArchestraTool({
    shortName: TOOL_LOAD_SKILL_SHORT_NAME,
    title: "Load Skill",
    // a static tool description can't know whether the sandbox tools are
    // enabled, permitted, and assigned to the calling agent, so it does not
    // mention them. The load_skill *result* adds an agent-aware sandbox hint
    // (see formatSkillActivation) only when they are genuinely available.
    description:
      "Load a specialized Agent Skill — a reusable SKILL.md instruction set. " +
      "Call list_skills first to discover what is available. Call load_skill " +
      "with just a name to load the skill's instructions and its bundled-file " +
      "list; load it before attempting the task it covers. Call it with a name " +
      "and a path from that list to read one bundled file.",
    schema: LoadSkillSchema,
    async handler({ args, context }) {
      const ctx = requireOrgContext(context);
      if (!ctx) {
        return errorResult("This tool requires an organization context.");
      }

      const skill = await findAccessibleSkill(ctx, args.name);
      if (!skill) {
        return unknownSkillError(args.name);
      }

      const canRunSandbox = await canRunSkillSandbox(ctx, context.agent.id);

      // Both modes resolve the same way: pin the effective version and, when the
      // sandbox is usable, mount it under /skills. Mounting on a file read too is
      // intentional — touching a skill loads it, so the model can never read a
      // resource without the skill becoming runnable. Idempotent per skill per
      // sandbox; gated by sandbox:execute and fails closed without a user.
      const activation = await resolveActivationVersion({
        skill,
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        conversationId: context.conversationId,
        isolationKey: context.isolationKey,
        canRunSandbox,
      });
      if (!activation) {
        return errorResult(`Skill "${skill.name}" has no readable version.`);
      }
      const { version, mounted } = activation;

      // Models express "no path" as both an omitted field and an empty string;
      // a trimmed-empty path means list, not a (failing) read of "".
      if (args.path !== undefined && args.path !== "") {
        return readSkillFile({ skill, version, path: args.path });
      }

      const files = await SkillVersionModel.findFiles(version.id);
      logger.info(
        {
          organizationId: ctx.organizationId,
          skillName: skill.name,
          version: version.version,
          mounted,
          fileCount: files.length,
        },
        "[Skills] Skill loaded",
      );

      return successResult(
        formatSkillActivation({
          skill: {
            name: skill.name,
            content: version.content,
            compatibility: skill.compatibility,
            allowedTools: skill.allowedTools,
            templated: skill.templated,
          },
          version: version.version,
          files,
          // only advertise sandbox runnability when this skill's bytes are
          // actually mounted under /skills/<name> (not when a same-named skill
          // won the path).
          canRunSandbox: mounted,
          promptContext: skill.templated
            ? await buildSkillActivationPromptContext({
                userId: ctx.userId,
                organizationId: ctx.organizationId,
              })
            : null,
        }),
      );
    },
  }),
  defineArchestraTool({
    shortName: TOOL_CREATE_SKILL_SHORT_NAME,
    title: "Create Skill",
    description:
      "Create a new Agent Skill from a SKILL.md manifest. The skill is " +
      "created as a personal skill owned by you, available via list_skills " +
      "and as a chat slash-command. Draft the SKILL.md (and any bundled " +
      "resource files) with the user, then call this to persist it. To " +
      "share a skill with a team or the whole organization, change its " +
      "scope in the Skills UI.",
    schema: CreateSkillSchema,
    async handler({ args, context }) {
      const ctx = requireUserContext(context);
      if (!ctx) {
        return errorResult("This tool requires an authenticated user session.");
      }

      const parsed = parseManifest(args.content);
      if (parsed instanceof SkillParseError) {
        return errorResult(parsed.message);
      }

      // chat-authored skills are personal to their author; sharing them with a
      // team or the org stays a deliberate action in the Skills UI. A personal
      // skill owned by its author needs no further scope authorization beyond
      // the skill:create permission already enforced on this tool.
      const skill = await SkillModel.createWithFiles({
        skill: {
          ...toSkillInsertFields(parsed),
          organizationId: ctx.organizationId,
          authorId: ctx.userId,
          sourceType: "manual",
          scope: "personal",
        },
        files: toSkillFiles(args.files ?? []),
      });
      if (!skill) {
        return errorResult(`A skill named "${parsed.name}" already exists.`);
      }

      return successResult(
        `Created skill "${skill.name}". It is a personal skill, now ` +
          "available to you via list_skills and as a chat slash-command.",
      );
    },
  }),
  defineArchestraTool({
    shortName: TOOL_UPDATE_SKILL_SHORT_NAME,
    title: "Update Skill",
    description:
      "Update an existing Agent Skill from a SKILL.md manifest. Passing " +
      "`files` replaces the skill's entire bundled file set; omit it to edit " +
      "only the SKILL.md. The manifest's `name` may differ from the target " +
      "to rename the skill. For a small change to a large skill, prefer " +
      "edit_skill (targeted str_replace) over resending the whole manifest. " +
      "You can only update skills you are allowed to manage; the skill keeps " +
      "its current visibility scope.",
    schema: UpdateSkillSchema,
    async handler({ args, context }) {
      const ctx = requireUserContext(context);
      if (!ctx) {
        return errorResult("This tool requires an authenticated user session.");
      }

      const skill = await findAccessibleSkill(ctx, args.name);
      if (!skill) {
        return unknownSkillError(args.name);
      }

      // read access (findAccessibleSkill) is not enough to modify a skill —
      // enforce the scope-based manage permission, same as PUT /api/skills/:id.
      const denied = await checkSkillModifyPermission(ctx, skill);
      if (denied) {
        return errorResult(denied);
      }

      const parsed = parseManifest(args.content);
      if (parsed instanceof SkillParseError) {
        return errorResult(parsed.message);
      }

      let updated: Skill | null;
      try {
        updated = await SkillModel.updateWithFiles({
          id: skill.id,
          skill: {
            ...toSkillInsertFields(parsed),
            scope: skill.scope,
          },
          files:
            args.files === undefined ? undefined : toSkillFiles(args.files),
        });
      } catch (error) {
        if (isSkillNameConflict(error)) {
          return errorResult(`A skill named "${parsed.name}" already exists.`);
        }
        throw error;
      }
      if (!updated) {
        return errorResult(`No skill named "${args.name}" exists.`);
      }

      return successResult(`Updated skill "${updated.name}".`);
    },
  }),
  defineArchestraTool({
    shortName: TOOL_EDIT_SKILL_SHORT_NAME,
    title: "Edit Skill",
    description:
      "Make a targeted edit to an existing Agent Skill without resending the " +
      "whole SKILL.md. Load the skill first with load_skill, then pass str_replace " +
      "`edits` (or `replacementContent` for a small file) against the `version` " +
      "shown on the loaded frame as `baseVersion`. Omit `path` to edit the SKILL.md " +
      "body, or pass a bundled file's path to edit that file. Prefer this over " +
      "update_skill for changes to a large skill. You can only edit skills you are " +
      "allowed to manage; the skill keeps its current visibility scope.",
    schema: EditSkillSchema,
    async handler({ args, context }) {
      const ctx = requireUserContext(context);
      if (!ctx) {
        return errorResult("This tool requires an authenticated user session.");
      }

      const skill = await findAccessibleSkill(ctx, args.name);
      if (!skill) {
        return unknownSkillError(args.name);
      }

      const denied = await checkSkillModifyPermission(ctx, skill);
      if (denied) {
        return errorResult(denied);
      }

      const loadSkillName = archestraMcpBranding.getToolName(
        TOOL_LOAD_SKILL_SHORT_NAME,
      );

      // Edits apply to the bytes of the loaded version. Versions are immutable,
      // so this snapshot equals the locked head whenever the CAS below passes; a
      // base that has been superseded fails the CAS and writes nothing.
      const base = await SkillVersionModel.findBySkillAndVersion(
        skill.id,
        args.baseVersion,
      );
      if (!base) {
        return errorResult(
          `Skill "${skill.name}" has no version ${args.baseVersion}. Reload it with ${loadSkillName} to get the current version.`,
        );
      }

      // A path of "" or "SKILL.md" means the manifest body, not a bundled file.
      const targetPath =
        args.path !== undefined && args.path !== "" && args.path !== "SKILL.md"
          ? args.path
          : null;

      let targetContent: string;
      if (targetPath !== null) {
        const file = await SkillVersionModel.findFileByPath(
          base.id,
          targetPath,
        );
        if (!file) {
          return errorResult(
            `Skill "${skill.name}" has no file at "${targetPath}" in version ${args.baseVersion}. Check the <skill_resources> list from ${loadSkillName} (called without a path).`,
          );
        }
        if (file.encoding !== "utf8") {
          return errorResult(
            `Skill "${skill.name}" file "${targetPath}" is a binary asset and cannot be edited as text.`,
          );
        }
        targetContent = file.content;
      } else if (skill.templated) {
        // load_skill renders a templated body through Handlebars, so what the
        // model saw is not the stored template — a str_replace against it would
        // mismatch. Route templated-body changes through update_skill instead.
        const updateSkillName = archestraMcpBranding.getToolName(
          TOOL_UPDATE_SKILL_SHORT_NAME,
        );
        return errorResult(
          `Skill "${skill.name}" has a templated SKILL.md body (rendered when loaded), so its body cannot be edited by str_replace. Use ${updateSkillName} to change it. Bundled files can still be edited here.`,
        );
      } else {
        targetContent = base.content;
      }

      const sourceNoun = targetPath ?? "SKILL.md";
      let newTargetContent: string;
      let editSpans: AppliedEditSpan[] = [];
      let skippedEdits: SkippedEdit[] = [];
      try {
        if (args.replacementContent !== undefined) {
          newTargetContent = args.replacementContent;
        } else {
          const applied = applyStrReplaceEdits(
            targetContent,
            args.edits ?? [],
            {
              sourceNoun,
              rereadHint: `Reload the skill with ${loadSkillName}.`,
            },
          );
          newTargetContent = applied.content;
          editSpans = applied.spans;
          skippedEdits = applied.skipped;
        }
      } catch (error) {
        if (error instanceof ApiError) return errorResult(error.message);
        throw error;
      }

      // Enforce the same size caps create_skill/update_skill apply via their
      // input schemas — the edit ops bypass those schemas, so guard the result.
      const maxChars =
        targetPath !== null
          ? MAX_SKILL_FILE_CONTENT_CHARS
          : MAX_SKILL_FILE_BYTES;
      if (newTargetContent.length > maxChars) {
        return errorResult(
          `The edit would make ${sourceNoun} exceed the ${maxChars}-character limit. Trim it or split it into smaller files.`,
        );
      }

      // Materialize the edit into the existing update path. edit_skill changes
      // instructional content only — the stored `content` is the frontmatter-
      // stripped body and the model never sees frontmatter here, so metadata
      // columns (name, description, scope, …) are left untouched; renames and
      // metadata changes stay on update_skill. A body edit sets the new body and
      // leaves files untouched (the CAS guarantees head === base, so the head's
      // files are the base's); a file edit keeps the body and rebuilds the full
      // set with the one target replaced.
      let files: Omit<InsertSkillFile, "skillId">[] | undefined;
      if (targetPath !== null) {
        const baseFiles = await SkillVersionModel.findFiles(base.id);
        files = baseFiles.map((f) => ({
          path: f.path,
          content: f.path === targetPath ? newTargetContent : f.content,
          encoding: f.encoding,
          kind: f.kind,
        }));
      }

      let updated: Skill | null;
      try {
        updated = await SkillModel.updateWithFiles({
          id: skill.id,
          // Set the content column even for a file edit (idempotent) so the
          // update always has a value to write.
          skill: {
            content: targetPath !== null ? base.content : newTargetContent,
          },
          files,
          expectedLatestVersion: args.baseVersion,
        });
      } catch (error) {
        if (error instanceof ApiError) return errorResult(error.message);
        throw error;
      }
      if (!updated) {
        return errorResult(`No skill named "${args.name}" exists.`);
      }

      const targetLabel =
        targetPath !== null ? `file "${targetPath}"` : "SKILL.md";
      // Skipped no-op sub-edits don't count as applied.
      const appliedEditCount =
        args.edits !== undefined ? args.edits.length - skippedEdits.length : 0;
      const editLabel =
        args.replacementContent !== undefined
          ? "a full replacement"
          : `${appliedEditCount} edit${appliedEditCount === 1 ? "" : "s"}`;
      // A fork bumps latestVersion off baseVersion (the CAS guaranteed they were
      // equal); when they stay equal the edit netted back to the head bytes and
      // content-hash suppression created no new version — say so plainly.
      const forked = updated.latestVersion !== args.baseVersion;
      const summary = forked
        ? `Applied ${editLabel} to ${targetLabel} of skill "${updated.name}" (now at version ${updated.latestVersion}).`
        : args.edits !== undefined && appliedEditCount === 0
          ? `No edits were applied to skill "${updated.name}" — every edit was skipped; it stays at version ${updated.latestVersion} and no new version was created.`
          : `Applied ${editLabel} to ${targetLabel} of skill "${updated.name}", but the result is byte-identical to version ${updated.latestVersion}; no new version was created.`;
      const skippedNote = formatSkippedEditsNote(skippedEdits);
      const excerptsNote =
        args.edits !== undefined && forked
          ? buildAppliedEditExcerpts(newTargetContent, editSpans)
          : "";
      return successResult(`${summary}${skippedNote}${excerptsNote}`);
    },
  }),
] as const);

// ===== Internal helpers =====

// recovery errors steer the model by a tool's exposed (branded) name, so a
// white-label org receives a name the model can actually call back.
function unknownSkillError(skillName: string) {
  const listSkillsName = archestraMcpBranding.getToolName(
    TOOL_LIST_SKILLS_SHORT_NAME,
  );
  return structuredToolErrorResult({
    error: {
      type: "tool_state",
      code: "unknown_skill",
      message: `No skill named "${skillName}" exists. Call ${listSkillsName} to see available skills.`,
    },
  });
}

// Render one bundled file from an already-resolved skill version into the
// `<skill_file>` frame. The version is the same one load_skill pinned/mounted, so
// the bytes match activation and the sandbox.
async function readSkillFile(params: {
  skill: Pick<Skill, "name">;
  version: Pick<SkillVersion, "id" | "version">;
  path: string;
}) {
  const { skill, version, path } = params;
  const file = await SkillVersionModel.findFileByPath(version.id, path);
  if (!file) {
    const loadSkillName = archestraMcpBranding.getToolName(
      TOOL_LOAD_SKILL_SHORT_NAME,
    );
    return structuredToolErrorResult({
      error: {
        type: "tool_state",
        code: "unknown_skill_file",
        message: `Skill "${skill.name}" has no file at "${path}". Check the <skill_resources> list returned by ${loadSkillName} (called without a path) for the available file paths.`,
      },
    });
  }

  if (file.encoding === "base64") {
    const approxKb = Math.round((file.content.length * 3) / 4 / 1024);
    return successResult(
      `<skill_file skill="${escapeXmlAttr(skill.name)}" path="${escapeXmlAttr(file.path)}" version="${version.version}" encoding="base64">\n` +
        `This is a binary asset (~${approxKb} KB) and cannot be read as ` +
        "text. It is bundled with the skill for redistribution, not for " +
        "inline use by the model.\n</skill_file>",
    );
  }

  return successResult(
    `<skill_file skill="${escapeXmlAttr(skill.name)}" path="${escapeXmlAttr(file.path)}" version="${version.version}">\n${neutralizeFrameTags(file.content)}\n</skill_file>`,
  );
}

interface UserContext {
  organizationId: string;
  userId: string;
}

/**
 * Context for read-only skill tools. `userId` is absent for org/team-token
 * sessions, which can see only org-scoped skills.
 */
interface SkillReadContext {
  organizationId: string;
  userId?: string;
}

/** A skill write tool needs both an org and a user to enforce scope. */
function requireUserContext(context: ArchestraContext): UserContext | null {
  if (!context.organizationId || !context.userId) return null;
  return { organizationId: context.organizationId, userId: context.userId };
}

/** A skill read tool needs an org; a user is optional (org-token sessions). */
function requireOrgContext(context: ArchestraContext): SkillReadContext | null {
  if (!context.organizationId) return null;
  return { organizationId: context.organizationId, userId: context.userId };
}

/** `isSkillSandboxAvailableForAgent` for callers that only hold a read context. */
async function canRunSkillSandbox(
  ctx: SkillReadContext,
  agentId: string | undefined,
): Promise<boolean> {
  return isSkillSandboxAvailableForAgent({
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    agentId,
  });
}

/**
 * Look up a skill by name and return the one the caller can access. Name
 * uniqueness is per-scope, so a name can resolve to several rows (the caller's
 * own personal skill plus a team/org skill of the same name); we keep only the
 * accessible ones and break ties by scope precedence — a caller's own
 * `personal` skill shadows a `team` one, which shadows `org`. Returns null when
 * none are accessible, so callers surface a generic "no skill named …" without
 * leaking an inaccessible skill's existence.
 */
async function findAccessibleSkill(ctx: SkillReadContext, name: string) {
  const candidates = await SkillModel.findAllByName(ctx.organizationId, name);
  if (candidates.length === 0) return null;

  const isSkillAdmin =
    ctx.userId !== undefined &&
    (
      await getSkillPermissionChecker({
        userId: ctx.userId,
        organizationId: ctx.organizationId,
      })
    ).isAdmin;

  const accessible: Skill[] = [];
  for (const skill of candidates) {
    const hasAccess = await SkillTeamModel.userHasSkillAccess({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      skill,
      isSkillAdmin,
    });
    if (hasAccess) accessible.push(skill);
  }
  if (accessible.length === 0) return null;

  accessible.sort(
    (a, b) => scopePrecedence(a, ctx.userId) - scopePrecedence(b, ctx.userId),
  );
  return accessible[0];
}

/**
 * Lower wins: a caller's *own* personal skill shadows a shared one of the same
 * name. A personal skill authored by someone else (visible only because the
 * caller is a skill-admin) must never shadow a shared skill, so it ranks last.
 */
function scopePrecedence(
  skill: Pick<Skill, "scope" | "authorId">,
  userId: string | undefined,
): number {
  switch (skill.scope) {
    case "personal":
      return skill.authorId === userId ? 0 : 3;
    case "team":
      return 1;
    case "org":
      return 2;
    default:
      return 4;
  }
}

/**
 * Enforce scope-based modify permission on an already-accessible skill.
 * Returns an error message if the user may not manage it, or null if allowed.
 */
async function checkSkillModifyPermission(
  ctx: UserContext,
  skill: Skill,
): Promise<string | null> {
  const checker = await getSkillPermissionChecker(ctx);
  const userTeamIds = checker.isAdmin
    ? []
    : await TeamModel.getUserTeamIds(ctx.userId);
  const skillTeamIds = await SkillTeamModel.getTeamsForSkill(skill.id);
  try {
    requireSkillModifyPermission({
      checker,
      scope: skill.scope,
      authorId: skill.authorId,
      skillTeamIds,
      userTeamIds,
      userId: ctx.userId,
    });
    return null;
  } catch (error) {
    if (error instanceof ApiError) return error.message;
    throw error;
  }
}

/** Parse a SKILL.md manifest, returning the parse error instead of throwing. */
function parseManifest(raw: string) {
  try {
    return parseSkillManifest(raw);
  } catch (error) {
    if (error instanceof SkillParseError) return error;
    throw error;
  }
}

async function listSkillCatalog(
  ctx: SkillReadContext,
  agentId: string | undefined,
) {
  const catalog = await buildSkillCatalogPrompt({
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    agentId,
  });
  if (catalog === null) {
    return successResult(
      "No skills are available in this organization. Skills can be added under Agents → Skills.",
    );
  }
  return successResult(catalog);
}

export const toolEntries = registry.toolEntries;
export const tools = registry.tools;
