import {
  TOOL_ACTIVATE_SKILL_SHORT_NAME,
  TOOL_CREATE_SKILL_SHORT_NAME,
  TOOL_LIST_SKILLS_SHORT_NAME,
  TOOL_READ_SKILL_FILE_SHORT_NAME,
  TOOL_UPDATE_SKILL_SHORT_NAME,
} from "@shared";
import { z } from "zod";
import {
  getSkillPermissionChecker,
  requireSkillModifyPermission,
} from "@/auth/skill-permissions";
import logger from "@/logging";
import {
  SkillFileModel,
  SkillModel,
  SkillTeamModel,
  TeamModel,
} from "@/models";
import {
  MAX_FILES_PER_SKILL,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FILE_CONTENT_CHARS,
} from "@/skills/github-import";
import {
  deriveSkillFileKind,
  parseSkillManifest,
  SkillParseError,
} from "@/skills/parser";
import {
  buildSkillActivationPromptContext,
  escapeXmlAttr,
  escapeXmlText,
  formatSkillActivation,
} from "@/skills/skill-activation";
import { isSkillSandboxAvailableForAgent } from "@/skills/skill-sandbox-availability";
import {
  isSkillNameConflict,
  refineUniqueFilePaths,
} from "@/skills/validation";
import { ApiError, type Skill, SkillFileEncodingSchema } from "@/types";
import {
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
  successResult,
} from "./helpers";
import type { ArchestraContext } from "./types";

/**
 * Agent Skills chat tools.
 *
 * `list_skills`, `activate_skill`, and `read_skill_file` implement the
 * progressive-disclosure tiers of the Agent Skills spec: `list_skills` returns
 * the catalog, `activate_skill` returns a named skill's SKILL.md body, and
 * bundled resource files are fetched individually via `read_skill_file`. To
 * execute a skill's scripts or shell commands, the sandbox tools
 * (`create_skill_sandbox`, `run_skill_command`, `get_skill_sandbox_artifact`)
 * materialize the selected skills into an isolated container and run commands
 * from the skill root.
 *
 * `create_skill` and `update_skill` let an agent author skills during a
 * conversation. Chat-authored skills are always `personal` to their author;
 * sharing a skill with a team or the whole org stays a deliberate action in
 * the Skills UI. `update_skill` re-checks the target skill's scope so a user
 * cannot edit a skill they only have read access to.
 *
 * @see https://agentskills.io/specification
 */

const ListSkillsSchema = z.object({});

const ActivateSkillSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .describe("The skill to load, as named by list_skills."),
});

const ReadSkillFileSchema = z.object({
  skill: z.string().describe("The skill that owns the file"),
  path: z
    .string()
    .describe("Resource path from the skill, e.g. references/REFERENCE.md"),
});

const SkillFileInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .refine(
      (p) => !p.startsWith("/") && !p.split("/").some((s) => s === ".."),
      {
        message:
          "path must be relative and must not contain directory traversal sequences",
      },
    )
    .describe("Resource path, e.g. references/API.md or scripts/run.py"),
  content: z
    .string()
    .max(MAX_SKILL_FILE_CONTENT_CHARS)
    .describe("Text content of the file"),
  encoding: SkillFileEncodingSchema.optional(),
});

// the SKILL.md body shared by create_skill and update_skill.
const manifestContentSchema = z
  .string()
  .min(1)
  .max(MAX_SKILL_FILE_BYTES)
  .describe(
    "A complete SKILL.md manifest: a YAML frontmatter block with `name` and " +
      "`description` (and optional `license`, `compatibility`, `allowed-tools`, " +
      "`templated`, `metadata`), followed by the Markdown instruction body. Set " +
      "`templated: true` to render the body through Handlebars (e.g. " +
      "`{{user.name}}`) at activation. `allowed-tools` is a space-separated " +
      "list of tools the skill is pre-approved to use.",
  );

