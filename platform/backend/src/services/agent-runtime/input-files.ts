import type { A2AAttachment } from "@/agents/a2a-executor";
import { AgentRunInputModel } from "@/models";
import type { AgentRunInput } from "@/types";
import {
  nextAvailableName,
  sanitizeUploadFilename,
} from "@/utils/upload-filename";
import {
  AGENT_RUNTIME_ATTACHMENTS_DIR,
  agentRuntimeAttachmentsManifestPath,
} from "./runtime-contract";

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
        runtimePath: `${AGENT_RUNTIME_ATTACHMENTS_DIR}/${params.taskId}/${safeName}`,
        mimeType: attachment.contentType,
        fileSize: fileData.byteLength,
        fileData,
      };
    }),
  );
}

/** Refer to staged inputs without triggering native clients' image-paste handlers. */
export function taskWithAgentRunInputs(params: {
  taskId: string;
  task: string | null | undefined;
  inputs: AgentRunInput[];
}): string | null | undefined {
  if (params.inputs.length === 0) return params.task;
  // The manifest is staged before startup for every runtime. Keep attachment
  // paths out of the prompt: some TUIs expand image paths asynchronously and
  // can swallow the submit key while doing so. Read files through normal tools
  // after submission instead, independently of the client's input handling.
  return `${params.task ?? ""}\n\nAttached files for this turn are listed in ${agentRuntimeAttachmentsManifestPath(params.taskId)}. Read the manifest, then use your file tools to inspect the relevant attachments.`.trim();
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
