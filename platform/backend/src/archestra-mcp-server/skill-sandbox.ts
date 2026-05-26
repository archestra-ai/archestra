import {
  TOOL_CREATE_SKILL_SANDBOX_SHORT_NAME,
  TOOL_GET_SKILL_SANDBOX_ARTIFACT_SHORT_NAME,
  TOOL_RUN_SKILL_COMMAND_SHORT_NAME,
} from "@shared";
import { z } from "zod";
import { getSkillPermissionChecker } from "@/auth/skill-permissions";
import config from "@/config";
import logger from "@/logging";
import { SkillModel, SkillSandboxModel, SkillTeamModel } from "@/models";
import {
  SKILL_SANDBOX_ROOT,
  skillRootPath,
} from "@/skills-sandbox/runtime-image";
import { skillSandboxRuntimeService } from "@/skills-sandbox/skill-sandbox-runtime-service";
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
  defaultCwd: z.string(),
  skillRoots: z.array(SkillRootSchema),
});

const RunSkillCommandSchema = z
  .strictObject({
    sandboxId: z
      .string()
      .uuid()
      .optional()
      .describe(
        "Sandbox to run the command in. When omitted, the most recent " +
          "sandbox attached to the current conversation is used; if no such " +
          "sandbox exists or the call has no conversation context, the call " +
          "is rejected.",
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
    sandboxId: z
      .string()
      .uuid()
      .optional()
      .describe(
        "Sandbox to read the artifact from. When omitted, the most recent " +
          "sandbox attached to the current conversation is used; rejected " +
          "when ambiguous.",
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

      const skills: Skill[] = [];
      for (const name of requestedNames) {
        const skill = await SkillModel.findByName(userCtx.organizationId, name);
        if (!skill) {
          return errorResult(`No skill named "${name}" exists.`);
        }
        const hasAccess = await SkillTeamModel.userHasSkillAccess({
          organizationId: userCtx.organizationId,
          userId: userCtx.userId,
          skill,
          isSkillAdmin: checker.isAdmin,
        });
        if (!hasAccess) {
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

      const defaultCwd = skillRootPath(primary.name);
      const sandbox = await SkillSandboxModel.create({
        sandbox: {
          organizationId: userCtx.organizationId,
          userId: userCtx.userId,
          conversationId: context.conversationId ?? null,
          agentId: context.agentId ?? null,
          baseImage: config.skillsSandbox.image,
          primarySkillId: primary.id,
          defaultCwd,
        },
        skillIds: skills.map((s) => s.id),
      });

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
          defaultCwd,
          skillRoots,
        },
        [
          `Created skill sandbox ${sandbox.id}.`,
          `Default working directory: ${defaultCwd}`,
          `Skill roots (under ${SKILL_SANDBOX_ROOT}):`,
          ...skillRoots.map((r) => `  - ${r.skillName} -> ${r.rootPath}`),
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

        return structuredSuccessResult(
          { ...result },
          formatCommandSummary(result),
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

        return structuredSuccessResult(
          { ...result },
          `Exported artifact ${result.artifactId} from ${result.path} (${result.sizeBytes} bytes).`,
        );
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
 * Resolves an explicit `sandboxId` (and authorizes it) or, when omitted, looks
 * up the most recent sandbox attached to the current conversation. Returns an
 * error string when no sandbox can be resolved.
 */
async function resolveSandboxId(params: {
  sandboxId: string | undefined;
  userCtx: UserContext;
  conversationId: string | undefined;
}): Promise<{ sandboxId: SandboxId } | { error: string }> {
  const { sandboxId, userCtx, conversationId } = params;
  if (sandboxId) {
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
  const inferred =
    await SkillSandboxModel.findMostRecentForConversation(conversationId);
  if (
    !inferred ||
    inferred.organizationId !== userCtx.organizationId ||
    inferred.userId !== userCtx.userId
  ) {
    return {
      error:
        "No sandbox is attached to the current conversation. Call create_skill_sandbox first or pass `sandboxId` explicitly.",
    };
  }
  return { sandboxId: asSandboxId(inferred.id) };
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
