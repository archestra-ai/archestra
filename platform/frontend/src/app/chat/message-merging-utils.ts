import type { UIMessage } from "@ai-sdk/react";
import { type PartialUIMessage } from "@shared";

/**
 * A permissive type for message merging that accounts for different AI SDK versions
 * and Archestra-specific rich content parts.
 */
export type MergableUIMessage = PartialUIMessage & {
  toolInvocations?: Array<{ toolName?: string }>;
  content?: string;
  experimental_attachments?: unknown[];
};

/**
 * Determines if two message objects refer to the same logical interaction.
 * Uses a multi-factor approach: ID, Role, Text Content, and Tool Call signatures.
 */
export function messagesHaveSameRenderableContent(params: {
  liveMessage: UIMessage;
  persistedMessage: UIMessage;
}) {
  const lm = params.liveMessage as MergableUIMessage;
  const pm = params.persistedMessage as MergableUIMessage;

  // 1. Strict ID Match
  if (lm.id && pm.id && lm.id === pm.id) {
    return true;
  }

  // 2. Identity Check
  if (lm.role !== pm.role) {
    return false;
  }

  // 3. Text Content Match
  const liveText = getMessageText(lm);
  const persistedText = getMessageText(pm);
  if (liveText !== persistedText) {
    return false;
  }

  // 4. Attachment Check
  const getAttachmentCount = (msg: MergableUIMessage) => {
    let count = (msg.experimental_attachments?.length as number) || 0;
    if (msg.parts) {
      count += msg.parts.filter(
        (p: any) => p.type === "image" || p.type === "file",
      ).length;
    }
    return count;
  };
  if (getAttachmentCount(lm) !== getAttachmentCount(pm)) {
    return false;
  }

  // 5. Tool Call Signature Verification
  const getToolNames = (msg: MergableUIMessage) => {
    const names: string[] = [];
    if (msg.parts) {
      for (const part of msg.parts) {
        const p = part as any;
        if (p.type === "tool-call" || p.type === "tool-invocation") {
          const toolName = p.toolName || p.toolInvocation?.toolName;
          if (toolName) names.push(toolName);
        }
      }
    }
    if (msg.toolInvocations) {
      for (const invocation of msg.toolInvocations) {
        if (invocation.toolName) {
          names.push(invocation.toolName);
        }
      }
    }
    return names;
  };

  const liveTools = getToolNames(lm);
  const persistedTools = getToolNames(pm);

  if (liveTools.length !== persistedTools.length) {
    return false;
  }

  return liveTools.every((name, i) => name === persistedTools[i]);
}

export function getMessageText(message: any) {
  const msg = message as MergableUIMessage;
  if (msg.parts) {
    return msg.parts
      .map((part: any) => (part.type === "text" ? part.text || "" : ""))
      .filter(Boolean)
      .join("\n");
  }
  return typeof msg.content === "string" ? msg.content : "";
}

export function hasCreatedAtMetadata(message: any) {
  const metadata = getObjectMetadata(message);
  return typeof metadata.createdAt === "string";
}

export function getObjectMetadata(message: any): Record<string, unknown> {
  const msg = message as MergableUIMessage;
  return typeof msg.metadata === "object" && msg.metadata !== null
    ? { ...(msg.metadata as Record<string, unknown>) }
    : {};
}
