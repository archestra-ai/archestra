import { countTokens, getEncoding } from "./tokenizer";

interface MetadataSuffixes {
  /** Structured key-value format for embeddings. null if over 25% token budget or min content rule. */
  semantic: string | null;
  /** Space-separated values only, for BM25. Always present if metadata is non-empty. */
  keyword: string;
}

const SEMANTIC_BUDGET_RATIO = 0.25;
const CHUNK_MIN_CONTENT = 256;

export function buildMetadataSuffixes(params: {
  metadata: Record<string, unknown>;
  maxTokens?: number;
  titleTokens?: number;
}): MetadataSuffixes {
  const { metadata, maxTokens = 512, titleTokens = 0 } = params;

  const entries = extractEntries(metadata);

  if (entries.length === 0) {
    return { semantic: null, keyword: "" };
  }

  const semanticSuffix = buildSemanticSuffix(entries);
  const keywordSuffix = buildKeywordSuffix(entries);

  const encoding = getEncoding();
  const semanticTokens = countTokens(encoding, semanticSuffix);

  // 25% budget rule: if semantic suffix alone exceeds 25% of max tokens, drop it
  if (semanticTokens >= maxTokens * SEMANTIC_BUDGET_RATIO) {
    return { semantic: null, keyword: keywordSuffix };
  }

  // Min content rule: if remaining content budget after title + metadata <= CHUNK_MIN_CONTENT, drop semantic
  const remainingContentBudget = maxTokens - titleTokens - semanticTokens;
  if (remainingContentBudget <= CHUNK_MIN_CONTENT) {
    return { semantic: null, keyword: keywordSuffix };
  }

  return { semantic: semanticSuffix, keyword: keywordSuffix };
}

// --- Internal helpers ---

type Entry = { key: string; value: string };

function extractEntries(metadata: Record<string, unknown>): Entry[] {
  const entries: Entry[] = [];

  for (const [key, value] of Object.entries(metadata)) {
    if (value === null || value === undefined) continue;

    if (typeof value === "string") {
      if (value.trim()) entries.push({ key, value });
    } else if (typeof value === "number" || typeof value === "boolean") {
      entries.push({ key, value: String(value) });
    } else if (Array.isArray(value)) {
      const stringValues = value.filter(
        (v): v is string => typeof v === "string" && v.trim() !== "",
      );
      if (stringValues.length > 0) {
        entries.push({ key, value: stringValues.join(", ") });
      }
    }
    // Skip objects and other complex types
  }

  return entries;
}

function buildSemanticSuffix(entries: Entry[]): string {
  const lines = entries.map((e) => `\t${e.key} - ${e.value}`);
  return `\nMetadata:\n${lines.join("\n")}`;
}

function buildKeywordSuffix(entries: Entry[]): string {
  const values = entries.map((e) => e.value);
  return `\n${values.join(" ")}`;
}
