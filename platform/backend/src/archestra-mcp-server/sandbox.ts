import {
  TOOL_DOWNLOAD_FILE_SHORT_NAME,
  TOOL_RUN_COMMAND_SHORT_NAME,
  TOOL_UPLOAD_FILE_SHORT_NAME,
} from "@archestra/shared";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import {
  ConversationAttachmentModel,
  SkillSandboxConversationGoneError,
  SkillSandboxModel,
} from "@/models";
import { executionSandboxRegistry } from "@/skills-sandbox/execution-sandbox-registry";
import {
  SKILL_SANDBOX_ATTACHMENTS_DIR,
  SKILL_SANDBOX_HOME,
} from "@/skills-sandbox/runtime-image";
import { skillSandboxRuntimeService } from "@/skills-sandbox/skill-sandbox-runtime-service";
import {
  SKILL_SANDBOX_LIMITS,
  SkillSandboxError,
} from "@/skills-sandbox/types";
import { asSandboxId, type SandboxId } from "@/types";
import {
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
  structuredSuccessResult,
} from "./helpers";
import type { ArchestraContext } from "./types";

/**
 * Code execution sandbox tools: `run_command`, `upload_file`, `download_file`.
 *
 * Each conversation has an implicit default sandbox, created lazily on first
 * use — there is no create step. Commands, uploads, and activated skills all
 * accumulate in one durable, replayable recipe (Postgres is the source of
 * truth; Dagger materializes it on demand). `target` lets advanced callers run
 * against a fresh isolated sandbox or an explicit one instead of the default.
 *
 * RBAC: every tool is gated by `sandbox:execute` (see `rbac.ts`, enforced in
 * the dispatch path before the handler runs). Skills become runnable here by
 * activating them (`activate_skill`), which mounts them into the default
 * sandbox; that path is `skill:read`-gated.
 *
 * Model-facing text in this file follows the skill terminology glossary in
 * `skills/skill-activation.ts` and is pinned by `skill-tool-text.test.ts`.
 */

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// typed target — no magic strings. omitted = the conversation's default
// sandbox (lazily created); { fresh: true } = a new isolated sandbox (its id is
// returned); { id } = an explicit existing sandbox in the same conversation.
const SandboxTargetSchema = z
  .union([
    z
      .strictObject({ fresh: z.literal(true) })
      .describe(
        "Run against a brand-new isolated sandbox; its id is returned.",
      ),
    z
      .strictObject({
        id: z
          .string()
          .trim()
          .regex(UUID_REGEX, "must be a sandbox id (UUID)")
          .describe("An existing sandbox id returned by an earlier call."),
      })
      .describe("Run against a specific existing sandbox."),
  ])
  .optional()
  .describe(
    "Which sandbox to use. Omit for the conversation's default sandbox " +
      '(created on first use). Pass `{ "fresh": true }` for a new isolated ' +
      'sandbox, or `{ "id": "<uuid>" }` to target a specific one.',
  );

type SandboxTarget = z.infer<typeof SandboxTargetSchema>;

const RunCommandSchema = z
  .strictObject({
    command: z
      .string()
      .min(1)
      .max(SKILL_SANDBOX_LIMITS.maxCommandBytes)
      .describe(
        "Shell command to execute (bash). Runs in the sandbox's working " +
          "directory (or `cwd` when provided). Returns text output only — use " +
          "download_file for generated files.",
      ),
    cwd: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional absolute path inside the container. Defaults to the " +
          "sandbox's working directory (/home/sandbox).",
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
    target: SandboxTargetSchema,
  })
  .describe(
    "Run a shell command in the conversation's sandbox. State persists across " +
      "calls. Returns stdout, stderr, exit code, and timing.",
  );

const RunCommandOutputSchema = z.object({
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
  stagingNotices: z
    .array(z.string())
    .describe(
      "Notices about chat attachments that could not be auto-staged (e.g. too " +
        "large). Empty when all attachments are available in the sandbox.",
    ),
});

const DownloadFileSchema = z
  .strictObject({
    path: z
      .string()
      .min(1)
      .describe(
        "Path to the file inside the container — absolute, or relative to the " +
          "sandbox's working directory.",
      ),
    mimeType: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional MIME type recorded with the file. Sniffed from the bytes " +
          "when omitted.",
      ),
    target: SandboxTargetSchema,
  })
  .describe(
    "Copy a file out of the sandbox into durable storage and return a " +
      "download URL. Use this for any binary or generated output — run_command " +
      "only returns text. (To read a skill's source files, use read_skill_file.)",
  );

