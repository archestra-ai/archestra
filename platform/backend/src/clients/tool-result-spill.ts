import logger from "@/logging";
import { SkillSandboxModel } from "@/models";
import { isSkillSandboxAvailableForAgent } from "@/skills/skill-sandbox-availability";
import { SKILL_SANDBOX_HOME } from "@/skills-sandbox/runtime-image";
import { skillSandboxRuntimeService } from "@/skills-sandbox/skill-sandbox-runtime-service";
import { asSandboxId } from "@/types";
import {
  CAPPED_TOOL_RESULT_META_KEY,
  type CappedToolResult,
  capToolResultText,
  MAX_TOOL_RESULT_CONTEXT_BYTES,
  utf8Length,
} from "@/utils/tool-result-cap";
import { uuidv5 } from "@/utils/uuid";

type ToolResult = string | { content: string; [key: string]: unknown };

/**
 * Bounds a chat tool result to {@link MAX_TOOL_RESULT_CONTEXT_BYTES} of
 * model-facing text, appending PostToolUse `hookFeedback` when present. An
 * oversized result is saved in full to the conversation's default sandbox so
 * the model can grep it with `run_command`; when that is not possible the
 * result is just truncated. Rich fields other than `content` stay intact for
 * the UI and the result is marked so history replay sends the capped text only.
 */
export async function capChatToolResult(params: {
  result: ToolResult;
  hookFeedback: string | null;
  context: SpillContext;
  toolCallId: string | undefined;
}): Promise<ToolResult> {
  const { result, hookFeedback, context, toolCallId } = params;
  const text = typeof result === "string" ? result : result.content;
  const suffix = hookFeedback ? `\n\n[hook feedback] ${hookFeedback}` : "";
  if (utf8Length(text + suffix) <= MAX_TOOL_RESULT_CONTEXT_BYTES) {
    return withContent(result, text + suffix);
  }

  const path = await spillToSandbox({ context, toolCallId, text });
  const content = capToolResultText({ text, path, suffix });
  if (typeof result === "string") return content;
  const marker: CappedToolResult = {
    totalChars: text.length,
    ...(path ? { path } : {}),
  };
  const meta = isRecord(result._meta) ? result._meta : {};
  return {
    ...result,
    content,
    _meta: { ...meta, [CAPPED_TOOL_RESULT_META_KEY]: marker },
  };
}

// === Internal helpers ===

interface SpillContext {
  organizationId: string;
  userId: string;
  agentId: string;
  conversationId?: string;
  /** Encrypted chat: the sandbox would hold the result in plaintext. */
  suppressContentLogging?: boolean;
}

async function spillToSandbox(params: {
  context: SpillContext;
  toolCallId: string | undefined;
  text: string;
}): Promise<string | null> {
  const { context, toolCallId, text } = params;
  const { conversationId } = context;
  if (!conversationId || !toolCallId || context.suppressContentLogging) {
    return null;
  }
  try {
    const available = await isSkillSandboxAvailableForAgent({
      userId: context.userId,
      organizationId: context.organizationId,
      agentId: context.agentId,
    });
    if (!available) return null;

    // Same tuple run_command resolves its default target from, so the file
    // lands where the model's next command runs.
    const sandbox = await SkillSandboxModel.findOrCreateDefault({
      organizationId: context.organizationId,
      userId: context.userId,
      conversationId,
      defaultCwd: SKILL_SANDBOX_HOME,
    });
    const fileId = uuidv5(toolCallId, conversationId);
    const path = `${SKILL_SANDBOX_HOME}/tool-results/${fileId}.txt`;
    await skillSandboxRuntimeService.uploadFile({
      sandboxId: asSandboxId(sandbox.id),
      path,
      data: Buffer.from(text, "utf8"),
      mimeType: "text/plain",
      originalName: `${fileId}.txt`,
      dedupeId: fileId,
    });
    return path;
  } catch (error) {
    logger.warn(
      { err: error, conversationId, toolCallId },
      "Could not save oversized tool result to the sandbox; truncating it",
    );
    return null;
  }
}

function withContent(result: ToolResult, content: string): ToolResult {
  if (typeof result === "string") return content;
  return result.content === content ? result : { ...result, content };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
