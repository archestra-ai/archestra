import {
  TOOL_CREATE_SKILL_SANDBOX_SHORT_NAME,
  TOOL_GET_SKILL_SANDBOX_ARTIFACT_SHORT_NAME,
  TOOL_RUN_SKILL_COMMAND_SHORT_NAME,
} from "@shared";
import { z } from "zod";
import { getSkillPermissionChecker } from "@/auth/skill-permissions";
import config from "@/config";
import logger from "@/logging";
import {
  SkillInvalidFilePathError,
  SkillModel,
  SkillSandboxCommandModel,
  SkillSandboxFileSnapshotModel,
  SkillSandboxModel,
  SkillTeamModel,
} from "@/models";
import {
  SKILL_SANDBOX_ROOT,
  skillRootPath,
} from "@/skills-sandbox/runtime-image";
import {
  __internals as skillSandboxInternals,
  skillSandboxRuntimeService,
} from "@/skills-sandbox/skill-sandbox-runtime-service";
import {
  SKILL_SANDBOX_LIMITS,
  SkillSandboxError,
} from "@/skills-sandbox/types";
import { asSandboxId, type SandboxId, type Skill } from "@/types";
import {
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
  structuredSuccessResult,
} from "./helpers";
import type { ArchestraContext } from "./types";

/**
 * Skill execution sandbox tools.
 *
 * `create_skill_sandbox` snapshots a set of skills into a fresh sandbox recipe
 * persisted in Postgres. `run_skill_command` and `get_skill_sandbox_artifact`
 * materialize the recipe into a Dagger container, execute commands or export
 * files, and append the result to the command/artifact log. Sandboxes are
 * ephemeral by design — Dagger owns filesystem state; the DB is the source of
 * truth for the recipe and replay log.
 *
 * RBAC: each tool is gated by `skill:execute` (see `rbac.ts`). The handler
 * additionally requires `skill:read` for every skill mounted into the sandbox
 * and enforces per-skill scope access. `run_skill_command` and
 * `get_skill_sandbox_artifact` further restrict access to sandboxes owned by
 * the calling user within the same organization.
 */

const MAX_SKILLS_PER_SANDBOX = 16;

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// aliases are 1-based (`s1` = first-created); reject `s0` up front.
const ALIAS_REGEX = /^s[1-9]\d*$/;
const SandboxIdOrAliasSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) => UUID_REGEX.test(value) || ALIAS_REGEX.test(value),
    "must be a UUID or a sandbox alias like `s1`",
  );

const CreateSkillSandboxSchema = z
  .strictObject({
    skillNames: z
      .array(z.string().trim().min(1))
      .min(1)
      .max(MAX_SKILLS_PER_SANDBOX)
      .describe(
        "Skill names to mount into the sandbox. The first skill is treated " +
          "as the primary unless `primarySkill` is set; its root is the " +
          "sandbox's default working directory.",
      ),
    primarySkill: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Optional. When set, must be one of `skillNames`; determines the " +
          "default working directory and the canonical skill root for " +
          "relative paths in commands.",
      ),
  })
  .describe(
    "Create a sandbox snapshot of one or more skills. Returns a stable " +
      "sandbox id; pass it to run_skill_command and get_skill_sandbox_artifact.",
  );

const SkillRootSchema = z.object({
  skillId: z.string(),
  skillName: z.string(),
  rootPath: z.string(),
});

const CreateSkillSandboxOutputSchema = z.object({
  sandboxId: z.string(),
  /** Short, per-conversation alias usable in place of `sandboxId`. */
  alias: z.string(),
  defaultCwd: z.string(),
  skillRoots: z.array(SkillRootSchema),
});

