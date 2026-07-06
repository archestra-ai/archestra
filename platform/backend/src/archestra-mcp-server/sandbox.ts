import type { EnvironmentTarget } from "@archestra/sandbox-rs";
import {
  PROJECT_INSTRUCTIONS_FILENAME,
  TOOL_DELETE_FILE_SHORT_NAME,
  TOOL_DOWNLOAD_FILE_SHORT_NAME,
  TOOL_EDIT_FILE_SHORT_NAME,
  TOOL_READ_FILE_SHORT_NAME,
  TOOL_RUN_COMMAND_SHORT_NAME,
  TOOL_SAVE_FILE_SHORT_NAME,
  TOOL_SEARCH_FILES_SHORT_NAME,
  TOOL_UPLOAD_FILE_SHORT_NAME,
} from "@archestra/shared";
import { z } from "zod";
import config from "@/config";
import { daggerEnvironmentRuntimeManager } from "@/k8s/dagger-environment-runtime/manager";
import logger from "@/logging";
import {
  AgentModel,
  ConversationAttachmentModel,
  EnvironmentModel,
  FileNameExistsError,
  SkillSandboxConversationGoneError,
  SkillSandboxModel,
} from "@/models";
import { executionSandboxRegistry } from "@/skills-sandbox/execution-sandbox-registry";
import { UnsafePathError } from "@/skills-sandbox/file-path";
import { FileBytesMissingError } from "@/skills-sandbox/file-storage";
import type { MyFileResolutionError } from "@/skills-sandbox/file-store";
import {
  FileNotDeletableError,
  fileStore,
  OBJECT_REF_PREFIX,
} from "@/skills-sandbox/file-store";
import {
  isInlineSafeImageMime,
  resolveArtifactMime,
} from "@/skills-sandbox/mime-sniff";
import {
  type ProjectFileScope,
  resolveProjectFileScope,
} from "@/skills-sandbox/project-file-scope";
import {
  SKILL_SANDBOX_ATTACHMENTS_DIR,
  SKILL_SANDBOX_HOME,
} from "@/skills-sandbox/runtime-image";
import { skillSandboxRuntimeService } from "@/skills-sandbox/skill-sandbox-runtime-service";
import {
  SKILL_SANDBOX_LIMITS,
  SkillSandboxError,
} from "@/skills-sandbox/types";
import { asSandboxId, type PersistedFile, type SandboxId } from "@/types";
import { isUuid } from "@/utils/uuid";
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
 * loading them (`load_skill`), which mounts them into the default
 * sandbox; that path is `skill:read`-gated.
 *
 * Model-facing text in this file follows the skill terminology glossary in
 * `skills/skill-activation.ts` and is pinned by `skill-tool-text.test.ts`.
 */

// read_file default line window (matches the SOTA Read default).
const READ_FILE_DEFAULT_LINES = 2000;

// Cap raw image bytes read_file will return inline so the base64 payload stays
// under the model's ~5 MB per-image limit (base64 inflates by ~4/3). Larger
// images are refused with a hint to copy the file into the sandbox instead.
const READ_FILE_IMAGE_BYTES_LIMIT = 3.75 * 1024 * 1024;

// typed target — no magic strings. omitted = the conversation's default
// sandbox (lazily created); { fresh: true } = a new isolated sandbox (its id is
// returned); { id } = an explicit existing sandbox in the same conversation.
// Both fields are optional and weakly typed on purpose: models routinely guess
// `{ fresh: false }` or `{ id: "" }` meaning "the default sandbox", so the
// schema accepts those shapes and `normalizeTarget` maps any no-op guess back to
// the default rather than rejecting it.
const SandboxTargetSchema = z
  .strictObject({
    fresh: z
      .boolean()
      .optional()
      .describe(
        "Set true for a brand-new isolated sandbox; its id is returned.",
      ),
    id: z
      .string()
      .optional()
      .describe("An existing sandbox id (UUID) returned by an earlier call."),
  })
  .optional()
  .describe(
    "Which sandbox to use. Omit (or leave empty) for the conversation's default " +
      'sandbox (created on first use). Pass `{ "fresh": true }` for a new isolated ' +
      'sandbox, or `{ "id": "<uuid>" }` to target a specific one.',
  );

type SandboxTarget = z.infer<typeof SandboxTargetSchema>;

// Canonical target intent after normalizing a (loosely typed) SandboxTarget:
// a fresh sandbox, a specific id, or the default (undefined).
type SandboxTargetIntent = { fresh: true } | { id: string } | undefined;

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
  binaryStripped: z
    .boolean()
    .describe(
      "True when NUL bytes were stripped from stdout/stderr before storage.",
    ),
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
    overwrite: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Replace an existing same-named persistent file in place, keeping its id. " +
          "Default false errors if the name is already taken.",
      ),
    target: SandboxTargetSchema,
  })
  .describe(
    "Copy a file that already exists at a path in the sandbox into the conversation's persistent " +
      "files. Use this for anything on the sandbox's disk — a file run_command wrote (text or " +
      "binary) or a staged attachment — its bytes are not returned to you, so you never read " +
      "them back.",
  );

const DownloadFileOutputSchema = z.object({
  fileId: z.string(),
  sandboxId: z.string(),
  path: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  stagingNotices: z
    .array(z.string())
    .describe(
      "Notices about chat attachments that could not be auto-staged (e.g. too " +
        "large). Empty when all attachments are available in the sandbox.",
    ),
  overwritten: z
    .boolean()
    .describe("True when an existing same-named file was replaced in place."),
});

