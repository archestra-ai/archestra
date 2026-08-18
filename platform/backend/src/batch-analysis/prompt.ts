import { z } from "zod";
import {
  type BatchAnalysisCellFlag,
  BatchAnalysisCellFlagSchema,
  type BatchAnalysisColumn,
  type BatchAnalysisColumnFormat,
} from "@/types/batch-analysis";

/**
 * The tag the model wraps its JSON answer in. Tagged output rather than the AI
 * SDK's structured-output mode, matching the convention elsewhere in the
 * codebase: tags survive weaker models and non-OpenAI providers more reliably.
 */
export const BATCH_ANALYSIS_RESULT_TAG = "results";

/** Answer the model is asked to produce when the source does not address a column. */
export const NOT_FOUND_VALUE = "N/A";

const FORMAT_INSTRUCTIONS: Record<BatchAnalysisColumnFormat, string> = {
  text: "a concise answer in plain prose",
  boolean: 'exactly "yes" or "no"',
  date: 'a single date formatted YYYY-MM-DD (use "N/A" if the source gives no date)',
  number: "a single number, digits only, with no units or thousands separators",
  list: "a list of short items, one per line, with no bullets or numbering",
  exact_quote:
    "the supporting passage copied VERBATIM from the source, character for character, with no paraphrasing, summarising, or ellipsis",
};

/**
 * Prompt builders are pure and exported so their output can be asserted without
 * calling a model — the parsing and prompt-shaping logic is where the bugs live,
 * not in the network call.
 *
 * @public — exported for testability
 */
export function buildBatchAnalysisSystemPrompt(): string {
  return [
    "You extract structured answers from a single source document.",
    "",
    "You will be given the full text of one source, followed by a numbered list of questions.",
    "Answer every question using ONLY the source text. Never use outside knowledge.",
    `If the source does not answer a question, return exactly "${NOT_FOUND_VALUE}" for it — never guess.`,
    "",
    `Reply with a single JSON object wrapped in <${BATCH_ANALYSIS_RESULT_TAG}></${BATCH_ANALYSIS_RESULT_TAG}> tags.`,
    "Each key is a question's `key`. Each value is an object with:",
    '  - "value": the answer, formatted exactly as that question requires',
    '  - "quote": a short verbatim span from the source supporting the answer, or null if the answer is N/A',
    '  - "flag": ONLY for questions marked "triage: yes" — classify the answer as "green" (standard or favourable), "yellow" (needs attention), "red" (problematic or unfavourable), or "grey" (neutral, or the source does not answer). Omit "flag" for every other question.',
    "",
    "Return every key you were asked for, and no others. Emit no text outside the tags.",
  ].join("\n");
}

/** @public — exported for testability */
export function buildBatchAnalysisUserPrompt(params: {
  label: string;
  sourceText: string;
  columns: BatchAnalysisColumn[];
  truncated: boolean;
}): string {
  const questions = params.columns
    .map(
      (column, index) =>
        `${index + 1}. key: ${column.key}\n   question: ${column.prompt}\n   format: ${FORMAT_INSTRUCTIONS[column.format]}${column.flag ? "\n   triage: yes" : ""}`,
    )
    .join("\n");

  return [
    `SOURCE: ${params.label}`,
    params.truncated
      ? "NOTE: this source was truncated because it exceeded the size limit. Answer only from the text shown, and use N/A for anything the visible text does not cover."
      : null,
    "",
    "<source>",
    params.sourceText,
    "</source>",
    "",
    "QUESTIONS:",
    questions,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

const RawAnswerSchema = z.object({
  value: z.union([z.string(), z.number(), z.boolean()]),
  quote: z.string().nullish(),
  // Nullish and free-form on purpose: a model that omits or garbles the flag
  // must not fail the whole row — the answer and quote are still good.
  flag: z.string().nullish(),
});

const RawResultSchema = z.record(z.string(), RawAnswerSchema);

type ParsedAnswer = {
  value: string;
  quote: string | null;
  /** Validated triage flag; null when absent or not a recognised value. */
  flag: BatchAnalysisCellFlag | null;
};

type ParseOutcome =
  | { ok: true; answers: Map<string, ParsedAnswer> }
  | { ok: false; error: string };

/**
 * Parse the model's tagged JSON payload.
 *
 * Deliberately strict about structure and lenient about scalar type: a model
 * that returns `{"value": 42}` for a number column is answering correctly, so
 * coercing that is right, whereas a malformed envelope means we have no idea
 * what it answered and must not guess.
 *
 * @public — exported for testability
 */
export function parseBatchAnalysisResult(raw: string): ParseOutcome {
  const trimmed = stripCodeFence(raw.trim());
  if (!trimmed) {
    return { ok: false, error: "Model returned an empty result" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: "Model result was not valid JSON" };
  }

  const validated = RawResultSchema.safeParse(parsed);
  if (!validated.success) {
    return {
      ok: false,
      error:
        "Model result did not match the expected {key: {value, quote}} shape",
    };
  }

  const answers = new Map<string, ParsedAnswer>();
  for (const [key, answer] of Object.entries(validated.data)) {
    const value = String(answer.value).trim();
    const quote = answer.quote?.trim();
    const flag = BatchAnalysisCellFlagSchema.safeParse(
      answer.flag?.trim().toLowerCase(),
    );
    answers.set(key, {
      value: value.length > 0 ? value : NOT_FOUND_VALUE,
      quote: quote && quote.length > 0 ? quote : null,
      flag: flag.success ? flag.data : null,
    });
  }
  return { ok: true, answers };
}

/**
 * Whether a quote can be trusted as verbatim. A quote the source does not
 * contain is a fabrication, and catching it here is free — the same string-match
 * check that makes citations verifiable elsewhere in the platform.
 *
 * Whitespace is normalised before comparing because models reflow line breaks
 * inside a passage without changing its words.
 *
 * @public — exported for testability
 */
export function isQuoteGrounded(params: {
  quote: string;
  sourceText: string;
}): boolean {
  const normalize = (text: string) =>
    text.replace(/\s+/g, " ").trim().toLowerCase();
  const needle = normalize(params.quote);
  if (!needle) return false;
  return normalize(params.sourceText).includes(needle);
}

function stripCodeFence(text: string): string {
  const fenced = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  return fenced ? fenced[1].trim() : text;
}
