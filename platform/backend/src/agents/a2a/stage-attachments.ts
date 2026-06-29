import crypto from "node:crypto";
import type { A2AAttachment } from "@/agents/a2a-executor";
import logger from "@/logging";
import { SkillSandboxModel } from "@/models";
import { executionSandboxRegistry } from "@/skills-sandbox/execution-sandbox-registry";
import { SKILL_SANDBOX_HOME } from "@/skills-sandbox/runtime-image";
import {
  assignAttachmentPaths,
  skillSandboxRuntimeService,
} from "@/skills-sandbox/skill-sandbox-runtime-service";
import { asSandboxId, type SkillSandbox } from "@/types";

/** A staged attachment's in-sandbox path, or an error marker for that slot. */
export type StageResult = { path: string } | { error: true };

/**
 * Stage raw chatops/email attachments into the agent's default sandbox so the
 * model can read them with `run_command`. The target mirrors how `run_command`
 * itself resolves the default sandbox (`archestra-mcp-server/sandbox.ts`
 * `resolveTarget`): the conversation default when a `conversationId` is in
 * scope, otherwise the per-execution sandbox keyed by `isolationKey` — so the
 * pointer paths always reference the sandbox the model will actually open.
 * Results are aligned to the input order; a sandbox-creation or per-file upload
 * failure yields an `{ error }` marker for that slot (the caller notes it)
 * rather than throwing the turn.
 */
export async function stageAttachmentsIntoSandbox(params: {
  attachments: A2AAttachment[];
  organizationId: string;
  userId: string;
  conversationId: string | null;
  isolationKey: string;
  agentId: string;
}): Promise<StageResult[]> {
  const {
    attachments,
    organizationId,
    userId,
    conversationId,
    isolationKey,
    agentId,
  } = params;

  let sandbox: SkillSandbox;
  try {
    sandbox = conversationId
      ? await SkillSandboxModel.findOrCreateDefault({
          organizationId,
          userId,
          conversationId,
          defaultCwd: SKILL_SANDBOX_HOME,
        })
      : await executionSandboxRegistry.getOrCreateDefault({
          organizationId,
          userId,
          isolationKey,
          defaultCwd: SKILL_SANDBOX_HOME,
        });
  } catch (error) {
    logger.error(
      { err: error, agentId, conversationId, isolationKey },
      "[A2A] failed to create sandbox for attachment staging",
    );
    return attachments.map(() => ({ error: true as const }));
  }

  // Reuse the chat staging path's collision-safe filename mapping; synthetic
  // per-index ids keep every attachment on its own path even when names repeat.
  const pathByIndexId = assignAttachmentPaths(
    attachments.map((att, i) => ({
      id: `a2a-${i}`,
      originalName: att.name ?? null,
    })),
  );

  return Promise.all(
    attachments.map(async (att, i): Promise<StageResult> => {
      const path = pathByIndexId.get(`a2a-${i}`);
      if (!path) {
        return { error: true };
      }
      try {
        const data = Buffer.from(att.contentBase64, "base64");
        const ref = await skillSandboxRuntimeService.uploadFile({
          sandboxId: asSandboxId(sandbox.id),
          path,
          data,
          mimeType: att.contentType,
          originalName: att.name,
          dedupeId: dedupeIdForBytes(data),
        });
        return { path: ref.path };
      } catch (error) {
        logger.error(
          { err: error, agentId, name: att.name, contentType: att.contentType },
          "[A2A] failed to stage attachment into sandbox",
        );
        return { error: true };
      }
    }),
  );
}

/**
 * Deterministic UUIDv5-shaped id derived from the file bytes, so an identical
 * attachment appearing more than once in one turn (e.g. the current message plus
 * replayed thread history) is staged once via `uploadFile`'s dedupe index.
 */
function dedupeIdForBytes(data: Buffer): string {
  const hash = crypto.createHash("sha256").update(data).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