const RunSkillCommandSchema = z
  .strictObject({
    sandboxId: SandboxIdOrAliasSchema.optional().describe(
      "Sandbox to run the command in. Accepts either the full UUID or the " +
        "short alias from create_skill_sandbox (e.g. `s1`, `s2`). When " +
        "omitted, the most recent sandbox attached to the current " +
        "conversation is used; rejected when no conversation context exists " +
        "or the alias cannot be resolved.",
    ),
    command: z
      .string()
      .min(1)
      .max(SKILL_SANDBOX_LIMITS.maxCommandBytes)
      .describe(
        "Shell command to execute inside the sandbox. Runs under bash with " +
          "the sandbox's default cwd (or `cwd` when provided).",
      ),
    cwd: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional absolute path inside the container. Defaults to the " +
          "sandbox's default cwd (the primary skill's root).",
      ),
    timeoutSeconds: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Optional wall-clock limit in seconds, capped at the deployment " +
          "maximum.",
      ),
  })
  .describe(
    "Run a shell command in a skill sandbox. Returns stdout, stderr, exit " +
      "code, and timing.",
  );

const RunSkillCommandOutputSchema = z.object({
  commandId: z.string(),
  sandboxId: z.string(),
  command: z.string(),
  cwd: z.string().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number(),
  durationMs: z.number(),
  timedOut: z.boolean(),
  truncated: z.boolean(),
});

const GetSkillSandboxArtifactSchema = z
  .strictObject({
    sandboxId: SandboxIdOrAliasSchema.optional().describe(
      "Sandbox to read the artifact from. Accepts either the full UUID or " +
        "the short alias (e.g. `s1`). When omitted, the most recent sandbox " +
        "attached to the current conversation is used; rejected when no " +
        "conversation context is available.",
    ),
    path: z
      .string()
      .min(1)
      .describe(
        "Path to the file inside the container — either absolute, or " +
          "relative to the sandbox's default cwd.",
      ),
    mimeType: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional MIME type recorded with the artifact. Defaults to " +
          "application/octet-stream.",
      ),
  })
  .describe(
    "Copy a file out of the sandbox into durable artifact storage. Returns " +
      "the artifact id and metadata; use this for any binary or generated " +
      "output that should outlive the sandbox.",
  );

