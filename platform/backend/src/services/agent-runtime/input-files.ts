import { createHash } from "node:crypto";
import type { A2AAttachment } from "@/agents/a2a-executor";
import { CHATOPS_ATTACHMENT_LIMITS } from "@/agents/chatops/constants";
import { AgentRunInputModel } from "@/models";
import { resolveArtifactMime } from "@/skills-sandbox/mime-sniff";
import { type AgentRunInput, ApiError } from "@/types";
import {
  nextAvailableName,
  sanitizeUploadFilename,
} from "@/utils/upload-filename";
import type { RuntimeInputFile } from "./backends/types";
import {
  AGENT_RUNTIME_ATTACHMENTS_DIR,
  AGENT_RUNTIME_THREAD_FILES_DIR,
} from "./runtime-contract";

/** Persist browser/messaging inputs before the detached task is allowed to run. */
export async function persistAgentRunInputs(params: {
  taskId: string;
  organizationId: string;
  uploadedByUserId: string | null;
  attachments: A2AAttachment[];
}): Promise<AgentRunInput[]> {
  return AgentRunInputModel.createMany(
    buildRuntimeInputs({
      attachments: params.attachments,
      root: `${AGENT_RUNTIME_ATTACHMENTS_DIR}/${params.taskId}`,
      originals: false,
    }).map((input) => ({
      ...input,
      organizationId: params.organizationId,
      taskId: params.taskId,
      uploadedByUserId: params.uploadedByUserId,
    })),
  );
}

export function buildEphemeralAgentRunInputs(params: {
  taskId: string;
  attachments: A2AAttachment[];
}): RuntimeInputFile[] {
  const limits = CHATOPS_ATTACHMENT_LIMITS;
  if (params.attachments.length > limits.MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new ApiError(400, "Too many files for this Slack runtime execution");
  }
  let totalBytes = 0;
  for (const attachment of params.attachments) {
    const size =
      attachment.originalFile?.data.length ??
      Buffer.byteLength(attachment.contentBase64, "base64");
    totalBytes += size;
    const maximum = attachment.originalFile
      ? limits.MAX_THREAD_FILE_SIZE
      : limits.MAX_ATTACHMENT_SIZE;
    if (size > maximum || totalBytes > limits.MAX_TOTAL_ATTACHMENTS_SIZE) {
      throw new ApiError(
        400,
        "Files exceed this Slack runtime execution's attachment limit",
      );
    }
  }
  return buildRuntimeInputs({
    attachments: params.attachments,
    root: `${AGENT_RUNTIME_THREAD_FILES_DIR}/${params.taskId}/inputs`,
    originals: true,
  });
}

/** Add stable paths to the instruction without rewriting the persisted prompt. */
export function taskWithAgentRunInputs(params: {
  task: string | null | undefined;
  inputs: RuntimeInputFile[];
  ephemeralTaskId?: string;
}): string | null | undefined {
  if (params.ephemeralTaskId) {
    const root = `${AGENT_RUNTIME_THREAD_FILES_DIR}/${params.ephemeralTaskId}`;
    const paths = params.inputs.map((input) =>
      JSON.stringify({
        path: input.runtimePath.slice(root.length + 1),
        filename: input.originalName,
        sizeBytes: input.fileSize,
        sha256: createHash("sha256").update(input.fileData).digest("hex"),
      }),
    );
    return [
      params.task ?? "",
      `Temporary Slack files are available under ${root}/.`,
      ...paths,
      `Create or modify files under ${root}/outputs/. Files are temporary. Cleanup is attempted when this run ends; deleting its compute removes them.`,
      `To send an original or generated file to this task's Slack thread, compute its SHA256 locally and call post_run_file with task_id ${params.ephemeralTaskId}, path relative to ${root}/, sha256, and optional comment. Files must be nonempty and at most 20 MiB. Do not read or encode file bytes into tool arguments or copy them to the retained workspace.`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  if (params.inputs.length === 0) return params.task;
  const paths = params.inputs
    .map((input) => `- ${input.runtimePath}`)
    .join("\n");
  return `${params.task ?? ""}\n\nAttached files are available in the run workspace:\n${paths}`.trim();
}

// === Internal helpers ===

function buildRuntimeInputs(params: {
  attachments: A2AAttachment[];
  root: string;
  originals: boolean;
}): RuntimeInputFile[] {
  const usedNames = new Set<string>();
  return params.attachments.map((attachment, index) => {
    const original = params.originals ? attachment.originalFile : undefined;
    const originalName =
      original?.filename ||
      attachment.name?.trim() ||
      `attachment-${index + 1}`;
    const safeName = uniqueRuntimeName({
      originalName,
      usedNames,
    });
    const fileData = original
      ? Buffer.from(original.data)
      : Buffer.from(attachment.contentBase64, "base64");
    return {
      originalName,
      runtimePath: `${params.root}/${safeName}`,
      mimeType: original
        ? resolveArtifactMime({ buffer: fileData, claimed: undefined })
        : attachment.contentType,
      fileSize: fileData.byteLength,
      fileData,
    };
  });
}

function uniqueRuntimeName(params: {
  originalName: string;
  usedNames: Set<string>;
}): string {
  const safeName = sanitizeUploadFilename(params.originalName);
  let candidate = safeName;
  let attempt = 1;
  while (params.usedNames.has(candidate)) {
    candidate = nextAvailableName(safeName, attempt);
    attempt += 1;
  }
  params.usedNames.add(candidate);
  return candidate;
}