const UploadSourceSchema = z.discriminatedUnion("type", [
  z
    .strictObject({
      type: z.literal("chat_attachment"),
      attachmentId: z
        .string()
        .min(1)
        .refine(
          (v) => isUuid(v),
          "must be the attachment's id, not its filename",
        )
        .describe(
          "Id of an attachment in the current conversation. The bytes are " +
            "copied directly and never enter your context.",
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
  z
    .strictObject({
      type: z.literal("my_file"),
      id: z
        .string()
        .trim()
        .refine(
          (v) => isUuid(v) || v.startsWith(OBJECT_REF_PREFIX),
          "must be a file id or ref from search_files",
        )
        .optional()
        .describe(
          "Id or ref of a persistent file, as returned by search_files " +
            "(`id` for stored files, `ref` for hand-placed ones).",
        ),
      filename: z
        .string()
        .min(1)
        .optional()
        .describe("Exact filename of a persistent file (when you have no id)."),
    })
    .refine((v) => (v.id != null) !== (v.filename != null), {
      message: "provide exactly one of `id` or `filename`",
    })
    .describe(
      "Copy a file from the user's persistent files into the " +
        "sandbox. Find files with search_files first.",
    ),
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
      "Where the file bytes come from. One of four shapes, each tagged by a " +
        '`type`: a chat attachment (`{"type":"chat_attachment","attachmentId":...}`), ' +
        'inline base64 (`{"type":"base64","dataBase64":...}`), inline text ' +
        '(`{"type":"text","text":"print(1)"}`), or a file from the user\'s ' +
        'persistent files (`{"type":"my_file","filename":...}`, found via ' +
        "search_files). Use this to place input bytes; to create a file the " +
        "sandbox will then run or read, write it with run_command instead.",
    ),
    target: SandboxTargetSchema,
  })
  .describe(
    "Place a file into the conversation's sandbox. The file persists in the " +
      "sandbox for every later command.",
  );

const UploadFileOutputSchema = z.object({
  uploadId: z.string(),
  sandboxId: z.string(),
  path: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
});

const SearchFilesSchema = z
  .strictObject({
    query: z
      .string()
      .optional()
      .describe(
        "Case-insensitive substring matched against filenames only. Omit it (or pass empty) to list the files (the first 200).",
      ),
  })
  .describe(
    "List or search the conversation's persistent files by filename substring; " +
      "omit the query to list the files (the first 200). Filenames only, not contents.",
  );

const SearchFilesOutputSchema = z.object({
  files: z.array(
    z.object({
      id: z
        .string()
        .nullable()
        .describe("Row id (UUID), or null for a hand-placed file with no row."),
      ref: z
        .string()
        .describe(
          "Stable handle for this file — pass it to read_file / upload_file / " +
            "edit_file / delete_file. Works for hand-placed files too (where " +
            "`id` is null).",
        ),
      filename: z.string(),
      mimeType: z.string(),
      sizeBytes: z.number(),
      createdAt: z.string(),
    }),
  ),
});

const ReadFileSchema = z
  .strictObject({
    id: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Id or ref of the file to read — the `id` or `ref` from search_files, " +
          "or a fileId from save_file.",
      ),
    filename: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Filename to read instead of `id`; rejected as ambiguous if more than one file shares the name.",
      ),
    offset: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("1-based line number to start reading from. Defaults to 1."),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        `Maximum number of lines to read. Defaults to ${READ_FILE_DEFAULT_LINES}.`,
      ),
  })
  .refine((v) => (v.id != null) !== (v.filename != null), {
    message: "provide exactly one of `id` or `filename`",
  })
  .describe(
    "Read a persistent file directly, without copying it into the sandbox. Text " +
      "files come back as numbered lines (`<n>\\t<line>`); images (PNG, JPEG, " +
      "WebP, GIF) are returned inline so you can view them. Identify the file by " +
      "`id` (the `id` or `ref` from search_files / save_file) or by `filename`. Page " +
      "large text files with `offset`/`limit`. For other binary types (PDF, archives, " +
      "…), copy the file into the sandbox with upload_file + run_command.",
  );

const ReadFileOutputSchema = z.object({
  kind: z
    .enum(["text", "image"])
    .describe(
      "`text` = numbered lines in the text content; `image` = the file is " +
        "returned as an inline image block.",
    ),
  fileId: z
    .string()
    .nullable()
    .describe("The file's id, or null for a hand-placed file with no row."),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  // text reads only
  totalLines: z.number().optional(),
  startLine: z.number().optional(),
  returnedLines: z.number().optional(),
  truncated: z
    .boolean()
    .optional()
    .describe(
      "True when more lines follow the returned window (raise `offset` to continue).",
    ),
});

const SaveFileSchema = z
  .strictObject({
    filename: z
      .string()
      .min(1)
      .max(256)
      .describe(
        'Plain filename including extension (e.g. "joke.md"). No paths.',
      ),
    content: z.string().optional().describe("UTF-8 text content of the file."),
    contentBase64: z
      .string()
      .min(1)
      .optional()
      .describe("Base64-encoded binary content."),
    mimeType: z
      .string()
      .min(1)
      .optional()
      .describe("Optional MIME type. Sniffed from the bytes when omitted."),
    overwrite: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Replace an existing file of the same name in place, keeping its id. " +
          "Default false errors if the name is already taken.",
      ),
  })
  .refine((v) => (v.content != null) !== (v.contentBase64 != null), {
    message: "provide exactly one of `content` or `contentBase64`",
  })
  .describe(
    "Write bytes you provide inline in this call (text or base64 in the arguments) to the " +
      "conversation's persistent files — for content originating in your reply. If the content " +
      "already exists as a file in the sandbox (you wrote it, or the user attached it), export it " +
      "with download_file by its path instead, so the bytes never enter your context.",
  );

const SaveFileOutputSchema = z.object({
  fileId: z.string(),
  filename: z.string(),
  projectName: z
    .string()
    .nullable()
    .describe("Owning project when saved in a project chat; null otherwise."),
  mimeType: z.string(),
  sizeBytes: z.number(),
  overwritten: z
    .boolean()
    .describe("True when an existing same-named file was replaced in place."),
});

