import { RecursiveChunker, Tokenizer } from "@chonkiejs/core";
import type { Tiktoken } from "tiktoken";
import config from "@/config";
import { buildMetadataSuffixes } from "./metadata-suffix";
import { countTokens, encodeText, getEncoding } from "./tokenizer";

interface Chunk {
  content: string;
  chunkIndex: number;
  tokenCount: number;
  metadataSuffixSemantic: string | null;
  metadataSuffixKeyword: string | null;
  /**
   * Which parent passage this chunk was sliced out of, or `null` when the chunk
   * IS the passage (single-pass indexing). Children of one parent share this
   * ordinal and are contiguous in `chunkIndex`.
   */
  parentIndex: number | null;
}

interface DocumentInput {
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
  /**
   * Token budget for one chunk. Defaults to the deployment's configured chunk
   * size; passed explicitly by tests so they do not depend on env state.
   */
  maxTokens?: number;
  /**
   * Token budget for one child chunk when indexing at two granularities. 0
   * (the default) subdivides nothing and reproduces single-pass output.
   * Defaults to the deployment's configured child size; passed explicitly by
   * tests so they do not depend on env state.
   */
  childMaxTokens?: number;
}

const MIN_CONTENT_BUDGET = 50;

/**
 * Split a document into the chunks retrieval will search.
 *
 * By default this is one pass: the document is cut into passages of
 * `maxTokens` and each passage is a chunk. With `childMaxTokens` set, each
 * passage is cut a second time into smaller children and only the children are
 * returned — they carry the `parentIndex` of the passage they came from, which
 * retrieval uses to serve the whole passage for a hit on any one of them.
 *
 * Splitting the passage rather than the document a second time is what makes
 * that reversible: children never straddle a passage boundary, so the ones
 * sharing a `parentIndex` partition exactly the text the single-pass chunk
 * would have held.
 */
export async function chunkDocument(document: DocumentInput): Promise<Chunk[]> {
  if (!document.content.trim()) {
    return [];
  }

  const MAX_TOKENS = document.maxTokens ?? config.kb.chunkSizeTokens;
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
      ? truncateTitlePrefix(encoding, document.title, MAX_TOKENS)
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

  const childMaxTokens =
    document.childMaxTokens ?? config.kb.childChunkSizeTokens;
  const childBudget = resolveChildBudget({
    encoding,
    childMaxTokens,
    parentBudget: effectiveBudget,
    titlePrefixTokens: countTokens(encoding, effectiveTitlePrefix),
    metadata: document.metadata,
  });

  if (childBudget === null) {
    return rawChunks.map((raw, index) => ({
      content: effectiveTitlePrefix + raw.text.trimStart(),
      chunkIndex: index,
      tokenCount: countTokens(
        encoding,
        effectiveTitlePrefix + raw.text.trimStart(),
      ),
      metadataSuffixSemantic: semanticSuffix,
      metadataSuffixKeyword: keywordSuffix,
      parentIndex: null,
    }));
  }

  const childChunker = await RecursiveChunker.create({
    chunkSize: childBudget.contentBudget,
    tokenizer,
  });

  const chunks: Chunk[] = [];
  for (const [parentIndex, parent] of rawChunks.entries()) {
    const rawChildren = await childChunker.chunk(parent.text);
    for (const rawChild of rawChildren) {
      const content = effectiveTitlePrefix + rawChild.text.trimStart();
      chunks.push({
        content,
        chunkIndex: chunks.length,
        tokenCount: countTokens(encoding, content),
        metadataSuffixSemantic: childBudget.semanticSuffix,
        metadataSuffixKeyword: keywordSuffix,
        parentIndex,
      });
    }
  }

  return chunks;
}

// --- Internal helpers ---

/**
 * The content budget for one child, or `null` when the document should not be
 * subdivided at all.
 *
 * Subdividing is skipped when the child budget is not actually smaller than the
 * parent's: every parent would yield exactly one child, which is single-pass
 * output that has paid for a parent link and the sibling lookup it triggers on
 * every search hit.
 *
 * The semantic metadata suffix is re-judged against the child budget rather
 * than inherited from the parent. It rides along in the embedding input, so on
 * a chunk a quarter the size it takes four times the share of the vector — the
 * exact dilution small chunks exist to avoid. `buildMetadataSuffixes` already
 * encodes that trade-off, so it is simply asked again at the smaller size; the
 * keyword suffix it returns is unaffected either way, being indexed into
 * `search_vector` rather than embedded.
 */
function resolveChildBudget(params: {
  encoding: Tiktoken;
  childMaxTokens: number;
  parentBudget: number;
  titlePrefixTokens: number;
  metadata: Record<string, unknown> | undefined;
}): { contentBudget: number; semanticSuffix: string | null } | null {
  const {
    encoding,
    childMaxTokens,
    parentBudget,
    titlePrefixTokens,
    metadata,
  } = params;

  if (childMaxTokens <= 0) return null;

  let semanticSuffix: string | null = null;
  if (metadata && Object.keys(metadata).length > 0) {
    semanticSuffix = buildMetadataSuffixes({
      metadata,
      maxTokens: childMaxTokens,
      titleTokens: titlePrefixTokens,
    }).semantic;
  }
  const semanticSuffixTokens = semanticSuffix
    ? countTokens(encoding, semanticSuffix)
    : 0;

  const contentBudget = Math.max(
    childMaxTokens - titlePrefixTokens - semanticSuffixTokens,
    MIN_CONTENT_BUDGET,
  );

  if (contentBudget >= parentBudget) return null;

  return { contentBudget, semanticSuffix };
}

function buildTitlePrefix(title: string): string {
  if (!title.trim()) return "";
  return `TITLE: ${title}\n\n`;
}

function truncateTitlePrefix(
  encoding: Tiktoken,
  title: string,
  maxTokens: number,
): string {
  const budget = Math.floor(maxTokens * 0.1);
  const prefix = "TITLE: ";
  const suffix = "\n\n";
  const overhead = countTokens(encoding, prefix + suffix);
  const titleBudget = Math.max(budget - overhead, 1);

  const tokens = encodeText(encoding, title);
  const truncatedTokens = tokens.slice(0, titleBudget);
  const truncatedTitle = new TextDecoder().decode(
    encoding.decode(truncatedTokens),
  );
  return `${prefix}${truncatedTitle}${suffix}`;
}

function createTiktokenAdapter(encoding: Tiktoken): Tokenizer {
  const adapter = new Tokenizer();
  adapter.countTokens = (text: string) => encodeText(encoding, text).length;
  adapter.encode = (text: string) => Array.from(encodeText(encoding, text));
  adapter.decode = (tokens: number[]) =>
    new TextDecoder().decode(encoding.decode(new Uint32Array(tokens)));
  adapter.decodeBatch = (tokensBatch: number[][]) =>
    tokensBatch.map((tokens) =>
      new TextDecoder().decode(encoding.decode(new Uint32Array(tokens))),
    );
  return adapter;
}