const DownloadFileOutputSchema = z.object({
  fileId: z.string(),
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
  stagingNotices: z
    .array(z.string())
    .describe(
      "Notices about chat attachments that could not be auto-staged (e.g. too " +
        "large). Empty when all attachments are available in the sandbox.",
    ),
});

const UploadSourceSchema = z.discriminatedUnion("type", [
  z
    .strictObject({
      type: z.literal("chat_attachment"),
      attachmentId: z
        .string()
        .min(1)
        .describe(
          "Id of an attachment in the CURRENT conversation. The bytes are " +
            "read server-side; they never pass through the model context.",
        ),
    })
    .describe("Copy bytes from a file the user attached to this conversation."),
  z
    .strictObject({
      type: z.literal("base64"),
      dataBase64: z.string().min(1).describe("Base64-encoded file bytes."),
      mimeType: z.string().min(1).optional(),
      originalName: z.string().min(1).optional(),
    })
    .describe("Upload raw bytes provided inline as base64."),
  z
    .strictObject({
      type: z.literal("text"),
      text: z.string().describe("UTF-8 text content of the file."),
      mimeType: z.string().min(1).optional(),
      originalName: z.string().min(1).optional(),
    })
    .describe("Upload a UTF-8 text file provided inline."),
]);

type UploadSource = z.infer<typeof UploadSourceSchema>;

const UploadFileSchema = z
  .strictObject({
    path: z
      .string()
      .min(1)
      .describe(
        "Destination path inside the container — absolute under /skills or " +
          "/home/sandbox, or relative to the sandbox's working directory.",
      ),
    source: UploadSourceSchema.describe(
      "Where the file bytes come from: a chat attachment, inline base64, or " +
        "inline text. Use this to place input bytes; to create a file the " +
        "sandbox will then run or read, write it with run_command instead.",
    ),
    target: SandboxTargetSchema,
  })
  .describe(
    "Upload a file into the conversation's sandbox. The bytes become part of " +
      "the sandbox recipe, so the file is present on every subsequent " +
      "run_command and download_file call.",
  );