const EditFileSchema = z
  .strictObject({
    id: z
      .string()
      .min(1)
      .optional()
      .describe("Id of the file to edit (from search_files / save_file)."),
    filename: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Filename to edit instead of `id`; rejected as ambiguous if more than one file shares the name.",
      ),
    old_string: z
      .string()
      .min(1)
      .describe(
        "The exact text to replace; must match the file's current content " +
          "(read it first with read_file). Include enough surrounding context to " +
          "be unique unless replace_all is set.",
      ),
    new_string: z
      .string()
      .describe("The text to insert in place of old_string."),
    replace_all: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Replace every occurrence of old_string. Default false replaces a single " +
          "occurrence and errors if old_string is not unique.",
      ),
  })
  .refine((v) => (v.id != null) !== (v.filename != null), {
    message: "provide exactly one of `id` or `filename`",
  })
  .refine((v) => v.old_string !== v.new_string, {
    message: "new_string must differ from old_string",
  })
  .describe(
    "Edit an existing persistent file by replacing a snippet, keeping " +
      "its id and filename. Give the exact `old_string` to find and the " +
      "`new_string` to put in its place; set `replace_all` to change every " +
      "occurrence. Text files only — to replace a binary file, use save_file " +
      "with overwrite.",
  );

const EditFileOutputSchema = z.object({
  fileId: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  replacements: z
    .number()
    .describe("How many occurrences of old_string were replaced."),
});

const DeleteFileSchema = z
  .strictObject({
    id: z
      .string()
      .min(1)
      .optional()
      .describe("Id of the file to delete (from search_files / save_file)."),
    filename: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Filename to delete instead of `id`; rejected as ambiguous if more than one file shares the name.",
      ),
  })
  .refine((v) => (v.id != null) !== (v.filename != null), {
    message: "provide exactly one of `id` or `filename`",
  })
  .describe("Permanently delete a persistent file.");