const CreateSkillSchema = z
  .object({
    content: manifestContentSchema,
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
    content: manifestContentSchema,
    files: z
      .array(SkillFileInputSchema)
      .max(MAX_FILES_PER_SKILL)
      .optional()
      .describe(
        "Optional. WHEN PROVIDED, REPLACES THE SKILL'S ENTIRE bundled file " +
          "set. Omit it to leave the existing resource files untouched. There " +
          "is no per-file patch: to change one file you must resend all of " +
          "them — read the current files back first with activate_skill + " +
          "read_skill_file.",
      ),
  })
  .strict()
  .superRefine((data, ctx) => refineUniqueFilePaths(data.files, ctx));

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_LIST_SKILLS_SHORT_NAME,
    title: "List Skills",
    description:
      "List the Agent Skills available in this organization — one line per " +
      "skill (name and description). Call activate_skill with a skill name " +
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
    shortName: TOOL_ACTIVATE_SKILL_SHORT_NAME,
    title: "Activate Skill",
    // a static tool description can't know whether the sandbox tools are
    // enabled, permitted, and assigned to the calling agent, so it does not
    // mention them. The activate_skill *result* adds an agent-aware sandbox
    // hint (see formatSkillActivation) only when they are genuinely available.
    description:
      "Load a specialized Agent Skill — a reusable SKILL.md instruction set. " +
      "Call list_skills first to discover what is available, then call this " +
      "with a skill name to load its full instructions. Activate a skill " +
      "before attempting the task it covers. To inspect bundled resources " +
      "use read_skill_file.",
    schema: ActivateSkillSchema,
    async handler({ args, context }) {
      const ctx = requireOrgContext(context);
      if (!ctx) {
        return errorResult("This tool requires an organization context.");
      }

      const skill = await findAccessibleSkill(ctx, args.name);
      if (!skill) {
        return errorResult(
          `No skill named "${args.name}" exists. Call list_skills to see available skills.`,
        );
      }

      const files = await SkillFileModel.findBySkillId(skill.id);
      logger.info(
        {
          organizationId: ctx.organizationId,
          skillName: skill.name,
          fileCount: files.length,
        },
        "[Skills] Skill activated",
      );

      return successResult(
        formatSkillActivation({
          skill,
          files,
          canRunSandbox: await canRunSkillSandbox(ctx, context.agent.id),
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
    shortName: TOOL_READ_SKILL_FILE_SHORT_NAME,
    title: "Read Skill File",
    description:
      "Read a bundled resource file from a skill. Paths come from the " +
      "<skill_resources> list returned by activate_skill. This returns file " +
      "text for inspection only — to execute a script or run shell commands, " +
      "create a sandbox with create_skill_sandbox and call run_skill_command.",
    schema: ReadSkillFileSchema,
    async handler({ args, context }) {
      const ctx = requireOrgContext(context);
      if (!ctx) {
        return errorResult("This tool requires an organization context.");
      }

      const skill = await findAccessibleSkill(ctx, args.skill);
      if (!skill) {
        return errorResult(`No skill named "${args.skill}" exists.`);
      }

      const file = await SkillFileModel.findBySkillAndPath(skill.id, args.path);
      if (!file) {
        return errorResult(
          `Skill "${args.skill}" has no file at "${args.path}".`,
        );
      }

      if (file.encoding === "base64") {
        const approxKb = Math.round((file.content.length * 3) / 4 / 1024);
        return successResult(
          `<skill_file skill="${escapeXmlAttr(skill.name)}" path="${escapeXmlAttr(file.path)}" encoding="base64">\n` +
            `This is a binary asset (~${approxKb} KB) and cannot be read as ` +
            "text. It is bundled with the skill for redistribution, not for " +
            "inline use by the model.\n</skill_file>",
        );
      }

      return successResult(
        `<skill_file skill="${escapeXmlAttr(skill.name)}" path="${escapeXmlAttr(file.path)}">\n${escapeXmlText(file.content)}\n</skill_file>`,
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
          organizationId: ctx.organizationId,
          authorId: ctx.userId,
          name: parsed.name,
          description: parsed.description,
          content: parsed.content,
          license: parsed.license,
          compatibility: parsed.compatibility,
          allowedTools: parsed.allowedTools,
          templated: parsed.templated,
          metadata: parsed.metadata,
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
      "to rename the skill. You can only update skills you are allowed to " +
      "manage; the skill keeps its current visibility scope.",
    schema: UpdateSkillSchema,
    async handler({ args, context }) {
      const ctx = requireUserContext(context);
      if (!ctx) {
        return errorResult("This tool requires an authenticated user session.");
      }

      const skill = await findAccessibleSkill(ctx, args.name);
      if (!skill) {
        return errorResult(
          `No skill named "${args.name}" exists. Call list_skills to see available skills.`,
        );
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
            name: parsed.name,
            description: parsed.description,
            content: parsed.content,
            license: parsed.license,
            compatibility: parsed.compatibility,
            allowedTools: parsed.allowedTools,
            templated: parsed.templated,
            metadata: parsed.metadata,
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
] as const);

// ===== Internal helpers =====

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
  if (ctx.userId === undefined) return false;
  const checker = await getSkillPermissionChecker({
    userId: ctx.userId,
    organizationId: ctx.organizationId,
  });
  return isSkillSandboxAvailableForAgent({ checker, agentId });
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

/** Classify each submitted resource file by its path prefix. */
function toSkillFiles(
  files: { path: string; content: string; encoding?: "utf8" | "base64" }[],
) {
  return files.map((file) => ({
    path: file.path,
    content: file.content,
    encoding: file.encoding ?? "utf8",
    kind: deriveSkillFileKind(file.path),
  }));
}

async function listSkillCatalog(
  ctx: SkillReadContext,
  agentId: string | undefined,
) {
  const checker =
    ctx.userId !== undefined
      ? await getSkillPermissionChecker({
          userId: ctx.userId,
          organizationId: ctx.organizationId,
        })
      : null;
  const isSkillAdmin = checker?.isAdmin ?? false;
  const accessibleSkillIds = isSkillAdmin
    ? undefined
    : await SkillTeamModel.getUserAccessibleSkillIds({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
      });

  const skills = await SkillModel.findByOrganization({
    organizationId: ctx.organizationId,
    accessibleSkillIds,
  });
  if (skills.length === 0) {
    return successResult(
      "No skills are available in this organization. Skills can be added under Agents → Skills.",
    );
  }

  const catalog = skills
    .map(
      (skill) =>
        `<skill name="${escapeXmlAttr(skill.name)}">${escapeXmlText(
          skill.description,
        )}</skill>`,
    )
    .join("\n");

  // only advertise the sandbox path when it would actually work: the feature
  // is enabled, the caller can execute skills, and the sandbox tools are
  // assigned to this agent (so they appear in its tools/list).
  const instructions = (await isSkillSandboxAvailableForAgent({
    checker,
    agentId,
  }))
    ? "Call activate_skill with one of these names to load its instructions. " +
      "To run a skill's scripts or shell commands, create_skill_sandbox with " +
      "the skill name, then run_skill_command."
    : "Call activate_skill with one of these names to load its instructions.";

  return successResult(
    `<available_skills>\n${catalog}\n</available_skills>\n${instructions}`,
  );
}

export const toolEntries = registry.toolEntries;
export const tools = registry.tools;
