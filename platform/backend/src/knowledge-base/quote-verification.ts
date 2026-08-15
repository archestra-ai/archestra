/**
 * Quote verification for knowledge-base citations (issue #7161, "cheap" half).
 *
 * The chat model is asked — via the `query_knowledge_sources` tool result — to
 * back each claim with a short verbatim quote tagged with the source chunk's
 * `ref`. This module does the other half: pull those quote/ref pairs out of the
 * model's answer and check each quote actually appears in the chunk its ref
 * names. A quote that appears in no returned chunk is a fabrication caught
 * programmatically rather than by a reader, so it doubles as a hallucination
 * check; a quote whose ref names no returned chunk but whose text exists in
 * another one is a mis-citation, reported separately.
 *
 * The chunks are captured at tool-execution time (chat-tool-builder pushes them
 * into a per-turn collector, covering both direct calls and `run_tool`
 * dispatches, before hook feedback can touch the serialized result), and the
 * answer text is the turn's full user-visible assistant text — not just the
 * final step's.
 *
 * Verification is log-only (issue decision "b"): a miss is logged and metered,
 * the answer is never altered or blocked. It only covers the internal chat
 * surface — the one place Archestra sees the model's answer — so external MCP
 * clients that answer out of sight stay unverified.
 *
 * The citation format itself — the instruction, the extraction pattern, and the
 * display-side folding — lives in `@archestra/shared` (citation-quotes.ts) so
 * this verifier and the chat frontend parse the exact same convention. This
 * module re-exports the pieces its existing importers use.
 */

import {
  type CitedQuote,
  extractCitedQuotes,
  normalizeQuoteForMatch,
} from "@archestra/shared";

/** A chunk a returned citation points at: its `ref` and the text the model saw. */
export interface KbChunkForQuoteCheck {
  ref: string;
  content: string;
}

/** @public — return shape of verifyQuotes; asserted directly in unit tests. */
export interface QuoteVerificationResult {
  /** Extracted (deduped) quote/ref pairs; each lands in exactly one bucket below. */
  checked: number;
  /** Quotes found in the chunk their ref names. */
  matched: number;
  /**
   * Quotes whose ref names no returned chunk but whose text exists in another
   * returned chunk — mis-citations: real evidence behind a bad pointer.
   */
  wrongRef: CitedQuote[];
  /** Quotes found nowhere they should be — the fabrications. */
  failed: CitedQuote[];
  /**
   * Quotes whose ref names no returned chunk and which are too short to search
   * for across all chunks (a tiny fragment appears almost anywhere, so finding
   * it would prove nothing).
   */
  unverifiable: CitedQuote[];
  /** Chunks were returned but the answer carried no parseable quote/ref pair. */
  unparseable: boolean;
}

/**
 * Verifies each cited quote against the chunk its ref names. An unresolved ref
 * is never silently forgiven: the quote is classified as a mis-citation when
 * its text exists in another returned chunk, a fabrication when it exists
 * nowhere, or unverifiable when it is too short for that cross-chunk search to
 * mean anything. Matching is on normalized text so incidental whitespace,
 * smart-quote, and case differences do not fail a legitimate quote. Callers
 * should only invoke this when chunks were actually returned.
 */
