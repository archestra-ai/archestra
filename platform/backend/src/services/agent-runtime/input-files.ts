import type { A2AAttachment } from "@/agents/a2a-executor";
import { AgentRunInputModel } from "@/models";
import { extensionFromMime } from "@/skills-sandbox/mime-sniff";
import type { AgentRunInput } from "@/types";
import {
  nextAvailableName,
  sanitizeUploadFilename,
} from "@/utils/upload-filename";
import { AGENT_RUNTIME_ATTACHMENTS_DIR } from "./runtime-contract";

/** Persist browser/messaging inputs before the detached task is allowed to run. */
export async function persistAgentRunInputs(params: {
  taskId: string;
  organizationId: string;
  uploadedByUserId: string | null;
  attachments: A2AAttachment[];
}): Promise<AgentRunInput[]> {
  const usedNames = new Set<string>();
  return AgentRunInputModel.createMany(
    params.attachments.map((attachment, index) => {
      const originalName =
        attachment.name?.trim() ||
        fallbackAttachmentName({ attachment, position: index + 1 });
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
        runtimePath: `${AGENT_RUNTIME_ATTACHMENTS_DIR}/${params.taskId}/${safeName}`,
        mimeType: attachment.contentType,
        fileSize: fileData.byteLength,
        fileData,
      };
    }),
  );
}

/** Add stable paths to the instruction without rewriting the persisted prompt. */
export function taskWithAgentRunInputs(params: {
  task: string | null | undefined;
  inputs: AgentRunInput[];
}): string | null | undefined {
  if (params.inputs.length === 0) return params.task;
  // The type rides along so an agent can tell an image from a text file
  // even when its name says nothing (a pasted screenshot has no filename).
  const paths = params.inputs
    .map((input) => `- ${input.runtimePath} (${input.mimeType})`)
    .join("\n");
  return `${params.task ?? ""}\n\nAttached files are available for this run:\n${paths}`.trim();
}

// === Internal helpers ===

/**
 * A name for an attachment that arrived without one, such as an image pasted
 * into a chat message. The extension matches its type, so tools that pick a
 * reader by extension open the image as an image.
 */
function fallbackAttachmentName(params: {
  attachment: A2AAttachment;
  position: number;
}): string {
  const extension = extensionFromMime(params.attachment.contentType);
  const base = `attachment-${params.position}`;
  return extension ? `${base}.${extension}` : base;
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
