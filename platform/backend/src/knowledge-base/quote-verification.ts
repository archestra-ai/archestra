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
 * Pure and dependency-free by design, so the matching behaviour is unit-testable
 * in isolation.
 */

/** A chunk a returned citation points at: its `ref` and the text the model saw. */
export interface KbChunkForQuoteCheck {
  ref: string;
  content: string;
}

/**
 * A `"quote" — ref` pair extracted from the model's answer.
 *
 * @public — part of the verify result shape; asserted directly in unit tests.
 */
export interface CitedQuote {
  quote: string;
  ref: string;
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
 * The instruction embedded in the `query_knowledge_sources` tool result so it
 * reaches the model exactly when chunks are returned. Kept next to the extractor
 * below so the requested format and the parser cannot drift apart.
 */
export const QUOTE_CITATION_INSTRUCTION =
  'When you state a fact drawn from these results, mark it inline with a numbered reference like [1], and list every reference in a "Sources" section at the end of your answer. Format each source line exactly as: [1] "<verbatim quote>" — <ref>, where the quote is a short excerpt (one sentence or fragment, at most 15 words) copied exactly as it appears in the supporting chunk\'s content, and <ref> is that chunk\'s "ref" value. Cite each distinct fact once and never repeat a quote.';

/** Builds the stable, model-visible citation anchor for a chunk. */
export function buildChunkRef(documentId: string, chunkIndex: number): string {
  return `${documentId}#${chunkIndex}`;
}

/**
 * Extracts `"quote" — ref` pairs written in the {@link QUOTE_CITATION_INSTRUCTION}
 * convention — canonically `[n] "quote" — ref` lines in a trailing Sources
 * section, but position-independent: any `"quote" — ref` adjacency in the
 * answer parses, so inline or blockquoted citations still count. Tolerant of
 * the variance models introduce: straight or curly quotes, em/en/hyphen
 * dashes, and an optional backtick/bracket around the ref. Duplicate
 * (quote, ref) pairs are collapsed so repetition does not inflate counts.
 *
 * @public — exercised directly by unit tests; also used by verifyQuotes below.
 */
export function extractCitedQuotes(answerText: string): CitedQuote[] {
  const seen = new Set<string>();
  const quotes: CitedQuote[] = [];
  for (const match of answerText.matchAll(CITATION_PATTERN)) {
    const quote = match[1]?.trim();
    const ref = match[2]?.trim();
    if (!quote || !ref) continue;
    const key = `${normalizeForMatch(quote)}\u0000${ref.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    quotes.push({ quote, ref });
  }
  return quotes;
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

  const normalizedByRef = new Map<string, string>();
  const allNormalized: string[] = [];
  for (const chunk of chunks) {
    const normalized = normalizeForMatch(stripTitlePrefix(chunk.content));
    normalizedByRef.set(chunk.ref.toLowerCase(), normalized);
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
    const normalizedQuote = normalizeForMatch(cited.quote);

    const scoped = normalizedByRef.get(cited.ref.toLowerCase());
    if (scoped !== undefined) {
      // The cited chunk resolved: even a short quote is meaningful evidence
      // here, because the claim is scoped to this one chunk ("90 days" either
      // is in the cited chunk or it is not).
      if (scoped.includes(normalizedQuote)) {
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
 * `"quote" — ref` where ref is a `documentId#chunkIndex` anchor. The quote body
 * may itself contain double quotes (source text routinely does): the lazy body
 * grows until a closing double quote immediately followed by the dash and a
 * ref-shaped token, so only the delimiter that actually precedes the citation
 * anchor terminates it — an embedded quote cannot end the match early and
 * truncate what gets verified. The body still excludes newlines; the ref is a
 * uuid-shaped token followed by `#<index>`. A Sources line's leading `[n]`
 * marker sits before the opening quote, outside the match.
 */
const CITATION_PATTERN =
  /["“”]([^\n]{1,400}?)["“”]\s*[—–-]{1,2}\s*[`[(]?\s*([0-9a-fA-F][0-9a-fA-F-]{7,}#\d+)/g;

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
 * Folds away the differences a model introduces when it copies a quote —
 * whitespace runs, smart quotes, dash variants, and case — so matching compares
 * the words, not the typography.
 */
function normalizeForMatch(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—―]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
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