export function verifyQuotes(params: {
  answerText: string;
  chunks: KbChunkForQuoteCheck[];
}): QuoteVerificationResult {
  const { answerText, chunks } = params;

  // The same anchor can be returned more than once in a turn with different
  // stitched context. Context expansion claims neighbours against the other
  // hits in each query, so collapsing by ref alone can discard the only
  // passage that backs a quote copied from an earlier tool result.
  const normalizedByRef = new Map<string, string[]>();
  const allNormalized: string[] = [];
  for (const chunk of chunks) {
    const normalized = normalizeQuoteForMatch(stripTitlePrefix(chunk.content));
    const ref = chunk.ref.toLowerCase();
    const contents = normalizedByRef.get(ref) ?? [];
    if (!contents.includes(normalized)) contents.push(normalized);
    normalizedByRef.set(ref, contents);
    allNormalized.push(normalized);
  }

  const extracted = extractCitedQuotes(answerText);
  if (extracted.length === 0) {
    return {
      checked: 0,
      matched: 0,
      wrongRef: [],
      failed: [],
      unverifiable: [],
      unparseable: true,
    };
  }

  let matched = 0;
  const wrongRef: CitedQuote[] = [];
  const failed: CitedQuote[] = [];
  const unverifiable: CitedQuote[] = [];

  for (const cited of extracted) {
    const normalizedQuote = normalizeQuoteForMatch(cited.quote);

    const scoped = normalizedByRef.get(cited.ref.toLowerCase());
    if (scoped !== undefined) {
      // The cited chunk resolved: even a short quote is meaningful evidence
      // here, because the claim is scoped to this one chunk ("90 days" either
      // is in the cited chunk or it is not).
      if (scoped.some((content) => content.includes(normalizedQuote))) {
        matched++;
      } else {
        failed.push(cited);
      }
      continue;
    }

    // The ref names no returned chunk, so the citation as written is wrong
    // either way. A long-enough quote is searched across all returned chunks
    // to tell a mis-citation from a fabrication; a short one is not — it would
    // match almost anything — so it stays unverifiable rather than falsely
    // resolved in either direction.
    if (normalizedQuote.length < MIN_BROAD_SEARCH_QUOTE_CHARS) {
      unverifiable.push(cited);
    } else if (
      allNormalized.some((content) => content.includes(normalizedQuote))
    ) {
      wrongRef.push(cited);
    } else {
      failed.push(cited);
    }
  }

  return {
    checked: extracted.length,
    matched,
    wrongRef,
    failed,
    unverifiable,
    unparseable: false,
  };
}

/**
 * Reads the `{ ref, content }` chunks out of a `query_knowledge_sources`
 * CallToolResult as the tool produced it — before the chat tool layer collapses
 * it to a display string (and before hook feedback can be appended to that
 * string). The tool emits `structuredContent` (see structuredSuccessResult in
 * knowledge-management.ts) and `run_tool` passes it through, so that is the
 * primary shape; the first text content part is kept as a defensive fallback.
 * Typed structurally so this module stays dependency-free.
 *
 * @public — called from chat-tool-builder's per-turn chunk capture; asserted
 * directly in tests.
 */
export function readKbChunksFromToolResult(result: {
  structuredContent?: unknown;
  content?: unknown;
}): KbChunkForQuoteCheck[] {
  const results = extractKbResultsArray(result);
  if (!results) return [];

  const chunks: KbChunkForQuoteCheck[] = [];
  for (const item of results) {
    if (
      item !== null &&
      typeof item === "object" &&
      typeof (item as { ref?: unknown }).ref === "string" &&
      typeof (item as { content?: unknown }).content === "string"
    ) {
      const { ref, content } = item as { ref: string; content: string };
      chunks.push({ ref, content });
    }
  }
  return chunks;
}

// --- Internal helpers ---

/**
 * A quote below this length (after normalization) whose ref did not resolve is
 * reported unverifiable instead of being searched across all returned chunks:
 * a handful of characters appears in almost any chunk, so finding it there
 * would prove nothing. Quotes whose ref resolves are always checked, whatever
 * their length — the single cited chunk keeps a short match meaningful.
 */
const MIN_BROAD_SEARCH_QUOTE_CHARS = 12;

/**
 * Chunks are stored as `TITLE: <title>\n\n<body>` (see chunker.ts). The title is
 * metadata Archestra injects, not source text, so a quote should be checked
 * against the body — strip the prefix before matching.
 */
function stripTitlePrefix(content: string): string {
  const match = /^TITLE: .*?\n\n/s.exec(content);
  return match ? content.slice(match[0].length) : content;
}

/**
 * Pulls the `results` array out of a `query_knowledge_sources` CallToolResult:
 * `structuredContent.results` on the real path, or the first text content part
 * parsed as JSON as a defensive fallback.
 */
function extractKbResultsArray(result: {
  structuredContent?: unknown;
  content?: unknown;
}): unknown[] | null {
  const structured = result.structuredContent;
  if (
    structured !== null &&
    typeof structured === "object" &&
    Array.isArray((structured as { results?: unknown }).results)
  ) {
    return (structured as { results: unknown[] }).results;
  }

  if (Array.isArray(result.content)) {
    const firstText = result.content.find(
      (part): part is { type: "text"; text: string } =>
        part !== null &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    );
    if (firstText) return parseResultsFromJson(firstText.text);
  }

  return null;
}

/** Parses a JSON string and returns its `results` array, or null. */
function parseResultsFromJson(text: string): unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { results?: unknown }).results)
    ) {
      return (parsed as { results: unknown[] }).results;
    }
  } catch {
    // Not JSON we can read; nothing to verify from this result.
  }
  return null;
}
