import type { A2AAttachment } from "@/agents/a2a-executor";
import { AgentExecutionInputModel } from "@/models";
import type { AgentExecutionInput } from "@/types";
import {
  nextAvailableName,
  sanitizeUploadFilename,
} from "@/utils/upload-filename";
import { RUNNER_ATTACHMENTS_DIR } from "./runtime-contract";

/** Persist browser/messaging inputs before the detached task is allowed to run. */
export async function persistAgentExecutionInputs(params: {
  taskId: string;
  organizationId: string;
  uploadedByUserId: string | null;
  attachments: A2AAttachment[];
}): Promise<AgentExecutionInput[]> {
  const usedNames = new Set<string>();
  return AgentExecutionInputModel.createMany(
    params.attachments.map((attachment, index) => {
      const originalName = attachment.name?.trim() || `attachment-${index + 1}`;
      const safeName = uniqueRuntimeName({
        originalName,
        usedNames,
      });
      const fileData = Buffer.from(attachment.contentBase64, "base64");
      return {
        organizationId: params.organizationId,
        taskId: params.taskId,
        uploadedByUserId: params.uploadedByUserId,
        originalName,
        runtimePath: `${RUNNER_ATTACHMENTS_DIR}/${safeName}`,
        mimeType: attachment.contentType,
        fileSize: fileData.byteLength,
        fileData,
      };
    }),
  );
}

/** Add stable paths to the instruction without rewriting the persisted prompt. */
export function taskWithAgentExecutionInputs(params: {
  task: string | null | undefined;
  inputs: AgentExecutionInput[];
}): string | null | undefined {
  if (params.inputs.length === 0) return params.task;
  const paths = params.inputs
    .map((input) => `- ${input.runtimePath}`)
    .join("\n");
  return `${params.task ?? ""}\n\nAttached files are available in the execution workspace:\n${paths}`.trim();
}

// === Internal helpers ===

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
