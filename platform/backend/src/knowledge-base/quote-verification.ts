/**
 * Quote verification for knowledge-base citations (issue #7161, "cheap" half).
 *
 * The chat model is asked — via the `query_knowledge_sources` tool result — to
 * back each claim with a short verbatim quote tagged with the source chunk's
 * `ref`. This module does the other half: pull those quote/ref pairs out of the
 * model's answer and check each quote actually appears in the cited chunk. A
 * quote that appears in no returned chunk is a fabrication caught
 * programmatically rather than by a reader, so it doubles as a hallucination
 * check.
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
 * A `> "quote" — ref` pair extracted from the model's answer.
 *
 * @public — part of the verify result shape; asserted directly in unit tests.
 */
export interface CitedQuote {
  quote: string;
  ref: string;
}

/** @public — return shape of verifyQuotes; asserted directly in unit tests. */
export interface QuoteVerificationResult {
  /** Quotes long enough to be worth checking (below the length floor are skipped). */
  checked: number;
  /** Of those checked, how many were found in the cited (or any returned) chunk. */
  matched: number;
  /** Checked quotes found in no returned chunk — the fabrications. */
  failed: CitedQuote[];
  /** Chunks were returned but the answer carried no parseable quote/ref pair. */
  unparseable: boolean;
}

/**
 * The instruction embedded in the `query_knowledge_sources` tool result so it
 * reaches the model exactly when chunks are returned. Kept next to the extractor
 * below so the requested format and the parser cannot drift apart.
 */
export const QUOTE_CITATION_INSTRUCTION =
  'When you state a fact drawn from these results, immediately back it with a short verbatim quote from the exact chunk that supports it, tagged with that chunk\'s "ref", formatted as: > "<verbatim quote>" — <ref>. Copy the quote exactly as it appears in the chunk\'s content, so the claim can be verified against its source.';

/** Builds the stable, model-visible citation anchor for a chunk. */
export function buildChunkRef(documentId: string, chunkIndex: number): string {
  return `${documentId}#${chunkIndex}`;
}

/**
 * Extracts `"quote" — ref` pairs written in the {@link QUOTE_CITATION_INSTRUCTION}
 * convention. Tolerant of the variance models introduce: straight or curly
 * quotes, em/en/hyphen dashes, and an optional backtick/bracket around the ref.
 * Duplicate (quote, ref) pairs are collapsed so repetition does not inflate
 * counts.
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
 * Verifies each cited quote against the chunk it names, falling back to every
 * returned chunk when the ref does not resolve (a mangled ref still can't hide a
 * fabrication — the quote must appear in *some* returned chunk). Matching is on
 * normalized text so incidental whitespace, smart-quote, and case differences do
 * not fail a legitimate quote; a minimum length keeps trivially short fragments
 * from matching by accident. Callers should only invoke this when chunks were
 * actually returned.
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
    return { checked: 0, matched: 0, failed: [], unparseable: true };
  }

  let checked = 0;
  let matched = 0;
  const failed: CitedQuote[] = [];

  for (const cited of extracted) {
    const normalizedQuote = normalizeForMatch(cited.quote);
    if (normalizedQuote.length < MIN_QUOTE_CHARS) continue;
    checked++;

    const scoped = normalizedByRef.get(cited.ref.toLowerCase());
    const haystacks = scoped !== undefined ? [scoped] : allNormalized;
    if (haystacks.some((content) => content.includes(normalizedQuote))) {
      matched++;
    } else {
      failed.push(cited);
    }
  }

  return { checked, matched, failed, unparseable: false };
}

/**
 * Reads the `{ ref, content }` chunks out of one `query_knowledge_sources` tool
 * result as it appears on an AI SDK step (`step.toolResults[].output`). The chat
 * tool layer collapses the MCP result to `{ content: <JSON string>, _meta }`
 * before it reaches the step (see `buildArchestraToolOutput`), so the chunks
 * arrive as JSON in the string `content` — parsed here. The
 * `structuredContent.results` and content-parts shapes are kept as defensive
 * fallbacks for any path that preserves them.
 *
 * @public — called from the chat route's onFinish; asserted directly in tests.
 */
export function readKbChunksFromToolOutput(
  output: unknown,
): KbChunkForQuoteCheck[] {
  const results = extractKbResultsArray(output);
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
 * Quotes shorter than this (after normalization) are ignored: a handful of
 * characters appears in almost any chunk, so matching them proves nothing.
 */
const MIN_QUOTE_CHARS = 12;

/**
 * `"quote" — ref` where ref is a `documentId#chunkIndex` anchor. Only the
 * double-quote delimiters (straight and curly) bound the quote — the convention
 * mandates them — so apostrophes and single quotes inside it (contractions,
 * possessives) are preserved rather than ending the quote early. The body still
 * excludes newlines and the double-quote delimiters so a stray closing quote
 * ends it; the ref is a uuid-shaped token followed by `#<index>`.
 */
const CITATION_PATTERN =
  /["“”]([^"“”\n]{1,400})["“”]\s*[—–-]{1,2}\s*[`[(]?\s*([0-9a-fA-F][0-9a-fA-F-]{7,}#\d+)/g;

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
 * Pulls the `results` array out of a `query_knowledge_sources` tool output,
 * whatever shape it arrives in. The real chat path is a JSON string in
 * `content`; the other two branches are defensive fallbacks.
 */
function extractKbResultsArray(output: unknown): unknown[] | null {
  if (output === null || typeof output !== "object") return null;

  const structured = (output as { structuredContent?: unknown })
    .structuredContent;
  if (
    structured !== null &&
    typeof structured === "object" &&
    Array.isArray((structured as { results?: unknown }).results)
  ) {
    return (structured as { results: unknown[] }).results;
  }

  const content = (output as { content?: unknown }).content;

  // The real chat shape: buildArchestraToolOutput collapses the result to
  // `{ content: <JSON string>, _meta }`, so parse it and read `.results`.
  if (typeof content === "string") {
    return parseResultsFromJson(content);
  }

  // Defensive fallback: a raw MCP result whose `content` is an array of parts.
  if (Array.isArray(content)) {
    const firstText = content.find(
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