const GetSkillSandboxArtifactOutputSchema = z.object({
  artifactId: z.string(),
  sandboxId: z.string(),
  path: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  /**
   * Stable URL the frontend can fetch the bytes from (auth-scoped to the
   * caller). Relative to the backend origin; safe to pass straight to `<img
   * src>` or `<a href>` in the same-origin chat UI.
   */
  downloadUrl: z.string(),
});

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_CREATE_SKILL_SANDBOX_SHORT_NAME,
    title: "Create Skill Sandbox",
    description:
      "Snapshot one or more skills into a fresh execution sandbox. The " +
      "sandbox is a durable recipe — Postgres stores the recipe and replay " +
      "log; Dagger materializes it on demand. Returns a stable `sandboxId` " +
      "and the per-skill root paths under which relative paths in `run_" +
      "skill_command` resolve. Requires `skill:execute`; the caller must " +
      "also have `skill:read` access to every requested skill.",
    schema: CreateSkillSandboxSchema,
    outputSchema: CreateSkillSandboxOutputSchema,
    async handler({ args, context }) {
      if (!config.skillsSandbox.enabled) {
        return errorResult(
          "Skill execution sandbox is not enabled on this deployment.",
        );
      }

      const userCtx = requireUserContext(context);
      if (!userCtx) {
        return errorResult("This tool requires an authenticated user session.");
      }

      const checker = await getSkillPermissionChecker(userCtx);
      if (!checker.canExecute) {
        return errorResult(
          "You do not have permission to perform this action (requires skill:execute).",
        );
      }
      if (!checker.canRead) {
        return errorResult(
          "You do not have permission to perform this action (requires skill:read).",
        );
      }

      const requestedNames = dedupe(args.skillNames);
      if (
        args.primarySkill !== undefined &&
        !requestedNames.includes(args.primarySkill)
      ) {
        return errorResult(
          `primarySkill "${args.primarySkill}" must be one of skillNames.`,
        );
      }

      const resolved = await Promise.all(
        requestedNames.map(async (name) => {
          const skill = await SkillModel.findByName(
            userCtx.organizationId,
            name,
          );
          if (!skill) return { name, skill: null };
          const hasAccess = await SkillTeamModel.userHasSkillAccess({
            organizationId: userCtx.organizationId,
            userId: userCtx.userId,
            skill,
            isSkillAdmin: checker.isAdmin,
          });
          return { name, skill: hasAccess ? skill : null };
        }),
      );
      const skills: Skill[] = [];
      for (const { name, skill } of resolved) {
        if (!skill) {
          return errorResult(`No skill named "${name}" exists.`);
        }
        skills.push(skill);
      }

      const primary = args.primarySkill
        ? skills.find((s) => s.name === args.primarySkill)
        : skills[0];
      if (!primary) {
        return errorResult("Could not resolve a primary skill.");
      }

      // validate all skill names before the DB commit so a bad secondary name
      // never leaves an orphaned sandbox record
      for (const skill of skills) {
        try {
          skillRootPath(skill.name);
        } catch {
          return errorResult(
            `Skill name ${JSON.stringify(skill.name)} is not valid for sandbox use (must not contain "/" or "..").`,
          );
        }
      }

      const defaultCwd = skillRootPath(primary.name);

      // count sandboxes the caller can already see in this conversation BEFORE
      // creating the new one, so the alias for the new sandbox is `s${count+1}`.
      // must use the filtered list (matching resolveSandboxId), otherwise the
      // alias we promise at create time cannot be looked up at run time.
      const priorCount = context.conversationId
        ? (
            await accessibleConversationSandboxes(
              context.conversationId,
              userCtx,
            )
          ).length
        : 0;

      let sandbox: Awaited<ReturnType<typeof SkillSandboxModel.create>>;
      try {
        sandbox = await SkillSandboxModel.create({
          sandbox: {
            organizationId: userCtx.organizationId,
            userId: userCtx.userId,
            conversationId: context.conversationId ?? null,
            agentId: context.agentId ?? null,
            primarySkillId: primary.id,
            defaultCwd,
          },
          skillIds: skills.map((s) => s.id),
        });
      } catch (err) {
        if (err instanceof SkillInvalidFilePathError) {
          return errorResult(err.message);
        }
        throw err;
      }

      // Persist `uv pip install -r requirements.txt` setup rows once per
      // requirements-bearing skill. These are real command-log entries, not
      // a synthetic prepend at materialize time — every run replays the log
      // uniformly, so install + user commands share one code path and one
      // Dagger layer cache. exitCode=0 is a placeholder; replay re-executes.
      const snapshotRows = await SkillSandboxFileSnapshotModel.listBySandbox(
        sandbox.id,
      );
      const installs = skillSandboxInternals.autoInstallCommands(
        sandbox,
        snapshotRows,
      );
      for (const install of installs) {
        await SkillSandboxCommandModel.append({
          sandboxId: sandbox.id,
          organizationId: sandbox.organizationId,
          command: install.command,
          cwd: install.cwd ?? null,
          stdout: "",
          stderr: "",
          exitCode: 0,
          durationMs: 0,
          timeoutSeconds: install.timeoutSeconds,
        });
      }

      const alias = aliasForNewSandbox(
        context.conversationId,
        priorCount,
        sandbox.id,
      );

      logger.info(
        {
          sandboxId: sandbox.id,
          userId: userCtx.userId,
          organizationId: userCtx.organizationId,
          conversationId: context.conversationId,
          skillCount: skills.length,
        },
        "[SkillSandbox] sandbox created",
      );

      const skillRoots = skills.map((s) => ({
        skillId: s.id,
        skillName: s.name,
        rootPath: skillRootPath(s.name),
      }));

      return structuredSuccessResult(
        {
          sandboxId: sandbox.id,
          alias,
          defaultCwd,
          skillRoots,
        },
        [
          `Created skill sandbox ${alias} (${sandbox.id}).`,
          `Default working directory: ${defaultCwd}`,
          `Skill roots (under ${SKILL_SANDBOX_ROOT}):`,
          ...skillRoots.map((r) => `  - ${r.skillName} -> ${r.rootPath}`),
          "",
          renderFullEnvTrailer({
            alias,
            sandboxId: sandbox.id,
            defaultCwd,
            skillNames: orderedSkillNames(
              skills.map((s) => s.name),
              primary.name,
            ),
          }),
        ].join("\n"),
      );
    },
  }),
  defineArchestraTool({
    shortName: TOOL_RUN_SKILL_COMMAND_SHORT_NAME,
    title: "Run Skill Command",
    description:
      "Execute a shell command inside a skill sandbox. The sandbox is " +
      "materialized from its persisted recipe and command log; the new " +
      "command sees the cumulative effects of prior runs. Returns stdout, " +
      "stderr, exit code, and timing. Requires `skill:execute`.",
    schema: RunSkillCommandSchema,
    outputSchema: RunSkillCommandOutputSchema,
    async handler({ args, context }) {
      if (!config.skillsSandbox.enabled) {
        return errorResult(
          "Skill execution sandbox is not enabled on this deployment.",
        );
      }

      const userCtx = requireUserContext(context);
      if (!userCtx) {
        return errorResult("This tool requires an authenticated user session.");
      }

      const checker = await getSkillPermissionChecker(userCtx);
      if (!checker.canExecute) {
        return errorResult(
          "You do not have permission to perform this action (requires skill:execute).",
        );
      }

      const resolved = await resolveSandboxId({
        sandboxId: args.sandboxId,
        userCtx,
        conversationId: context.conversationId,
      });
      if ("error" in resolved) return errorResult(resolved.error);

      try {
        const result = await skillSandboxRuntimeService.runCommand({
          sandboxId: resolved.sandboxId,
          command: args.command,
          cwd: args.cwd,
          timeoutSeconds: args.timeoutSeconds,
        });

        logger.info(
          {
            sandboxId: resolved.sandboxId,
            commandId: result.commandId,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            timedOut: result.timedOut,
          },
          "[SkillSandbox] command executed",
        );

        const envTrailer = await renderCompactEnvTrailerFor(
          resolved.sandboxId,
          userCtx,
        );
        return structuredSuccessResult(
          { ...result },
          [formatCommandSummary(result), "", envTrailer].join("\n"),
        );
      } catch (error) {
        if (error instanceof SkillSandboxError) {
          return errorResult(error.message);
        }
        logger.error(
          { err: error, sandboxId: resolved.sandboxId },
          "[SkillSandbox] run_skill_command failed unexpectedly",
        );
        return errorResult(
          "Skill command execution failed due to an internal error.",
        );
      }
    },
  }),
  defineArchestraTool({
    shortName: TOOL_GET_SKILL_SANDBOX_ARTIFACT_SHORT_NAME,
    title: "Get Skill Sandbox Artifact",
    description:
      "Read a file from a skill sandbox and persist it as a durable " +
      "artifact. Use this for any binary or generated output that should " +
      "outlive the sandbox — `run_skill_command` only returns text " +
      "stdout/stderr. Requires `skill:execute`.",
    schema: GetSkillSandboxArtifactSchema,
    outputSchema: GetSkillSandboxArtifactOutputSchema,
    async handler({ args, context }) {
      if (!config.skillsSandbox.enabled) {
        return errorResult(
          "Skill execution sandbox is not enabled on this deployment.",
        );
      }

      const userCtx = requireUserContext(context);
      if (!userCtx) {
        return errorResult("This tool requires an authenticated user session.");
      }

      const checker = await getSkillPermissionChecker(userCtx);
      if (!checker.canExecute) {
        return errorResult(
          "You do not have permission to perform this action (requires skill:execute).",
        );
      }

      const resolved = await resolveSandboxId({
        sandboxId: args.sandboxId,
        userCtx,
        conversationId: context.conversationId,
      });
      if ("error" in resolved) return errorResult(resolved.error);

      try {
        const result = await skillSandboxRuntimeService.exportArtifact({
          sandboxId: resolved.sandboxId,
          path: args.path,
          mimeType: args.mimeType,
        });

        logger.info(
          {
            sandboxId: resolved.sandboxId,
            artifactId: result.artifactId,
            sizeBytes: result.sizeBytes,
          },
          "[SkillSandbox] artifact exported",
        );

        // Intentionally NOT attaching an MCP image content block here. The
        // chat layer collapses non-text content items into the tool-result
        // string (`chat-mcp-client.ts` JSON.stringify path), which would
        // shovel a base64 blob into the LLM context. Bytes flow
        // sandbox -> DB -> UI via the `/api/skill-sandbox/artifacts/:id`
        // route; the model only ever sees a short reference here.
        const downloadUrl = `/api/skill-sandbox/artifacts/${result.artifactId}`;
        const envTrailer = await renderCompactEnvTrailerFor(
          resolved.sandboxId,
          userCtx,
        );
        const structuredContent = { ...result, downloadUrl };
        const text = [
          `Saved ${result.path} (${result.sizeBytes} bytes) as artifact ${result.artifactId}.`,
          // surface the real download URL: the model must link the user here,
          // not to the in-sandbox path (which is dead outside the container).
          `Download URL (use this for links, not the sandbox path): ${downloadUrl}`,
          "",
          envTrailer,
        ].join("\n");
        return structuredSuccessResult(structuredContent, text);
      } catch (error) {
        if (error instanceof SkillSandboxError) {
          return errorResult(error.message);
        }
        logger.error(
          { err: error, sandboxId: resolved.sandboxId },
          "[SkillSandbox] get_skill_sandbox_artifact failed unexpectedly",
        );
        return errorResult(
          "Skill artifact export failed due to an internal error.",
        );
      }
    },
  }),
] as const);

