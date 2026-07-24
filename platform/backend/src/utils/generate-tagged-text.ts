import { generateText, type ModelMessage } from "ai";
import type { LLMModel } from "@/clients/llm-client";
import logger from "@/logging";

/**
 * Generate a single piece of text the model must wrap in one `<tag>…</tag>`
 * block, then extract the tagged content. If the first response omits the tag,
 * retry once with a correction turn that shows the model its own bad reply and
 * re-states the contract.
 *
 * Clean-or-nothing: the result is the content of the first `<tag>…</tag>` pair,
 * never salvaged raw model output. When both attempts miss the tag we return
 * `null` so the caller fails cleanly (e.g. "write one manually") rather than
 * persist raw untagged output. A tag is far more reliable than
 * `Output.object` across models that don't emit structured JSON (free/reasoning
 * models return prose and fail JSON parsing), which is why we ask for a tag
 * rather than a schema.
 *
 * Returns `null` when no tagged content was produced.
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
  /** Normalize the extracted text. Defaults to trimming. */
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
  let retriedFinishReason: string | undefined;

  if (extracted === null) {
    // Truncation and disobedience are different failures and need different
    // retries. `length` means the model ran out of room mid-answer — reasoning
    // models spend this same budget on hidden thinking, so a tight cap can be
    // exhausted before the closing tag is ever emitted (sometimes before any
    // visible text at all). It was honoring the contract as far as it got, so
    // re-stating the contract under the SAME ceiling just buys the identical
    // truncation twice; re-ask with more room instead. Any other finish reason
    // means the model finished and skipped the tag, which the correction turn
    // — showing it its own reply — does fix.
    const roomier =
      first.finishReason === "length" && params.maxOutputTokens !== undefined
        ? params.maxOutputTokens * TRUNCATION_RETRY_FACTOR
        : null;
    logger.info(
      {
        tag,
        finishReason: first.finishReason,
        textLength: first.text.length,
        retry: roomier === null ? "correction" : "headroom",
        retryMaxOutputTokens: roomier ?? undefined,
      },
      "generateTaggedText: first attempt missed the tag, retrying",
    );
    const messages: ModelMessage[] = [
      { role: "user", content: prompt },
      { role: "assistant", content: first.text },
      { role: "user", content: correctionPrompt(tag) },
    ];
    const retried =
      roomier === null
        ? await generateText({ model, system, messages, ...options })
        : await generateText({
            model,
            system,
            prompt,
            ...options,
            maxOutputTokens: roomier,
          });
    retriedFinishReason = retried.finishReason;
    extracted = extractTaggedText(retried.text, tag);
  }

  if (extracted === null) {
    logger.warn(
      {
        tag,
        firstFinishReason: first.finishReason,
        retriedFinishReason,
        firstTextLength: first.text.length,
        // Both attempts ending in `length` means the caller's ceiling is too
        // small for this model's thinking budget, not that the model misbehaved.
        maxOutputTokens: params.maxOutputTokens,
      },
      "generateTaggedText: no tagged content after retry, returning null",
    );
    return null;
  }

  const result = sanitize(extracted);
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

/**
 * How much more room the truncation retry gets. One doubling is enough for a
 * caller whose ceiling merely failed to account for hidden reasoning; a caller
 * that needs more than that has a cap set wrong, and the `length`-on-both-
 * attempts warning says so rather than escalating spend silently.
 */
const TRUNCATION_RETRY_FACTOR = 2;

function outputContract(tag: string): string {
  return `Output contract: reply with EXACTLY ONE <${tag}>...</${tag}> block — your answer inside the tags, no text outside them.`;
}

function correctionPrompt(tag: string): string {
  return `Your previous response did not follow the required format. Reply with EXACTLY ONE <${tag}>...</${tag}> block and no text outside the tags.`;
}
