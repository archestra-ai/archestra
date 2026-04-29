import { RecursiveChunker, Tokenizer } from "@chonkiejs/core";
import type { Tiktoken } from "tiktoken";
import { buildMetadataSuffixes } from "./metadata-suffix";
import { countTokens, getEncoding } from "./tokenizer";

interface Chunk {
  content: string;
  chunkIndex: number;
  tokenCount: number;
  metadataSuffixSemantic: string | null;
  metadataSuffixKeyword: string | null;
}

interface DocumentInput {
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
}

const MAX_TOKENS = 512;
const MIN_CONTENT_BUDGET = 50;

export async function chunkDocument(document: DocumentInput): Promise<Chunk[]> {
  if (!document.content.trim()) {
    return [];
  }

  const encoding = getEncoding();
  const titlePrefix = buildTitlePrefix(document.title);
  const titlePrefixTokens = countTokens(encoding, titlePrefix);

  // Compute metadata suffixes if metadata provided
  let semanticSuffix: string | null = null;
  let keywordSuffix: string | null = null;
  let semanticSuffixTokens = 0;

  if (document.metadata && Object.keys(document.metadata).length > 0) {
    const suffixes = buildMetadataSuffixes({
      metadata: document.metadata,
      maxTokens: MAX_TOKENS,
      titleTokens: titlePrefixTokens,
    });
    semanticSuffix = suffixes.semantic;
    keywordSuffix = suffixes.keyword || null;
    semanticSuffixTokens = semanticSuffix
      ? countTokens(encoding, semanticSuffix)
      : 0;
  }

  // Reduce content budget by semantic suffix tokens
  const contentBudget = MAX_TOKENS - titlePrefixTokens - semanticSuffixTokens;

  const effectiveTitlePrefix =
    contentBudget < MIN_CONTENT_BUDGET
      ? truncateTitlePrefix(encoding, document.title)
      : titlePrefix;
  const effectiveBudget =
    contentBudget < MIN_CONTENT_BUDGET
      ? MAX_TOKENS -
        countTokens(encoding, effectiveTitlePrefix) -
        semanticSuffixTokens
      : contentBudget;

  const tokenizer = createTiktokenAdapter(encoding);
  const chunker = await RecursiveChunker.create({
    chunkSize: effectiveBudget,
    tokenizer,
  });

  const rawChunks = await chunker.chunk(document.content);

  return rawChunks.map((raw, index) => {
    const content = effectiveTitlePrefix + raw.text.trimStart();
    return {
      content,
      chunkIndex: index,
      tokenCount: countTokens(encoding, content),
      metadataSuffixSemantic: semanticSuffix,
      metadataSuffixKeyword: keywordSuffix,
    };
  });
}

// --- Internal helpers ---

function buildTitlePrefix(title: string): string {
  if (!title.trim()) return "";
  return `TITLE: ${title}\n\n`;
}

function truncateTitlePrefix(encoding: Tiktoken, title: string): string {
  const budget = Math.floor(MAX_TOKENS * 0.1);
  const prefix = "TITLE: ";
  const suffix = "\n\n";
  const overhead = countTokens(encoding, prefix + suffix);
  const titleBudget = Math.max(budget - overhead, 1);

  const tokens = encoding.encode(title);
  const truncatedTokens = tokens.slice(0, titleBudget);
  const truncatedTitle = new TextDecoder().decode(
    encoding.decode(truncatedTokens),
  );
  return `${prefix}${truncatedTitle}${suffix}`;
}

function createTiktokenAdapter(encoding: Tiktoken): Tokenizer {
  const adapter = new Tokenizer();
  adapter.countTokens = (text: string) => encoding.encode(text).length;
  adapter.encode = (text: string) => Array.from(encoding.encode(text));
  adapter.decode = (tokens: number[]) =>
    new TextDecoder().decode(encoding.decode(new Uint32Array(tokens)));
  adapter.decodeBatch = (tokensBatch: number[][]) =>
    tokensBatch.map((tokens) =>
      new TextDecoder().decode(encoding.decode(new Uint32Array(tokens))),
    );
  return adapter;
}
