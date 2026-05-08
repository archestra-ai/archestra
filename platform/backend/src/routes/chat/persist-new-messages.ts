import { TOOL_STATE } from "@shared";
import logger from "@/logging";
import { MessageModel } from "@/models";
import type { ChatMessage } from "@/types";
import { estimateMessagesSize } from "@/utils/message-size";
import { collectResolvedApprovalToolCallIds } from "./approval-resolution";
import { normalizeChatMessages } from "./normalization/normalize-chat-messages";

/**
 * Insert messages whose IDs aren't already in the DB, plus run the
 * approval-resolution sweep: when an incoming assistant message carries a
 * tool part in a terminal approval state (`approval-responded`,
 * `output-available`, `output-error`, `output-denied`) and a prior persisted
 * message still has that `toolCallId` in `approval-requested`, delete the
 * prior row so `tool_use` ids stay unique across the conversation.
 *
 * Caller contract: pass a fully resolved message list. From `onFinish` use
 * the `finalMessages` argument; from `onError` / `onExecuteError` use the
 * request body `messages`. From `earlyUserMsg` filter the request body to
 * user role only — the assistant on a continuation request is in an
 * intermediate state, and `getMessagesNotYetPersisted` dedups by
 * `content.id`, which would block `onFinish` from writing the final state.
 */
export async function persistNewMessages(
  conversationId: string,
  messages: unknown[],
  context: string,
): Promise<number> {
  try {
    const existingMessages =
      await MessageModel.findByConversation(conversationId);
    const uiMessages = messages as ChatMessage[];

    let didDeleteStale = false;
    const resolvedToolCallIds = collectResolvedApprovalToolCallIds(uiMessages);
    if (resolvedToolCallIds.size > 0) {
      const idsToDelete: string[] = [];
      for (const toolCallId of resolvedToolCallIds) {
        const stale = await MessageModel.findPriorApprovalRequestedByToolCallId(
          {
            conversationId,
            toolCallId,
          },
        );
        for (const row of stale) idsToDelete.push(row.id);
      }
      if (idsToDelete.length > 0) {
        await MessageModel.bulkDelete(idsToDelete);
        didDeleteStale = true;
        logger.info(
          {
            conversationId,
            deletedCount: idsToDelete.length,
            resolvedToolCallIds: Array.from(resolvedToolCallIds),
            context,
          },
          "[Chat] Deleted stale approval-requested messages",
        );
      }
    }

    const refreshed = didDeleteStale
      ? await MessageModel.findByConversation(conversationId)
      : existingMessages;

    const newMessages = getMessagesNotYetPersisted({
      existingMessages: refreshed,
      uiMessages,
    });

    if (newMessages.length === 0) {
      return 0;
    }

    let messagesToSave = newMessages;
    if (newMessages[newMessages.length - 1].parts?.length === 0) {
      messagesToSave = newMessages.slice(0, -1);
    }

    if (messagesToSave.length === 0) {
      return 0;
    }

    let messagesToStore: ChatMessage[];

    if (context === "onFinish") {
      const beforeSize = estimateMessagesSize(messagesToSave);
      messagesToStore = normalizeChatMessages(messagesToSave);
      const afterSize = estimateMessagesSize(messagesToStore);
      logger.info(
        {
          messageCount: messagesToSave.length,
          beforeSizeKB: Math.round(beforeSize.length / 1024),
          afterSizeKB: Math.round(afterSize.length / 1024),
          savedKB: Math.round((beforeSize.length - afterSize.length) / 1024),
          sizeEstimateReliable:
            !beforeSize.isEstimated && !afterSize.isEstimated,
        },
        "[Chat] Stripped messages before saving to DB",
      );
    } else {
      messagesToStore = normalizeChatMessages(messagesToSave);
    }

    // Persist each message as-is. We deliberately do NOT stamp `msg.id`
    // when it's missing/empty: the AI SDK on the client doesn't read
    // our stamp back, so a stamped UUID would just hide the row from
    // the empty-content.id fingerprint pool below — the very pool that
    // catches the SDK's later id rewrite (#4030).
    const now = Date.now();
    const messageData = messagesToStore.map((msg, index) => ({
      conversationId,
      role: msg.role ?? "assistant",
      content: msg,
      createdAt: new Date(now + index),
    }));

    await MessageModel.bulkCreate(messageData);

    logger.info(
      `Appended ${messagesToSave.length} new messages to conversation ${conversationId} (${context})`,
    );

    return messagesToSave.length;
  } catch (error) {
    logger.error(
      { error, conversationId, context },
      `Failed to persist messages during ${context}`,
    );
    throw error;
  }
}

