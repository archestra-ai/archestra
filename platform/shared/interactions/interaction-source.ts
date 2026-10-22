import { z } from "zod";
import type { OpenCodeFamilyClientId } from "../opencode-family";

/**
 * Where an LLM proxy request originated from.
 * Stored in the `source` column of the interactions table.
 */
export const InteractionSourceSchema = z.enum([
  "api",
  "model_router",
  "opencode:main",
  "opencode:subagent",
  "opencode:title",
  "opencode:compaction",
  "kilo:main",
  "kilo:subagent",
  "kilo:title",
  "kilo:compaction",
  "chat",
  "chat:compaction",
  "a2a:compaction",
  "chat:title_generation",
  "chat:tool_call_repair",
  "a2a:tool_call_repair",
  "skill:description_generation",
  // Retained for historical logs after the legacy feature was removed.
  "guardrail:dual_llm",
  "guardrail:annotator",
  "guardrail:hitl_summary",
  "chatops:slack",
  "chatops:ms-teams",
  "chatops:telegram",
  "email",
  "schedule-trigger",
  "knowledge:embedding",
  "knowledge:reranker",
  "knowledge:query-expansion",
  "knowledge:contextual-retrieval",
  "knowledge:ocr",
  "app:llm_complete",
  "app:recording_enhancement",
]);

export type InteractionSource = z.infer<typeof InteractionSourceSchema>;

/** How an OpenCode-family client frames a turn. */
export type OpenCodeFamilyTurnKind =
  | "main"
  | "subagent"
  | "title"
  | "compaction";

/**
 * The source of an OpenCode-family turn, e.g. `kilo:subagent`. The return
 * type holds every member's sources to the schema above, so adding a family
 * member without its sources fails to compile.
 */
export function openCodeFamilySource(
  clientId: OpenCodeFamilyClientId,
  kind: OpenCodeFamilyTurnKind,
): InteractionSource {
  return `${clientId}:${kind}` as const;
}

/**
 * Display configuration for interaction sources.
 * Used by both frontend (SourceBadge) and any other consumer that needs
 * human-readable labels for source values.
 */
export const INTERACTION_SOURCE_DISPLAY: Record<
  InteractionSource,
  { label: string }
> = {
  api: { label: "API" },
  model_router: { label: "Model Router" },
  "opencode:main": { label: "OpenCode Main" },
  "opencode:subagent": { label: "OpenCode Sub-agent" },
  "opencode:title": { label: "OpenCode Title" },
  "opencode:compaction": { label: "OpenCode Compaction" },
  "kilo:main": { label: "Kilo Code Main" },
  "kilo:subagent": { label: "Kilo Code Sub-agent" },
  "kilo:title": { label: "Kilo Code Title" },
  "kilo:compaction": { label: "Kilo Code Compaction" },
  chat: { label: "Chat" },
  "chat:compaction": { label: "Chat Compaction" },
  "a2a:compaction": { label: "Agent Context Compaction" },
  "chat:title_generation": { label: "Chat Title Generation" },
  "chat:tool_call_repair": { label: "Chat Tool Call Repair" },
  "a2a:tool_call_repair": { label: "Agent Tool Call Repair" },
  "skill:description_generation": { label: "Skill Description Generation" },
  "guardrail:dual_llm": { label: "Dual LLM Sanitization (legacy)" },
  "guardrail:annotator": { label: "Guardrails Annotator" },
  "guardrail:hitl_summary": { label: "Guardrails Review Summary" },
  "chatops:slack": { label: "Slack" },
  "chatops:ms-teams": { label: "MS Teams" },
  "chatops:telegram": { label: "Telegram" },
  email: { label: "Email" },
  "schedule-trigger": { label: "Scheduled Trigger" },
  "knowledge:embedding": { label: "Knowledge - Embedding" },
  "knowledge:reranker": { label: "Knowledge - Reranker" },
  "knowledge:query-expansion": { label: "Knowledge - Query Expansion" },
  "knowledge:contextual-retrieval": {
    label: "Knowledge - Contextual Retrieval",
  },
  "knowledge:ocr": { label: "Knowledge - OCR" },
  "app:llm_complete": { label: "App LLM Completion" },
  "app:recording_enhancement": { label: "App Recording Enhancement" },
};

/**
 * Extracts the first meaningful text output from an LLM interaction response.
 * Supports Gemini (candidates/parts), OpenAI (choices/message/content), and
 * Anthropic (content array) response formats.
 */
export function extractTextFromInteractionResponse(
  response: unknown,
): string | null {
  if (!response || typeof response !== "object") {
    return null;
  }

  const candidateResponse = response as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
    choices?: Array<{
      message?: {
        content?:
          | string
          | Array<{ type?: string; text?: string; refusal?: string }>;
      };
    }>;
    content?: Array<{ type?: string; text?: string }>;
  };

  const geminiText = candidateResponse.candidates
    ?.flatMap((candidate) => candidate.content?.parts ?? [])
    .map((part) => part.text?.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  if (geminiText) {
    return geminiText;
  }

  const openAiText = candidateResponse.choices
    ?.flatMap((choice) => {
      const content = choice.message?.content;
      if (typeof content === "string") {
        return [content.trim()];
      }

      return (content ?? []).flatMap((part) =>
        part.type === "text" || part.type === "output_text"
          ? [part.text?.trim()]
          : part.type === "refusal"
            ? [part.refusal?.trim()]
            : [],
      );
    })
    .filter(Boolean)
    .join("\n")
    .trim();
  if (openAiText) {
    return openAiText;
  }

  const anthropicText = candidateResponse.content
    ?.flatMap((part) =>
      part.type === "text" || part.type === "output_text"
        ? [part.text?.trim()]
        : [],
    )
    .filter(Boolean)
    .join("\n")
    .trim();

  return anthropicText || null;
}

/**
 * Extracts the first meaningful text output from a list of interactions,
 * returning the first non-empty result.
 */
export function extractScheduleRunOutputFromInteractions(
  interactions: Array<{ response?: unknown }>,
): string | null {
  for (const interaction of interactions) {
    const output = extractTextFromInteractionResponse(interaction.response);
    if (output) {
      return output;
    }
  }

  return null;
}
