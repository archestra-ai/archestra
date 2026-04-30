import { z } from "zod";

/**
 * Where an LLM proxy request originated from.
 * Stored in the `source` column of the interactions table.
 */
export const InteractionSourceSchema = z.enum([
  "api",
  "model_router",
  "chat",
  "chatops:slack",
  "chatops:ms-teams",
  "email",
  "schedule-trigger",
  "knowledge:embedding",
  "knowledge:reranker",
  "knowledge:query-expansion",
]);

export type InteractionSource = z.infer<typeof InteractionSourceSchema>;

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
  chat: { label: "Chat" },
  "chatops:slack": { label: "Slack" },
  "chatops:ms-teams": { label: "MS Teams" },
  email: { label: "Email" },
  "schedule-trigger": { label: "Scheduled Trigger" },
  "knowledge:embedding": { label: "Knowledge - Embedding" },
  "knowledge:reranker": { label: "Knowledge - Reranker" },
  "knowledge:query-expansion": { label: "Knowledge - Query Expansion" },
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