const DeleteFileOutputSchema = z.object({
  fileId: z.string(),
  filename: z.string(),
  deleted: z.literal(true),
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
      `disabled). Files the user attached to the conversation are staged under ${SKILL_SANDBOX_ATTACHMENTS_DIR}/. ` +
      "Loaded skills are mounted under /skills and are on PYTHONPATH, so " +
      "their modules import directly. Returns stdout, stderr, " +
      "exit code, and timing (text only — use download_file for generated " +
      "files).",
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
          environment: await resolveEnvironmentTarget(context),
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
      "Copy a file that already exists at a path in the conversation's sandbox into the " +
      "conversation's persistent files. Use this for anything on the sandbox's disk — a file " +
      "run_command wrote (text or binary) or a staged attachment under " +
      `${SKILL_SANDBOX_ATTACHMENTS_DIR}/ — its bytes are not returned to you, so you never read ` +
      "them back or re-type them. Pass `overwrite: true` to replace an existing same-named " +
      "persistent file in place.",
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

      let scope: ProjectFileScope | null;
      try {
        scope = await resolveProjectFileScope({
          conversationId: context.conversationId,
          userId: guard.userCtx.userId,
          organizationId: guard.userCtx.organizationId,
        });
      } catch (error) {
        return handleRuntimeError(error, resolved.sandboxId, "download_file");
      }

      try {
        const result = await skillSandboxRuntimeService.exportArtifact({
          sandboxId: resolved.sandboxId,
          caller: guard.userCtx,
          path: args.path,
          mimeType: args.mimeType,
          projectId: scope?.projectId ?? null,
          overwrite: args.overwrite,
          environment: await resolveEnvironmentTarget(context),
        });

        logger.info(
          {
            sandboxId: resolved.sandboxId,
            fileId: result.artifactId,
            sizeBytes: result.sizeBytes,
          },
          "[Sandbox] file downloaded",
        );

        // Bytes flow sandbox -> DB -> Files panel via the artifacts route; the
        // model only ever sees a short reference here, never the blob or a link.
        return structuredSuccessResult(
          {
            fileId: result.artifactId,
            sandboxId: result.sandboxId,
            path: result.path,
            mimeType: result.mimeType,
            sizeBytes: result.sizeBytes,
            stagingNotices: result.stagingNotices,
            overwritten: result.overwritten,
          },
          withStagingNotices(
            `${result.overwritten ? "Replaced" : "Saved"} ${result.path} (${result.sizeBytes} bytes) to the conversation's persistent files.`,
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
      "Place a file into the conversation's sandbox at a path, from a chat " +
      "attachment, inline base64, inline text, or one of your persistent " +
      "files. The file then persists in the sandbox for later commands. " +
      `Files the user attached to the conversation are already staged under ${SKILL_SANDBOX_ATTACHMENTS_DIR}/ — use this tool ` +
      "to write inline content, place a file at a specific path, or target a " +
      "non-default sandbox.",
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

      let uploadScope: ProjectFileScope | null;
      try {
        uploadScope = await resolveProjectFileScope({
          conversationId: context.conversationId,
          userId: guard.userCtx.userId,
          organizationId: guard.userCtx.organizationId,
        });
      } catch (error) {
        return handleRuntimeError(error, resolved.sandboxId, "upload_file");
      }

      const loaded = await loadUploadSource({
        source: args.source,
        userCtx: guard.userCtx,
        conversationId: context.conversationId,
        scope: uploadScope,
      });
      if ("error" in loaded) return errorResult(loaded.error);

      try {
        const result = await skillSandboxRuntimeService.uploadFile({
          sandboxId: resolved.sandboxId,
          path: args.path,
          data: loaded.data,
          mimeType: loaded.mimeType,
          originalName: loaded.originalName,
          // Tag the upload's origin: a PFS "my_file" pull vs an inline source.
          origin: args.source.type === "my_file" ? "my_file" : null,
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
  defineArchestraTool({
    shortName: TOOL_SEARCH_FILES_SHORT_NAME,
    title: "Search Files",
    description:
      "List or search the conversation's persistent files. The query is a " +
      "case-insensitive substring matched against filenames only, not contents — omit " +
      "it (or pass empty) to list the files (the first 200; narrow with a substring if " +
      "there are more). Returns metadata only — each result carries a stable `ref` you " +
      "pass to read_file, edit_file, or delete_file, or to upload_file to copy the file " +
      "into the sandbox.",
    schema: SearchFilesSchema,
    outputSchema: SearchFilesOutputSchema,
    async handler({ args, context }) {
      const guard = ensureUsable(context);
      if ("error" in guard) return errorResult(guard.error);

      let scope: ProjectFileScope | null;
      try {
        scope = await resolveProjectFileScope({
          conversationId: context.conversationId,
          userId: guard.userCtx.userId,
          organizationId: guard.userCtx.organizationId,
        });
      } catch (error) {
        if (error instanceof SkillSandboxError)
          return errorResult(error.message);
        throw error;
      }

      const fileScope = resolveChatFileScope(scope, context.conversationId);
      // A headless no-project call has no conversation to scope to — no files.
      if (!fileScope) {
        return structuredSuccessResult(
          { files: [] },
          "No persistent files matched.",
        );
      }
      const matches = await fileStore.search({
        organizationId: guard.userCtx.organizationId,
        userId: guard.userCtx.userId,
        scope: fileScope,
        query: args.query,
      });

      // Cap an empty/broad query so a large project can't dump its whole file list into context.
      const MAX_LISTED_FILES = 200;
      const shown = matches.slice(0, MAX_LISTED_FILES);
      const result = {
        files: shown.map((f) => ({
          id: f.id,
          ref: f.downloadRef,
          filename: f.filename,
          mimeType: f.mimeType,
          sizeBytes: f.sizeBytes,
          createdAt: f.createdAt.toISOString(),
        })),
      };
      const summary =
        matches.length === 0
          ? "No persistent files matched."
          : shown
              .map(
                (f) =>
                  `${f.filename} (${f.mimeType}, ${f.sizeBytes} bytes) ref=${f.downloadRef}`,
              )
              .join("\n") +
            (matches.length > MAX_LISTED_FILES
              ? `\n(showing the first ${MAX_LISTED_FILES} of ${matches.length}; narrow with a filename substring.)`
              : "");
      return structuredSuccessResult(result, summary);
    },
  }),
  defineArchestraTool({
    shortName: TOOL_READ_FILE_SHORT_NAME,
    title: "Read File",
    description:
      "Read a persistent file directly, without copying it into the sandbox. Text " +
      "files come back as numbered lines; images (PNG, JPEG, WebP, GIF) are " +
      "returned inline so you can view them. Identify the file by `id` (the `id` or " +
      "`ref` from search_files / save_file) or by `filename`. Page large text files " +
      "with `offset`/`limit`. For other binary types, copy the file into the sandbox " +
      "with upload_file and inspect it with run_command.",
    schema: ReadFileSchema,
    outputSchema: ReadFileOutputSchema,
    async handler({ args, context }) {
      const guard = ensureUsable(context);
      if ("error" in guard) return errorResult(guard.error);

      let scope: ProjectFileScope | null;
      try {
        scope = await resolveProjectFileScope({
          conversationId: context.conversationId,
          userId: guard.userCtx.userId,
          organizationId: guard.userCtx.organizationId,
        });
      } catch (error) {
        if (error instanceof SkillSandboxError)
          return errorResult(error.message);
        throw error;
      }

      const ref = args.id ?? args.filename ?? "";
      const fileScope = resolveChatFileScope(scope, context.conversationId);
      if (!fileScope) {
        return errorResult(describeMyFileError("not_found", ref));
      }
      const resolved = await fileStore.resolveMyFileSource({
        organizationId: guard.userCtx.organizationId,
        userId: guard.userCtx.userId,
        id: args.id,
        filename: args.filename,
        scope: fileScope,
      });
      if ("error" in resolved) {
        return errorResult(describeMyFileError(resolved.error, ref));
      }

      const { data, mimeType, originalName, fileId } = resolved;

      // Inline-safe raster image? Decide from the BYTES, not the (spoofable) mime
      // label — `claimed: undefined` means only a real PNG/JPEG/WebP/GIF signature
      // counts. Such files are returned as an image block the model can see.
      const imageMime = resolveArtifactMime({
        buffer: data,
        claimed: undefined,
      });
      if (isInlineSafeImageMime(imageMime)) {
        if (data.byteLength > READ_FILE_IMAGE_BYTES_LIMIT) {
          return errorResult(
            `"${originalName}" is too large to view inline (${data.byteLength} bytes > ${READ_FILE_IMAGE_BYTES_LIMIT} byte limit). ` +
              `Copy it into the sandbox with upload_file and inspect it with run_command.`,
          );
        }
        logger.info(
          { fileId, sizeBytes: data.byteLength, mimeType: imageMime },
          "[Sandbox] image read from PFS",
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `${originalName} (${imageMime}, ${data.byteLength} bytes)`,
            },
            {
              type: "image" as const,
              data: data.toString("base64"),
              mimeType: imageMime,
            },
          ],
          structuredContent: {
            kind: "image",
            fileId,
            filename: originalName,
            mimeType: imageMime,
            sizeBytes: data.byteLength,
          },
          isError: false,
        };
      }

      const limit = config.skillsSandbox.artifactBytesLimit;
      if (data.byteLength > limit) {
        return errorResult(
          `"${originalName}" is too large to read inline (${data.byteLength} bytes > ${limit} byte limit). ` +
            `Copy it into the sandbox with upload_file and inspect it with run_command.`,
        );
      }

      // Byte-level guard: the mime label is untrustworthy (a binary payload can be
      // saved as e.g. text/plain), so readability is decided by the bytes — only
      // NUL-free, valid UTF-8 is returned as text.
      const text = decodeUtf8Text(data);
      if (text === null) {
        return errorResult(
          `"${originalName}" (${mimeType}) is not text or a supported image. ` +
            `Copy it into the sandbox with upload_file and process it with run_command.`,
        );
      }

      if (data.byteLength === 0) {
        logger.info({ fileId, sizeBytes: 0 }, "[Sandbox] file read from PFS");
        return structuredSuccessResult(
          {
            kind: "text",
            fileId,
            filename: originalName,
            mimeType,
            sizeBytes: 0,
            totalLines: 0,
            startLine: 1,
            returnedLines: 0,
            truncated: false,
          },
          `"${originalName}" is empty.`,
        );
      }

      const startLine = args.offset ?? 1;
      const maxLines = args.limit ?? READ_FILE_DEFAULT_LINES;
      const numbered = numberLines({
        text,
        startLine,
        maxLines,
        byteLimit: config.skillsSandbox.outputBytesLimit,
      });
      const truncated =
        numbered.byteCapped ||
        startLine - 1 + numbered.returnedLines < numbered.totalLines;

      const summary: string[] = [];
      if (numbered.returnedLines > 0) {
        summary.push(numbered.body);
        if (truncated) {
          summary.push(
            "",
            `Output truncated (lines ${startLine}-${startLine + numbered.returnedLines - 1} of ${numbered.totalLines}); ` +
              "re-run read_file with a higher `offset` to read the rest.",
          );
        }
      } else if (numbered.byteCapped) {
        // The first in-window line alone exceeds the output cap, so nothing
        // could be rendered — explain rather than imply the range is empty.
        summary.push(
          `Line ${startLine} is too large to render inline (over the ${config.skillsSandbox.outputBytesLimit}-byte output cap). ` +
            `Copy it into the sandbox with upload_file and inspect it with run_command.`,
        );
      } else {
        // offset past end of file.
        summary.push(
          `No lines at offset ${startLine}; the file has ${numbered.totalLines} line${numbered.totalLines === 1 ? "" : "s"}.`,
        );
      }

      logger.info(
        {
          fileId,
          sizeBytes: data.byteLength,
          returnedLines: numbered.returnedLines,
        },
        "[Sandbox] file read from PFS",
      );

      return structuredSuccessResult(
        {
          kind: "text",
          fileId,
          filename: originalName,
          mimeType,
          sizeBytes: data.byteLength,
          totalLines: numbered.totalLines,
          startLine,
          returnedLines: numbered.returnedLines,
          truncated,
        },
        summary.join("\n"),
      );
    },
  }),
  defineArchestraTool({
    shortName: TOOL_SAVE_FILE_SHORT_NAME,
    title: "Save File",
    description:
      "Write bytes you are providing inline in this call — text or base64 included in the " +
      "arguments — to the conversation's persistent files. Use this for content that originates " +
      "in your reply: a summary or note you wrote, a short snippet you are typing out. If the " +
      "content already exists as a file in the sandbox — you wrote it with a command, or the user " +
      "attached it — do not read it back and paste its bytes here; export it with download_file by " +
      "its path instead, so the bytes never enter your context. Pass `overwrite: true` to replace " +
      "an existing same-named file in place (e.g. a full rewrite); otherwise a duplicate name is " +
      "rejected.",
    schema: SaveFileSchema,
    outputSchema: SaveFileOutputSchema,
    async handler({ args, context }) {
      const guard = ensureUsable(context);
      if ("error" in guard) return errorResult(guard.error);

      const filename = args.filename.trim();
      if (
        filename.includes("/") ||
        filename.includes("\\") ||
        filename.startsWith(".")
      ) {
        return errorResult(
          "filename must be a plain name without paths or a leading dot.",
        );
      }

      let data: Buffer;
      if (args.contentBase64 != null) {
        if (!BASE64_RE.test(args.contentBase64)) {
          return errorResult("contentBase64 is not valid base64.");
        }
        data = Buffer.from(args.contentBase64, "base64");
      } else {
        data = Buffer.from(args.content ?? "", "utf8");
      }
      // An empty file is allowed: the model may intentionally create a blank
      // file (parity with the in-place file editor and project instructions,
      // which both accept empty content). Only the byte cap is enforced.
      const limit = config.skillsSandbox.artifactBytesLimit;
      if (data.byteLength > limit) {
        return errorResult(
          `the file is too large (${data.byteLength} bytes > ${limit} byte limit).`,
        );
      }

      let scope: ProjectFileScope | null;
      try {
        scope = await resolveProjectFileScope({
          conversationId: context.conversationId,
          userId: guard.userCtx.userId,
          organizationId: guard.userCtx.organizationId,
        });
      } catch (error) {
        if (error instanceof SkillSandboxError) {
          return errorResult(error.message);
        }
        throw error;
      }

      const mimeType = resolveArtifactMime({
        buffer: data,
        claimed: args.mimeType,
      });

      // Overwrite: replace an existing same-named file in this scope in place,
      // keeping its id. Falls through to create when none
      // exists. Without overwrite, a duplicate name surfaces as an error below.
      // A headless no-project write resolves the orphan it created on a prior run
      // (no conversation/project scope), so re-runs stay idempotent.
      const fileScope = resolveChatFileScope(scope, context.conversationId);
      if (args.overwrite) {
        const existing = fileScope
          ? await fileStore.resolveMyFileRef({
              organizationId: guard.userCtx.organizationId,
              userId: guard.userCtx.userId,
              filename,
              scope: fileScope,
            })
          : await fileStore.resolveOrphanRef({
              organizationId: guard.userCtx.organizationId,
              userId: guard.userCtx.userId,
              filename,
            });
        if (!("error" in existing)) {
          const updated = await fileStore.update({
            file: existing,
            mimeType,
            sizeBytes: data.byteLength,
            data,
          });
          if (!updated) {
            return errorResult(describeMyFileError("not_found", filename));
          }
          return saveFileSuccess({
            row: updated,
            filename,
            scope,
            overwritten: true,
          });
        }
        if (existing.error !== "not_found") {
          return errorResult(describeMyFileError(existing.error, filename));
        }
        // not_found → create below.
      }

      try {
        const row = await fileStore.put({
          organizationId: guard.userCtx.organizationId,
          userId: guard.userCtx.userId,
          projectId: scope?.projectId ?? null,
          conversationId: context.conversationId ?? null,
          filename,
          mimeType,
          sizeBytes: data.byteLength,
          data,
        });
        return saveFileSuccess({ row, filename, scope, overwritten: false });
      } catch (error) {
        if (error instanceof FileNameExistsError) {
          return errorResult(
            `A file named "${filename}" already exists${scope ? ` in ${scope.projectName}` : ""}. Choose a different name, pass overwrite: true, or delete the existing file first.`,
          );
        }
        if (error instanceof UnsafePathError) {
          return errorResult(`"${filename}" is not a usable file name.`);
        }
        if (error instanceof SkillSandboxError) {
          return errorResult(error.message);
        }
        throw error;
      }
    },
  }),
  defineArchestraTool({
    shortName: TOOL_EDIT_FILE_SHORT_NAME,
    title: "Edit File",
    description:
      "Edit an existing persistent file by replacing a snippet, " +
      "keeping its id and filename. Give the exact `old_string` to find (read " +
      "the file first with read_file) and the `new_string` to put in its place; " +
      "set `replace_all` to change every occurrence. Identify the file by `id` " +
      "(from search_files / save_file) or by `filename`. Text files only — to " +
      "replace a binary file, use save_file with overwrite for inline content, or " +
      "download_file with overwrite for a file in the sandbox.",
    schema: EditFileSchema,
    outputSchema: EditFileOutputSchema,
    async handler({ args, context }) {
      const guard = ensureUsable(context);
      if ("error" in guard) return errorResult(guard.error);

      let scope: ProjectFileScope | null;
      try {
        scope = await resolveProjectFileScope({
          conversationId: context.conversationId,
          userId: guard.userCtx.userId,
          organizationId: guard.userCtx.organizationId,
        });
      } catch (error) {
        if (error instanceof SkillSandboxError)
          return errorResult(error.message);
        throw error;
      }

      const ref = args.id ?? args.filename ?? "";
      const fileScope = resolveChatFileScope(scope, context.conversationId);
      if (!fileScope) {
        return errorResult(describeMyFileError("not_found", ref));
      }
      const resolved = await fileStore.resolveMyFileRef({
        organizationId: guard.userCtx.organizationId,
        userId: guard.userCtx.userId,
        id: args.id,
        filename: args.filename,
        scope: fileScope,
      });
      if ("error" in resolved) {
        return errorResult(describeMyFileError(resolved.error, ref));
      }

      // Read the current bytes through the facade (it re-authorizes the row we
      // just resolved). Gone bytes surface as a clear model-facing message.
      let current: Awaited<ReturnType<typeof fileStore.get>>;
      try {
        current = await fileStore.get({
          ref: resolved.id,
          organizationId: guard.userCtx.organizationId,
          userId: guard.userCtx.userId,
        });
      } catch (error) {
        if (error instanceof FileBytesMissingError) {
          return errorResult(describeMyFileError("missing_bytes", ref));
        }
        throw error;
      }
      if (!current) {
        return errorResult(describeMyFileError("not_found", ref));
      }

      const text = decodeUtf8Text(current.data);
      if (text === null) {
        return errorResult(
          `edit_file edits text files only; "${resolved.filename}" (${resolved.mimeType}) is not UTF-8 text. Replace it wholesale with save_file (overwrite: true).`,
        );
      }

      const occurrences = countOccurrences(text, args.old_string);
      if (occurrences === 0) {
        return errorResult(
          `old_string was not found in "${resolved.filename}". Read it with read_file and copy the exact text to replace.`,
        );
      }
      if (occurrences > 1 && !args.replace_all) {
        return errorResult(
          `old_string is not unique in "${resolved.filename}" (${occurrences} occurrences). Add surrounding context to make it unique, or set replace_all: true.`,
        );
      }
      const replacements = args.replace_all ? occurrences : 1;
      const updatedText = args.replace_all
        ? text.split(args.old_string).join(args.new_string)
        : replaceFirst(text, args.old_string, args.new_string);
      const data = Buffer.from(updatedText, "utf8");
      const limit = config.skillsSandbox.artifactBytesLimit;
      if (data.byteLength > limit) {
        return errorResult(
          `the edited file is too large (${data.byteLength} bytes > ${limit} byte limit).`,
        );
      }

      // Keep the stored mime — a snippet edit of a text file never changes type.
      const updated = await fileStore.update({
        file: resolved,
        mimeType: resolved.mimeType,
        sizeBytes: data.byteLength,
        data,
      });
      if (!updated) {
        return errorResult(describeMyFileError("not_found", ref));
      }

      logger.info(
        {
          fileId: updated.id,
          sizeBytes: updated.sizeBytes,
          replacements,
          projectScoped: !!scope,
        },
        "[Sandbox] file edited in PFS",
      );

      return structuredSuccessResult(
        {
          fileId: updated.id,
          filename: updated.filename,
          mimeType: updated.mimeType,
          sizeBytes: updated.sizeBytes,
          replacements,
        },
        `Updated ${updated.filename} (${replacements} replacement${replacements === 1 ? "" : "s"}, ${updated.sizeBytes} bytes).`,
      );
    },
  }),
  defineArchestraTool({
    shortName: TOOL_DELETE_FILE_SHORT_NAME,
    title: "Delete File",
    description:
      "Permanently delete a persistent file, identified by `id` " +
      "(from search_files / save_file) or by `filename`.",
    schema: DeleteFileSchema,
    outputSchema: DeleteFileOutputSchema,
    async handler({ args, context }) {
      const guard = ensureUsable(context);
      if ("error" in guard) return errorResult(guard.error);

      let scope: ProjectFileScope | null;
      try {
        scope = await resolveProjectFileScope({
          conversationId: context.conversationId,
          userId: guard.userCtx.userId,
          organizationId: guard.userCtx.organizationId,
        });
      } catch (error) {
        if (error instanceof SkillSandboxError)
          return errorResult(error.message);
        throw error;
      }

      const ref = args.id ?? args.filename ?? "";
      const fileScope = resolveChatFileScope(scope, context.conversationId);
      if (!fileScope) {
        return errorResult(describeMyFileError("not_found", ref));
      }
      const resolved = await fileStore.resolveMyFileRef({
        organizationId: guard.userCtx.organizationId,
        userId: guard.userCtx.userId,
        id: args.id,
        filename: args.filename,
        scope: fileScope,
      });
      if ("error" in resolved) {
        return errorResult(describeMyFileError(resolved.error, ref));
      }
      // The project instructions file is available but never deletable — refuse
      // up front with the canonical message (the store would otherwise throw,
      // and this call site is not wrapped to surface it).
      if (
        resolved.projectId &&
        resolved.filename === PROJECT_INSTRUCTIONS_FILENAME
      ) {
        return errorResult(
          new FileNotDeletableError(resolved.filename).message,
        );
      }

      const deleted = await fileStore.delete({
        ref: resolved.id,
        organizationId: guard.userCtx.organizationId,
        userId: guard.userCtx.userId,
      });
      if (!deleted) {
        return errorResult(describeMyFileError("not_found", ref));
      }

      logger.info(
        { fileId: resolved.id, projectScoped: !!scope },
        "[Sandbox] file deleted from PFS",
      );

      return structuredSuccessResult(
        { fileId: resolved.id, filename: resolved.filename, deleted: true },
        `Deleted ${resolved.filename}.`,
      );
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
 * Resolve the Dagger runner host for the calling agent's Environment, so its
 * sandbox runs on that environment's per-env engine (with the environment's
 * egress NetworkPolicy). Returns undefined when the agent has no environment,
 * the environment is missing, or k8s isn't configured — the run then uses the
 * process-default engine.
 */
async function resolveEnvironmentTarget(
  context: ArchestraContext,
): Promise<EnvironmentTarget | undefined> {
  const { organizationId } = context;
  const agentId = context.agent?.id;
  if (!agentId || !organizationId) return undefined;

  const agent = await AgentModel.findById(agentId);
  // Unbound agent → no environment isolation requested; the default engine is
  // the correct runtime.
  if (!agent?.environmentId) return undefined;

  // The agent IS bound to an environment, so its sandbox MUST run on that
  // environment's isolated engine (carrying the environment's egress policy).
  // Fail closed if that engine can't be resolved — never fall back to the shared
  // default engine, which would run the agent's code with unrestricted egress
  // and silently defeat the environment's network isolation.
  const environment = await EnvironmentModel.findByIdForOrganization(
    agent.environmentId,
    organizationId,
  );
  if (!environment) {
    throw new Error(
      `Agent is bound to environment ${agent.environmentId}, which was not found — refusing to run on the shared runtime.`,
    );
  }
  const target =
    daggerEnvironmentRuntimeManager.environmentTargetForEnvironment(
      environment,
    );
  if (!target) {
    throw new Error(
      `Could not resolve the isolated runtime for environment "${environment.name}" — refusing to run on the shared runtime. Is the orchestrator (Kubernetes) configured?`,
    );
  }
  return target;
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
 * Map a loosely-typed {@link SandboxTarget} to a canonical intent. Models often
 * express "the default sandbox" as `{ fresh: false }`, `{ id: "" }`, or `{}`, so
 * those collapse to the default (undefined). `fresh: true` wins over an id; a
 * non-empty id is validated as a UUID and otherwise reported clearly.
 */
function normalizeTarget(
  target: SandboxTarget,
): { intent: SandboxTargetIntent } | { error: string } {
  if (!target) {
    return { intent: undefined };
  }
  if (target.fresh === true) {
    return { intent: { fresh: true } };
  }
  const id = target.id?.trim();
  if (id) {
    if (!isUuid(id)) {
      return {
        error: `target.id must be a sandbox id (UUID). Omit \`target\` to use the conversation's default sandbox, or pass \`target: { fresh: true }\` to create a new one.`,
      };
    }
    return { intent: { id } };
  }
  // `{ fresh: false }`, `{ id: "" }`, or `{}` — the model meant the default.
  return { intent: undefined };
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

  const normalized = normalizeTarget(target);
  if ("error" in normalized) {
    return { error: normalized.error };
  }
  const intent = normalized.intent;

  if (intent && "id" in intent) {
    const sandbox = await SkillSandboxModel.findById(intent.id);
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
          targetId: intent.id,
          reason: "out_of_scope_sandbox_id",
        },
        "[Sandbox] rejected out-of-scope sandbox id",
      );
      return {
        error: `No accessible sandbox with id ${intent.id} exists. Omit \`target\` to use the conversation's default sandbox, or pass \`target: { fresh: true }\` to create a new one.`,
      };
    }
    return { sandboxId: asSandboxId(sandbox.id) };
  }

  if (intent && "fresh" in intent) {
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
  if (error instanceof FileNameExistsError) {
    return errorResult(
      `${error.message}. Choose a different name, pass overwrite: true, or delete the existing file first.`,
    );
  }
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
 * Decode bytes as text for read_file / edit_file, or null when they are not
 * safe to treat as text. The mime label is never trusted (a binary payload can
 * be saved as e.g. text/plain), so readability is decided by the bytes: a NUL
 * byte or any invalid UTF-8 sequence means "binary".
 */
function decodeUtf8Text(data: Buffer): string | null {
  if (data.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return null;
  }
}

/** Count non-overlapping occurrences of a non-empty needle (literal). */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  return haystack.split(needle).length - 1;
}

/** Replace the first literal occurrence of `needle` (no regex/`$` semantics). */
function replaceFirst(
  haystack: string,
  needle: string,
  replacement: string,
): string {
  const i = haystack.indexOf(needle);
  if (i === -1) return haystack;
  return haystack.slice(0, i) + replacement + haystack.slice(i + needle.length);
}

/**
 * Render a `cat -n`-style window of `text` (line number + tab + content),
 * starting at 1-based `startLine`, at most `maxLines` lines, stopping early if
 * the rendered output would exceed `byteLimit`. A single trailing newline is
 * dropped so a newline-terminated file isn't reported with a phantom blank last
 * line (matching `cat -n`).
 */
function numberLines(params: {
  text: string;
  startLine: number;
  maxLines: number;
  byteLimit: number;
}): {
  body: string;
  returnedLines: number;
  totalLines: number;
  byteCapped: boolean;
} {
  const trimmed = params.text.endsWith("\n")
    ? params.text.slice(0, -1)
    : params.text;
  const all = trimmed.split("\n");
  const totalLines = all.length;
  const from = Math.min(Math.max(params.startLine - 1, 0), totalLines);
  const window = all.slice(from, from + params.maxLines);
  const out: string[] = [];
  let bytes = 0;
  let byteCapped = false;
  for (let i = 0; i < window.length; i++) {
    const rendered = `${from + i + 1}\t${window[i]}`;
    const add =
      (out.length === 0 ? 0 : 1) + Buffer.byteLength(rendered, "utf8");
    if (bytes + add > params.byteLimit) {
      byteCapped = true;
      break;
    }
    bytes += add;
    out.push(rendered);
  }
  return {
    body: out.join("\n"),
    returnedLines: out.length,
    totalLines,
    byteCapped,
  };
}

/** Build the save_file success result for both the create and overwrite paths. */
function saveFileSuccess(params: {
  row: PersistedFile;
  filename: string;
  scope: ProjectFileScope | null;
  overwritten: boolean;
}) {
  const { row, filename, scope, overwritten } = params;
  logger.info(
    {
      fileId: row.id,
      sizeBytes: row.sizeBytes,
      projectScoped: !!scope,
      overwritten,
    },
    "[Sandbox] result saved to PFS",
  );
  return structuredSuccessResult(
    {
      fileId: row.id,
      filename,
      projectName: scope?.projectName ?? null,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      overwritten,
    },
    `${overwritten ? "Overwrote" : "Saved"} ${scope ? `${scope.projectName}/` : ""}${filename} (${row.sizeBytes} bytes)${overwritten ? " in place" : " to persistent files"}.`,
  );
}

/** Map a my_file resolution failure to a model-facing message. */
/**
 * The My Files scope a chat's file tools operate in: the owning project for a
 * project chat, otherwise the current conversation. Returns null for a headless
 * no-project call (no conversation to scope to) — no-project file tools then
 * have nothing to read, and a no-project write falls back to a flat orphan.
 */
function resolveChatFileScope(
  projectScope: ProjectFileScope | null,
  conversationId: string | undefined,
):
  | { kind: "project"; projectId: string; projectName: string }
  | { kind: "conversation"; conversationId: string }
  | null {
  if (projectScope) {
    return {
      kind: "project",
      projectId: projectScope.projectId,
      projectName: projectScope.projectName,
    };
  }
  return conversationId ? { kind: "conversation", conversationId } : null;
}

function describeMyFileError(
  error: MyFileResolutionError["error"],
  ref: string,
): string {
  switch (error) {
    case "ambiguous":
      return `Multiple persistent files are named "${ref}". Run search_files and use the \`id\` of the one you mean.`;
    case "outside_project":
      return "This chat belongs to a project; only the project's files can be used here. Run search_files to see them.";
    case "missing_bytes":
      return `The persistent file ${ref} exists but its bytes are no longer in storage.`;
    default:
      return `No persistent file ${ref} exists. Run search_files to see what is available.`;
  }
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
  /** Project file scope of the conversation; confines my_file resolution. */
  scope: ProjectFileScope | null;
}): Promise<LoadedUpload | { error: string }> {
  const { source, userCtx, conversationId, scope } = params;
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
      // A filename or other non-UUID can't be an attachment id. Reject it here:
      // the id column is uuid-typed, so querying it with a non-UUID throws an
      // unhandled Postgres error that aborts the whole turn instead of
      // surfacing as the graceful "no such attachment" result below.
      if (!isUuid(source.attachmentId)) {
        logger.warn(
          {
            organizationId: userCtx.organizationId,
            userId: userCtx.userId,
            conversationId,
            attachmentId: source.attachmentId,
            reason: "attachment_id_not_uuid",
          },
          "[Sandbox] rejected chat_attachment upload",
        );
        return {
          error: `No accessible attachment with id "${source.attachmentId}" exists. Pass the attachment's id, not its filename.`,
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
    case "my_file": {
      const fileScope = resolveChatFileScope(scope, conversationId);
      const ref = source.id ?? source.filename ?? "";
      if (!fileScope) {
        return { error: describeMyFileError("not_found", ref) };
      }
      const resolved = await fileStore.resolveMyFileSource({
        organizationId: userCtx.organizationId,
        userId: userCtx.userId,
        id: source.id,
        filename: source.filename,
        scope: fileScope,
      });
      if ("error" in resolved) {
        logger.warn(
          {
            organizationId: userCtx.organizationId,
            userId: userCtx.userId,
            conversationId,
            ref,
            reason: resolved.error,
          },
          "[Sandbox] rejected my_file upload",
        );
        return { error: describeMyFileError(resolved.error, ref) };
      }
      return {
        data: resolved.data,
        mimeType: resolved.mimeType,
        originalName: resolved.originalName,
      };
    }
  }
}

function formatCommandSummary(result: {
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
  binaryStripped: boolean;
  stdout: string;
  stderr: string;
}): string {
  const lines = [`Exit code: ${result.exitCode} (${result.durationMs} ms)`];
  if (result.timedOut) {
    lines.push("The command was killed by the wall-clock timeout.");
  }
  if (result.truncated) {
    lines.push(
      "Output was truncated; re-run with a narrower command " +
        "(grep/head/tail/sed) to read the rest.",
    );
  }
  if (result.binaryStripped) {
    lines.push(
      "stdout/stderr held binary (NUL) bytes that were removed before " +
        "storage, so the text below is incomplete. Redirect binary output to " +
        "a file (`> out`) and fetch it with download_file, or inspect bytes " +
        "with `xxd`/`wc -c`.",
    );
  }
  lines.push("", "stdout:", result.stdout || "(empty)");
  // On a non-zero exit always surface a stderr section (marked empty when truly
  // blank) — symmetric to stdout, so a failing command never leaves the agent
  // unable to tell "no stderr" from "stderr withheld". On success keep it terse:
  // only show stderr when there is something to show.
  if (result.stderr || result.exitCode !== 0) {
    lines.push("", "stderr:", result.stderr || "(empty)");
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
