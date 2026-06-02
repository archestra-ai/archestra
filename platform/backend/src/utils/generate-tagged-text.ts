import { generateText, type ModelMessage } from "ai";
import type { LLMModel } from "@/clients/llm-client";

/**
 * Generate a single piece of text the model must wrap in one `<tag>…</tag>`
 * block, then extract the tagged content. If the first response omits the tag,
 * retry once with a correction turn that shows the model its own bad reply and
 * re-states the contract. Falls back to the sanitized raw first response when
 * both attempts miss the tag, so a model that answers correctly but ignores the
 * wrapper is still usable.
 *
 * This is the robustness pattern the context-compaction summary uses, lifted
 * out so any single-field generation gets it: a tag is far more reliable than
 * `Output.object` across models that don't emit structured JSON (free/reasoning
 * models return prose and fail JSON parsing, yielding nothing).
 *
 * Returns `null` only when nothing usable remains.
 */
export async function generateTaggedText(params: {
  model: LLMModel;
  /** Tag the answer must be wrapped in, e.g. `description`. */
  tag: string;
  system: string;
  prompt: string;
  maxOutputTokens?: number;
  temperature?: number;
  abortSignal?: AbortSignal;
  /** Normalize the extracted (or fallback) text. Defaults to trimming. */
  sanitize?: (text: string) => string;
}): Promise<string | null> {
  const { model, tag, prompt } = params;
  const sanitize = params.sanitize ?? ((text) => text.trim());
  const system = `${params.system}\n\n${outputContract(tag)}`;
  const options = {
    maxOutputTokens: params.maxOutputTokens,
    temperature: params.temperature,
    abortSignal: params.abortSignal,
  };

  const first = await generateText({ model, system, prompt, ...options });
  let extracted = extractTaggedText(first.text, tag);

  if (extracted === null) {
    const messages: ModelMessage[] = [
      { role: "user", content: prompt },
      { role: "assistant", content: first.text },
      { role: "user", content: correctionPrompt(tag) },
    ];
    const retried = await generateText({ model, system, messages, ...options });
    extracted = extractTaggedText(retried.text, tag);
  }

  const result = sanitize(extracted ?? first.text);
  return result.length > 0 ? result : null;
}

/**
 * Extract the content inside the first `<tag>…</tag>` pair. Returns `null` when
 * the tag is absent or wraps only whitespace. Pure.
 *
 * @public — exported for testability
 */
export function extractTaggedText(text: string, tag: string): string | null {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const start = text.indexOf(open);
  if (start < 0) return null;
  const contentStart = start + open.length;
  const end = text.indexOf(close, contentStart);
  if (end < 0) return null;
  const inner = text.slice(contentStart, end).trim();
  return inner.length > 0 ? inner : null;
}

function outputContract(tag: string): string {
  return `Output contract: reply with EXACTLY ONE <${tag}>...</${tag}> block — your answer inside the tags, no text outside them.`;
}

function correctionPrompt(tag: string): string {
  return `Your previous response did not follow the required format. Reply with EXACTLY ONE <${tag}>...</${tag}> block and no text outside the tags.`;
}
