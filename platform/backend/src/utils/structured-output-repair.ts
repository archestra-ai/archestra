import type { RepairTextFunction } from "ai";
import { stripThinkingBlocks } from "./strip-thinking-blocks";

/**
 * `experimental_repairText` for `generateObject`, for chat models that answer a
 * structured-output request with more than the bare object.
 *
 * Not every deployment constrains decoding to the schema. Self-hosted
 * OpenAI-compatible endpoints only enforce a grammar when the request carries
 * `response_format: json_schema` AND the server has guided decoding available;
 * where it isn't enforced, the model answers as it would any other prompt:
 *
 *   - reasoning models (Qwen3 and friends) put their chain of thought inline in
 *     `content` as `<think>…</think>` unless the server was started with a
 *     matching reasoning parser, so nothing routes it to `reasoning_content`
 *     where the provider client could split it out;
 *   - chat-tuned models wrap the object in a ```json fence, prose, or both.
 *
 * The AI SDK hands that whole string to `JSON.parse` and reports
 * "No object generated: could not parse the response." This runs only after
 * that parse (or schema validation) has already failed, so a well-behaved model
 * never touches it: it strips reasoning blocks, then returns the first
 * substring that is a parsable JSON value. `null` means nothing salvageable was
 * found, which re-throws the original error with the raw text intact.
 */
export const repairStructuredOutputText: RepairTextFunction = async ({
  text,
}) => {
  const repaired = extractJsonValue(text);
  // Handing back the input unchanged would just re-run the identical failing
  // parse; `null` preserves the original, more informative error.
  return repaired === null || repaired === text.trim() ? null : repaired;
};

// ===== Internal helpers =====

/**
 * The first substring that parses as JSON, after inline reasoning is removed.
 * Candidates are tried left to right so prose braces ahead of the real object
 * ("scores for {passage 0}: {…}") are skipped rather than mistaken for it.
 */
function extractJsonValue(text: string): string | null {
  const body = stripReasoning(text).trim();

  let candidatesTried = 0;
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char !== "{" && char !== "[") continue;
    if (++candidatesTried > MAX_JSON_CANDIDATES) break;

    const slice = sliceBalancedJson(body, i);
    if (slice !== null && isParsableJson(slice)) {
      return slice;
    }
  }
  return null;
}

/**
 * Drop inline reasoning. Paired `<think>…</think>` / `<thinking>…</thinking>`
 * blocks go first; whatever closing tag survives that was opened by a chat
 * template that prefilled the opener into the prompt (Ollama and some vLLM
 * templates do), so everything up to the last one is reasoning too.
 */
function stripReasoning(text: string): string {
  const withoutPairs = stripThinkingBlocks(text);

  let lastCloseEnd: number | null = null;
  for (const match of withoutPairs.matchAll(CLOSING_THINK_TAG)) {
    lastCloseEnd = match.index + match[0].length;
  }
  return lastCloseEnd === null
    ? withoutPairs
    : withoutPairs.slice(lastCloseEnd);
}

/**
 * The substring from `start` (a `{` or `[`) to its matching bracket, or `null`
 * when it is never closed. Brackets inside string literals don't count, so a
 * value like `{"note":"}"}` is not cut short.
 */
function sliceBalancedJson(text: string, start: number): string | null {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === open) depth++;
    else if (char === close && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

function isParsableJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

const CLOSING_THINK_TAG = /<\/think(?:ing)?>/gi;

/**
 * Bounds the scan: every candidate start costs a balanced walk, so a long reply
 * that is all prose and braces would otherwise be quadratic. A real reply puts
 * its object well inside this budget.
 */
const MAX_JSON_CANDIDATES = 64;
