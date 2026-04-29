import type { archestraApiTypes } from "@shared";
import { parsePolicyDenied } from "@/lib/chat/mcp-error-ui";

type UnsafeContextBoundary =
  archestraApiTypes.GetInteractionResponses["200"]["unsafeContextBoundary"];

/**
 * Location of the single sensitive-context divider in a chat thread.
 *
 * - `preexisting`: rendered at the top of the thread (conversation
 *   started already-sensitive).
 * - `tool`: rendered after the matching tool part(s) at
 *   `(messageId, partIndex)`.
 * - `before-text`: rendered immediately before the text part at
 *   `(messageId, partIndex)`. Covers both an explicit policy-denied
 *   text and an inferred earlier assistant text that follows a tool
 *   output but precedes a later denial.
 */
export type FirstUnsafeDividerLocation =
  | { kind: "preexisting" }
  | { kind: "tool"; messageId: string; partIndex: number }
  | { kind: "before-text"; messageId: string; partIndex: number };

interface MessageLike {
  id?: string;
  role: string;
  parts?: ReadonlyArray<unknown>;
}

export function computeFirstUnsafeDividerLocation<
  M extends MessageLike,
>(params: {
  messages: ReadonlyArray<M>;
  unsafeContextBoundary?: UnsafeContextBoundary;
  canReadToolPolicy: boolean;
  isUnsafeBoundaryTool: (
    part: NonNullable<M["parts"]>[number],
    boundary: UnsafeContextBoundary | undefined,
  ) => boolean;
}): FirstUnsafeDividerLocation | null {
  if (!params.canReadToolPolicy) {
    return null;
  }

  if (params.unsafeContextBoundary?.kind === "preexisting_untrusted") {
    return { kind: "preexisting" };
  }

  for (let mi = 0; mi < params.messages.length; mi++) {
    const message = params.messages[mi];
    if (!message.id) continue;
    const parts = message.parts ?? [];
    for (let pi = 0; pi < parts.length; pi++) {
      const part = parts[pi] as NonNullable<M["parts"]>[number];
      if (params.isUnsafeBoundaryTool(part, params.unsafeContextBoundary)) {
        return { kind: "tool", messageId: message.id, partIndex: pi };
      }
      const partText = getTextPartText(part);
      if (
        partText !== undefined &&
        parsePolicyDenied(partText)?.unsafeContextActiveAtRequestStart
      ) {
        return { kind: "before-text", messageId: message.id, partIndex: pi };
      }
    }
  }

  return null;
}

export function isFirstDividerAtTool(
  location: FirstUnsafeDividerLocation | null | undefined,
  messageId: string | undefined,
  partIndices: ReadonlyArray<number>,
): boolean {
  if (!location || location.kind !== "tool") return false;
  if (!messageId || location.messageId !== messageId) return false;
  return partIndices.includes(location.partIndex);
}

export function isFirstDividerAtText(
  location: FirstUnsafeDividerLocation | null | undefined,
  messageId: string | undefined,
  partIndex: number,
): boolean {
  if (!location || location.kind !== "before-text") return false;
  if (!messageId || location.messageId !== messageId) return false;
  return location.partIndex === partIndex;
}

function getTextPartText(part: unknown): string | undefined {
  if (
    typeof part !== "object" ||
    part === null ||
    !("type" in part) ||
    (part as { type?: unknown }).type !== "text" ||
    !("text" in part) ||
    typeof (part as { text?: unknown }).text !== "string"
  ) {
    return undefined;
  }
  return (part as { text: string }).text;
}