export const toolEntries = registry.toolEntries;
export const tools = registry.tools;

// === internal helpers ===

interface UserContext {
  organizationId: string;
  userId: string;
}

function requireUserContext(context: ArchestraContext): UserContext | null {
  if (!context.organizationId || !context.userId) return null;
  return { organizationId: context.organizationId, userId: context.userId };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Same order the runtime applies to PYTHONPATH (primary first, then the rest
 * alphabetical). Keep the trailer string honest so the model's import-resolution
 * mental model matches what runs inside the container.
 */
function orderedSkillNames(
  skillNames: string[],
  primaryName: string,
): string[] {
  const rest = skillNames.filter((n) => n !== primaryName).sort();
  return [primaryName, ...rest];
}

/**
 * Resolves an explicit `sandboxId` (UUID or `s\d+` alias, authorized against
 * the caller) or, when omitted, looks up the most recent sandbox attached to
 * the current conversation. Returns an error string when no sandbox can be
 * resolved.
 */
async function resolveSandboxId(params: {
  sandboxId: string | undefined;
  userCtx: UserContext;
  conversationId: string | undefined;
}): Promise<{ sandboxId: SandboxId } | { error: string }> {
  const { sandboxId, userCtx, conversationId } = params;
  if (sandboxId) {
    if (ALIAS_REGEX.test(sandboxId)) {
      if (!conversationId) {
        return {
          error: `Sandbox alias \`${sandboxId}\` can only be used inside a conversation; pass the full UUID instead.`,
        };
      }
      const accessible = await accessibleConversationSandboxes(
        conversationId,
        userCtx,
      );
      const idx = parseAlias(sandboxId);
      const match = accessible[idx];
      if (!match) {
        return {
          error: `No sandbox with alias \`${sandboxId}\` exists in this conversation.`,
        };
      }
      return { sandboxId: asSandboxId(match.id) };
    }
    const sandbox = await SkillSandboxModel.findById(sandboxId);
    if (
      !sandbox ||
      sandbox.organizationId !== userCtx.organizationId ||
      sandbox.userId !== userCtx.userId
    ) {
      return { error: `No accessible sandbox with id ${sandboxId} exists.` };
    }
    return { sandboxId: asSandboxId(sandbox.id) };
  }

  if (!conversationId) {
    return {
      error:
        "No sandboxId was provided and there is no conversation context to infer one from. Pass `sandboxId` explicitly.",
    };
  }
  const accessible = await accessibleConversationSandboxes(
    conversationId,
    userCtx,
  );
  if (accessible.length === 0) {
    return {
      error:
        "No sandbox is attached to the current conversation. Call create_skill_sandbox first or pass `sandboxId` explicitly.",
    };
  }
  // When several sandboxes exist (usually because earlier failed calls left
  // orphans), route to the most-recently-created one — that matches the
  // intuition of "use the sandbox I just made". The compact env trailer
  // printed after each call shows the resolved alias so the caller can
  // switch back to an older one explicitly if they need to.
  const chosen = accessible[accessible.length - 1];
  if (accessible.length > 1) {
    logger.debug(
      {
        conversationId,
        chosenSandboxId: chosen.id,
        candidateCount: accessible.length,
      },
      "[SkillSandbox] resolved sandboxId from latest of multiple conversation sandboxes",
    );
  }
  return { sandboxId: asSandboxId(chosen.id) };
}

/**
 * Conversation sandboxes the caller can access, oldest first so the alias for
 * the n-th created sandbox is stably `s${n}` (`s1` = first-created).
 * `listForConversation` returns newest-first; we reverse here.
 */
async function accessibleConversationSandboxes(
  conversationId: string,
  userCtx: UserContext,
) {
  const all = await SkillSandboxModel.listForConversation({
    conversationId,
    organizationId: userCtx.organizationId,
  });
  return all.filter((s) => s.userId === userCtx.userId).reverse();
}

function parseAlias(alias: string): number {
  return parseInt(alias.slice(1), 10) - 1;
}

/**
 * Compute `s${n}` alias for a freshly-created sandbox. Caller passes the
 * pre-create count of sandboxes in the conversation; alias is `s${count+1}`.
 * For sandboxes without a conversation context we return the UUID itself.
 */
function aliasForNewSandbox(
  conversationId: string | undefined,
  priorCount: number,
  sandboxId: string,
): string {
  if (!conversationId) return sandboxId;
  return `s${priorCount + 1}`;
}

/**
 * Full env trailer printed after `create_skill_sandbox`. Lists everything the
 * model needs to know to use the sandbox correctly: alias for cheap referral,
 * cwd, pythonpath, the uv-only deps policy. Costs ~80 tokens to render but
 * typically saves several exploratory calls (see the analysis around the
 * slack-gif chat session).
 */
function renderFullEnvTrailer(args: {
  alias: string;
  sandboxId: string;
  defaultCwd: string;
  skillNames: string[];
}): string {
  const pythonpath = args.skillNames.map(skillRootPath).join(":");
  const sandboxLine =
    args.alias === args.sandboxId
      ? `sandbox:   ${args.sandboxId}`
      : `sandbox:   ${args.alias}  (${args.sandboxId})`;
  return [
    "--- env ---",
    sandboxLine,
    `cwd:       ${args.defaultCwd}`,
    `pythonpath: ${pythonpath}`,
    "python:    uv-managed venv at /home/sandbox/.venv",
    "  preinstalled: numpy, pandas, httpx",
    "add deps:  `uv add <pkg>` — pip is disabled in this sandbox",
  ].join("\n");
}

/**
 * Compact trailer printed after `run_skill_command` and
 * `get_skill_sandbox_artifact`. Doesn't repeat the python/uv prose the model
 * already saw on create — just keeps the alias and cwd in front of it so
 * subsequent calls can use the short id.
 */
async function renderCompactEnvTrailerFor(
  sandboxId: SandboxId,
  userCtx: UserContext,
): Promise<string> {
  const sandbox = await SkillSandboxModel.findById(sandboxId);
  if (!sandbox) return "";
  const alias = await aliasForExistingSandbox(sandbox, userCtx);
  return `--- env ---\nsandbox: ${alias}  cwd: ${sandbox.defaultCwd}`;
}

async function aliasForExistingSandbox(
  sandbox: { id: string; conversationId: string | null },
  userCtx: UserContext,
): Promise<string> {
  if (!sandbox.conversationId) return sandbox.id;
  const accessible = await accessibleConversationSandboxes(
    sandbox.conversationId,
    userCtx,
  );
  const idx = accessible.findIndex((s) => s.id === sandbox.id);
  return idx === -1 ? sandbox.id : `s${idx + 1}`;
}

function formatCommandSummary(result: {
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
  stdout: string;
  stderr: string;
}): string {
  const lines = [`Exit code: ${result.exitCode} (${result.durationMs} ms)`];
  if (result.timedOut) {
    lines.push("The command was killed by the wall-clock timeout.");
  }
  lines.push("", "stdout:", result.stdout || "(empty)");
  if (result.stderr) {
    lines.push("", "stderr:", result.stderr);
  }
  if (result.truncated) {
    lines.push("", "(output was truncated)");
  }
  return lines.join("\n");
}