const UploadFileOutputSchema = z.object({
  uploadId: z.string(),
  sandboxId: z.string(),
  path: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
});

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_RUN_COMMAND_SHORT_NAME,
    title: "Run Command",
    description:
      "Execute a shell command in the conversation's sandbox (Debian, " +
      "working dir /home/sandbox). Created on first use and persists across " +
      "calls — files written by one command are visible to the next. Python " +
      "runs in a uv project at /home/sandbox: `python3` is the project venv; " +
      "install packages with `uv add --project /home/sandbox <pkg>` (pip is " +
      `disabled). Files the user attached to the chat are auto-staged under ${SKILL_SANDBOX_ATTACHMENTS_DIR}/. ` +
      "Activated skills are mounted under /skills and are on PYTHONPATH, so " +
      "their modules import directly. Returns stdout, stderr, " +
      "exit code, and timing (text only — use download_file for generated " +
      "files). Requires `sandbox:execute`.",
    schema: RunCommandSchema,
    outputSchema: RunCommandOutputSchema,
    async handler({ args, context }) {
      const guard = ensureUsable(context);
      if ("error" in guard) return errorResult(guard.error);

      const resolved = await resolveTarget({
        target: args.target,
        userCtx: guard.userCtx,
        context,
      });
      if ("error" in resolved) return errorResult(resolved.error);

      try {
        const result = await skillSandboxRuntimeService.runCommand({
          sandboxId: resolved.sandboxId,
          caller: guard.userCtx,
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
          "[Sandbox] command executed",
        );

        return structuredSuccessResult(
          { ...result },
          withStagingNotices(
            formatCommandSummary(result),
            result.stagingNotices,
          ),
        );
      } catch (error) {
        return handleRuntimeError(error, resolved.sandboxId, "run_command");
      }
    },
  }),
  defineArchestraTool({
    shortName: TOOL_DOWNLOAD_FILE_SHORT_NAME,
    title: "Download File",
    description:
      "Copy a file out of the conversation's sandbox into durable storage and " +
      "return a download URL. Use this for any binary or generated output — " +
      "run_command only returns text. To read a skill's own source files, use " +
      "read_skill_file instead. Requires `sandbox:execute`.",
    schema: DownloadFileSchema,
    outputSchema: DownloadFileOutputSchema,
    async handler({ args, context }) {
      const guard = ensureUsable(context);
      if ("error" in guard) return errorResult(guard.error);

      const resolved = await resolveTarget({
        target: args.target,
        userCtx: guard.userCtx,
        context,
      });
      if ("error" in resolved) return errorResult(resolved.error);

      try {
        const result = await skillSandboxRuntimeService.exportArtifact({
          sandboxId: resolved.sandboxId,
          caller: guard.userCtx,
          path: args.path,
          mimeType: args.mimeType,
        });

        logger.info(
          {
            sandboxId: resolved.sandboxId,
            fileId: result.artifactId,
            sizeBytes: result.sizeBytes,
          },
          "[Sandbox] file downloaded",
        );

        // Bytes flow sandbox -> DB -> UI via the artifacts route; the model
        // only ever sees a short reference + URL here, never the blob.
        const downloadUrl = `/api/skill-sandbox/artifacts/${result.artifactId}`;
        return structuredSuccessResult(
          {
            fileId: result.artifactId,
            sandboxId: result.sandboxId,
            path: result.path,
            mimeType: result.mimeType,
            sizeBytes: result.sizeBytes,
            downloadUrl,
            stagingNotices: result.stagingNotices,
          },
          withStagingNotices(
            [
              `Saved ${result.path} (${result.sizeBytes} bytes).`,
              `Download URL (use this for links, not the sandbox path): ${downloadUrl}`,
            ].join("\n"),
            result.stagingNotices,
          ),
        );
      } catch (error) {
        return handleRuntimeError(error, resolved.sandboxId, "download_file");
      }
    },
  }),
  defineArchestraTool({
    shortName: TOOL_UPLOAD_FILE_SHORT_NAME,
    title: "Upload File",
    description:
      "Upload a file into the conversation's sandbox from a chat attachment, " +
      "inline base64, or inline text. The bytes become part of the sandbox " +
      "recipe, so the file is present on every later run_command and " +
      `download_file call. Note: files the user attached to the chat are already auto-staged under ${SKILL_SANDBOX_ATTACHMENTS_DIR}/ — use this tool ` +
      "to write inline content, place a file at a specific path, or upload " +
      "into a non-default sandbox. Requires `sandbox:execute`.",
    schema: UploadFileSchema,
    outputSchema: UploadFileOutputSchema,
    async handler({ args, context }) {
      const guard = ensureUsable(context);
      if ("error" in guard) return errorResult(guard.error);

      const resolved = await resolveTarget({
        target: args.target,
        userCtx: guard.userCtx,
        context,
      });
      if ("error" in resolved) return errorResult(resolved.error);

      const loaded = await loadUploadSource({
        source: args.source,
        userCtx: guard.userCtx,
        conversationId: context.conversationId,
      });
      if ("error" in loaded) return errorResult(loaded.error);

      try {
        const result = await skillSandboxRuntimeService.uploadFile({
          sandboxId: resolved.sandboxId,
          path: args.path,
          data: loaded.data,
          mimeType: loaded.mimeType,
          originalName: loaded.originalName,
        });

        logger.info(
          {
            sandboxId: resolved.sandboxId,
            uploadId: result.uploadId,
            sizeBytes: result.sizeBytes,
            sourceType: args.source.type,
          },
          "[Sandbox] file uploaded",
        );

        return structuredSuccessResult(
          { ...result },
          `Uploaded ${result.path} (${result.sizeBytes} bytes). It is now part of the sandbox and visible to every subsequent command.`,
        );
      } catch (error) {
        return handleRuntimeError(error, resolved.sandboxId, "upload_file");
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

/**
 * Enforces the deployment flag + an authenticated user. `sandbox:execute` is
 * enforced earlier in the dispatch path (see `rbac.ts`), so handlers don't
 * re-check it here.
 */
function ensureUsable(
  context: ArchestraContext,
): { userCtx: UserContext } | { error: string } {
  if (!config.skillsSandbox.enabled) {
    return {
      error: "The sandbox is not enabled on this deployment.",
    };
  }
  if (!context.organizationId || !context.userId) {
    return { error: "This tool requires an authenticated user session." };
  }
  return {
    userCtx: {
      organizationId: context.organizationId,
      userId: context.userId,
    },
  };
}

/**
 * Resolve a {@link SandboxTarget} to a concrete sandbox id, creating the
 * conversation default (or a fresh sandbox) as needed. Explicit ids are scoped
 * to the calling user + organization.
 */
async function resolveTarget(params: {
  target: SandboxTarget;
  userCtx: UserContext;
  context: ArchestraContext;
}): Promise<{ sandboxId: SandboxId } | { error: string }> {
  const { target, userCtx, context } = params;
  const conversationId = context.conversationId ?? null;
  const isolationKey = context.isolationKey ?? null;

  if (target && "id" in target) {
    const sandbox = await SkillSandboxModel.findById(target.id);
    // scope to the same org + user + conversation (or, for conversation-less
    // sandboxes, the same execution): an explicit id must not be a back door
    // to a sandbox from another conversation or another headless execution.
    if (
      !sandbox ||
      sandbox.organizationId !== userCtx.organizationId ||
      sandbox.userId !== userCtx.userId ||
      !sandboxConversationInScope({
        sandbox,
        userCtx,
        conversationId,
        isolationKey,
      })
    ) {
      logger.warn(
        {
          organizationId: userCtx.organizationId,
          userId: userCtx.userId,
          conversationId,
          targetId: target.id,
          reason: "out_of_scope_sandbox_id",
        },
        "[Sandbox] rejected out-of-scope sandbox id",
      );
      return {
        error: `No accessible sandbox with id ${target.id} exists. Omit \`target\` to use the conversation's default sandbox, or pass \`target: { fresh: true }\` to create a new one.`,
      };
    }
    return { sandboxId: asSandboxId(sandbox.id) };
  }

  if (target && "fresh" in target) {
    let sandbox: Awaited<ReturnType<typeof SkillSandboxModel.create>>;
    try {
      sandbox = await SkillSandboxModel.create({
        organizationId: userCtx.organizationId,
        userId: userCtx.userId,
        conversationId,
        defaultCwd: SKILL_SANDBOX_HOME,
        isDefault: false,
      });
    } catch (error) {
      if (error instanceof SkillSandboxConversationGoneError) {
        return { error: CONVERSATION_GONE_ERROR };
      }
      throw error;
    }
    if (!conversationId && isolationKey) {
      executionSandboxRegistry.registerOwned({
        organizationId: userCtx.organizationId,
        userId: userCtx.userId,
        isolationKey,
        sandboxId: sandbox.id,
      });
    }
    return { sandboxId: asSandboxId(sandbox.id) };
  }

  // default sandbox — scoped to the conversation, or to the execution when
  // there is no conversation (headless A2A/ChatOps/schedule/email runs).
  if (conversationId) {
    try {
      const sandbox = await SkillSandboxModel.findOrCreateDefault({
        organizationId: userCtx.organizationId,
        userId: userCtx.userId,
        conversationId,
        defaultCwd: SKILL_SANDBOX_HOME,
      });
      return { sandboxId: asSandboxId(sandbox.id) };
    } catch (error) {
      if (error instanceof SkillSandboxConversationGoneError) {
        return { error: CONVERSATION_GONE_ERROR };
      }
      throw error;
    }
  }
  if (isolationKey) {
    const sandbox = await executionSandboxRegistry.getOrCreateDefault({
      organizationId: userCtx.organizationId,
      userId: userCtx.userId,
      isolationKey,
      defaultCwd: SKILL_SANDBOX_HOME,
    });
    return { sandboxId: asSandboxId(sandbox.id) };
  }
  return {
    error:
      "No conversation context for the default sandbox. Pass `target: { fresh: true }` or `target: { id }`.",
  };
}

const CONVERSATION_GONE_ERROR =
  "This conversation no longer exists, so its sandbox is unavailable.";

/**
 * Conversation-scope half of the explicit `{id}` check. Conversation-bound
 * sandboxes must match the caller's conversation. Conversation-less sandboxes
 * (headless executions, stateless gateway clients) are never reachable from a
 * conversation; within a headless execution they must belong to that
 * execution, while gateway callers without an isolation scope keep their
 * org+user-wide access (they have no narrower scope to check against).
 */
function sandboxConversationInScope(params: {
  sandbox: { id: string; conversationId: string | null };
  userCtx: UserContext;
  conversationId: string | null;
  isolationKey: string | null;
}): boolean {
  const { sandbox, userCtx, conversationId, isolationKey } = params;
  if (sandbox.conversationId !== null) {
    return sandbox.conversationId === conversationId;
  }
  if (conversationId !== null) {
    return false;
  }
  if (isolationKey) {
    return executionSandboxRegistry.isOwned({
      organizationId: userCtx.organizationId,
      userId: userCtx.userId,
      isolationKey,
      sandboxId: sandbox.id,
    });
  }
  return true;
}

function handleRuntimeError(
  error: unknown,
  sandboxId: SandboxId,
  tool: string,
) {
  if (error instanceof SkillSandboxError) {
    return errorResult(error.message);
  }
  logger.error(
    { err: error, sandboxId },
    `[Sandbox] ${tool} failed unexpectedly`,
  );
  return errorResult(`${tool} failed due to an internal error.`);
}

// base64 alphabet plus padding and incidental whitespace.
const BASE64_RE = /^[A-Za-z0-9+/\s]*={0,2}$/;

interface LoadedUpload {
  data: Buffer;
  mimeType?: string;
  originalName?: string;
}

/**
 * Resolve upload source bytes. chat_attachment reads server-side and is scoped
 * to the caller's org AND the current conversation — the bytes never enter the
 * model context, and an attachment from another conversation is rejected to
 * prevent cross-conversation exfiltration.
 */
async function loadUploadSource(params: {
  source: UploadSource;
  userCtx: UserContext;
  conversationId: string | undefined;
}): Promise<LoadedUpload | { error: string }> {
  const { source, userCtx, conversationId } = params;
  switch (source.type) {
    case "base64": {
      if (!BASE64_RE.test(source.dataBase64)) {
        return { error: "source.dataBase64 is not valid base64." };
      }
      return {
        data: Buffer.from(source.dataBase64, "base64"),
        mimeType: source.mimeType,
        originalName: source.originalName,
      };
    }
    case "text": {
      return {
        data: Buffer.from(source.text, "utf8"),
        mimeType: source.mimeType ?? "text/plain",
        originalName: source.originalName,
      };
    }
    case "chat_attachment": {
      if (!conversationId) {
        logger.warn(
          {
            organizationId: userCtx.organizationId,
            userId: userCtx.userId,
            attachmentId: source.attachmentId,
            reason: "no_conversation_context",
          },
          "[Sandbox] rejected chat_attachment upload",
        );
        return {
          error:
            "chat_attachment uploads require a conversation context; use a base64 or text source instead.",
        };
      }
      const attachment = await ConversationAttachmentModel.findByIdWithData(
        source.attachmentId,
      );
      if (!attachment || attachment.organizationId !== userCtx.organizationId) {
        logger.warn(
          {
            organizationId: userCtx.organizationId,
            userId: userCtx.userId,
            conversationId,
            attachmentId: source.attachmentId,
            reason: "attachment_not_found_or_wrong_org",
          },
          "[Sandbox] rejected chat_attachment upload",
        );
        return {
          error: `No accessible attachment with id ${source.attachmentId} exists.`,
        };
      }
      if (attachment.conversationId !== conversationId) {
        logger.warn(
          {
            organizationId: userCtx.organizationId,
            userId: userCtx.userId,
            conversationId,
            attachmentId: source.attachmentId,
            reason: "cross_conversation_attachment",
          },
          "[Sandbox] rejected chat_attachment upload",
        );
        return {
          error:
            "That attachment belongs to a different conversation and cannot be used here.",
        };
      }
      return {
        data: attachment.fileData,
        mimeType: attachment.mimeType,
        originalName: attachment.originalName,
      };
    }
  }
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

/** Append auto-staging notices to a tool summary so skips are model-visible. */
function withStagingNotices(summary: string, notices: string[]): string {
  if (notices.length === 0) return summary;
  return [
    summary,
    "",
    "Attachment notices:",
    ...notices.map((n) => `- ${n}`),
  ].join("\n");
}