export function getMessagesNotYetPersisted(params: {
  existingMessages: Array<{ id: string; content: unknown }>;
  uiMessages: ChatMessage[];
}): ChatMessage[] {
  const existingIds = new Set<string>();
  // Content fingerprint as a fallback dedupe key. The AI SDK occasionally
  // emits assistant messages with `id: ""` during streaming and assigns a
  // fresh client-side id (e.g. `wEHcEHZJOgk2RiwS`) on the next round-trip,
  // bypassing id-based dedupe. We only seed the fingerprint set from rows
  // whose `content.id` was empty at persist time — those are the only rows
  // the SDK can re-stamp under a different id, so anything else stays
  // dedup-by-id and a model that legitimately repeats an identical reply
  // doesn't get its second turn dropped. (#4030)
  //
  // Note on normalization asymmetry: existing rows are stored post-
  // `normalizeChatMessages`; incoming `uiMessages` are pre-normalize.
  // Mismatched parts caused by stripping/dedupe would yield a fingerprint
  // miss and fall through to insert (i.e. the original phantom returns in
  // pathological cases) — never a false-positive that drops live data.
  const existingFingerprints = new Set<string>();

  for (const message of params.existingMessages) {
    existingIds.add(message.id);

    const content =
      typeof message.content === "object" && message.content !== null
        ? (message.content as { id?: unknown })
        : null;
    const contentId =
      content && typeof content.id === "string" ? content.id : null;
    if (contentId) {
      existingIds.add(contentId);
      continue;
    }

    const fingerprint = computeMessageFingerprint(message.content);
    if (fingerprint) {
      existingFingerprints.add(fingerprint);
    }
  }

  return params.uiMessages.filter((message) => {
    if (
      message.id &&
      typeof message.id === "string" &&
      existingIds.has(message.id)
    ) {
      return false;
    }
    if (existingFingerprints.size > 0) {
      const fingerprint = computeMessageFingerprint(message);
      if (fingerprint && existingFingerprints.has(fingerprint)) {
        return false;
      }
    }
    return true;
  });
}

function computeMessageFingerprint(message: unknown): string | null {
  if (
    typeof message !== "object" ||
    message === null ||
    !("role" in message) ||
    typeof (message as { role?: unknown }).role !== "string"
  ) {
    return null;
  }
  const m = message as { role: string; parts?: unknown };
  const parts = Array.isArray(m.parts) ? m.parts : [];
  if (parts.length === 0) {
    return null;
  }

  const partSignatures: string[] = [];
  for (const part of parts) {
    if (typeof part !== "object" || part === null) continue;
    const p = part as {
      type?: unknown;
      text?: unknown;
      toolCallId?: unknown;
      state?: unknown;
      url?: unknown;
      mediaType?: unknown;
      filename?: unknown;
    };
    const type = typeof p.type === "string" ? p.type : "unknown";
    // step-start carries no semantic content and can repeat in a single
    // multi-step tool turn — skip it to avoid avoidable collisions.
    if (type === "step-start") {
      continue;
    }
    if (type === "text" && typeof p.text === "string") {
      partSignatures.push(`text:${p.text}`);
      continue;
    }
    if (type === "reasoning" && typeof p.text === "string") {
      partSignatures.push(`reasoning:${p.text}`);
      continue;
    }
    if (type === "source-url" && typeof p.url === "string") {
      partSignatures.push(`source-url:${p.url}`);
      continue;
    }
    if (type === "file") {
      const url = typeof p.url === "string" ? p.url : "";
      const mediaType = typeof p.mediaType === "string" ? p.mediaType : "";
      const filename = typeof p.filename === "string" ? p.filename : "";
      partSignatures.push(`file:${url}:${mediaType}:${filename}`);
      continue;
    }
    if (type.startsWith("tool-")) {
      const toolCallId = typeof p.toolCallId === "string" ? p.toolCallId : "";
      const state = typeof p.state === "string" ? p.state : "";
      // approval-requested / input-* are transient — don't fingerprint
      // them, otherwise a legitimate retry would be deduped against the
      // pending row. (Mixed-state turns where one tool is settled and
      // another is still pending also fall through here — the resulting
      // re-insert is reconciled by the approval-resolution sweep that
      // deletes the prior approval-requested row.)
      if (
        state === TOOL_STATE.APPROVAL_REQUESTED ||
        state.startsWith("input-")
      ) {
        return null;
      }
      partSignatures.push(`${type}:${toolCallId}:${state}`);
      continue;
    }
    // Fallback for shapes we don't explicitly disambiguate yet (e.g.
    // data-*, dual-llm-analysis, blocked-tool).
    partSignatures.push(type);
  }

  if (partSignatures.length === 0) {
    return null;
  }
  return `${m.role}|${partSignatures.join("|")}`;
}
