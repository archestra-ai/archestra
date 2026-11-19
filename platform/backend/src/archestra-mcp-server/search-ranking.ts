import {
  normalizeSearchText as normalizeText,
  tokenizeNormalizedText as tokenize,
} from "./search-text";

export type KeywordSearchText = {
  name: string;
  title: string;
  description: string;
  argNames: string;
  argDescriptions: string;
  generated: string;
};

export type PreparedSearchQuery = {
  normalizedQuery: string;
  // unique query terms — deduped so a repeated query word does not multiply its
  // own contribution (field-side tokens keep duplicates for term frequency).
  tokens: string[];
};

export function prepareSearchQuery(query: string): PreparedSearchQuery {
  const normalizedQuery = normalizeText(query);
  return {
    normalizedQuery,
    tokens: Array.from(new Set(tokenize(normalizedQuery))),
  };
}

export function rankByKeyword<T>(params: {
  candidates: T[];
  query: PreparedSearchQuery;
  searchTextOf: (candidate: T) => KeywordSearchText;
  /** Breaks score ties, so the same query always returns one stable order. */
  nameOf: (candidate: T) => string;
}): T[] {
  const { candidates, query, searchTextOf, nameOf } = params;
  if (!query.normalizedQuery) {
    return [];
  }

  const indexed = candidates.map((candidate) => {
    const searchText = searchTextOf(candidate);
    const entry: IndexedCandidate = {
      searchText,
      fieldTokens: {
        name: tokenize(searchText.name),
        title: tokenize(searchText.title),
        description: tokenize(searchText.description),
        argNames: tokenize(searchText.argNames),
        argDescriptions: tokenize(searchText.argDescriptions),
        generated: tokenize(searchText.generated),
      },
    };
    return { candidate, entry };
  });

  const entries = indexed.map(({ entry }) => entry);
  const corpus: CorpusStats = {
    avgFieldLength: computeAvgFieldLength(entries),
    docFrequency: computeDocFrequency(entries),
    docCount: entries.length,
  };

  return indexed
    .map(({ candidate, entry }) => ({
      candidate,
      score: scoreCandidate(entry, query, corpus),
    }))
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        nameOf(left.candidate).localeCompare(nameOf(right.candidate)),
    )
    .map(({ candidate }) => candidate);
}

// ===== Internal helpers =====

// BM25F keyword ranking over the per-field corpus. Field weights make a name
// hit count for more than a description hit; length normalization is disabled
// (b=0) for the short name/title fields and kept mild for the free-text fields.
// IDF uses the log(1 + …) variant so it stays strictly positive — the textbook
// BM25 IDF can go negative when a term appears in most documents, a real hazard
// on the tiny per-agent corpora this runs over. Literal whole-query name/title
// matches get a large additive boost on top so an exact tool name always wins.
const BM25F_FIELDS = [
  "name",
  "title",
  "description",
  "argNames",
  "argDescriptions",
  "generated",
] as const;
type Bm25Field = (typeof BM25F_FIELDS)[number];

const BM25F_FIELD_CONFIG: Record<Bm25Field, { weight: number; b: number }> = {
  name: { weight: 10, b: 0 },
  title: { weight: 6, b: 0 },
  description: { weight: 3, b: 0.75 },
  argNames: { weight: 2, b: 0.5 },
  argDescriptions: { weight: 1, b: 0.75 },
  generated: { weight: 4, b: 0.75 },
};
const BM25F_K1 = 1.5;
const EXACT_NAME_BOOST = 1000;
const NAME_SUBSTRING_BOOST = 100;
const EXACT_TITLE_BOOST = 600;
const TITLE_SUBSTRING_BOOST = 60;

type IndexedCandidate = {
  searchText: KeywordSearchText;
  fieldTokens: Record<Bm25Field, string[]>;
};

type CorpusStats = {
  avgFieldLength: Record<Bm25Field, number>;
  docFrequency: Map<string, number>;
  docCount: number;
};

function computeAvgFieldLength(
  indexed: IndexedCandidate[],
): Record<Bm25Field, number> {
  const totals: Record<Bm25Field, number> = {
    name: 0,
    title: 0,
    description: 0,
    argNames: 0,
    argDescriptions: 0,
    generated: 0,
  };
  for (const entry of indexed) {
    for (const field of BM25F_FIELDS) {
      totals[field] += entry.fieldTokens[field].length;
    }
  }
  const count = indexed.length || 1;
  const averages = {} as Record<Bm25Field, number>;
  for (const field of BM25F_FIELDS) {
    averages[field] = totals[field] / count;
  }
  return averages;
}

function computeDocFrequency(indexed: IndexedCandidate[]): Map<string, number> {
  const docFrequency = new Map<string, number>();
  for (const entry of indexed) {
    const seen = new Set<string>();
    for (const field of BM25F_FIELDS) {
      for (const token of entry.fieldTokens[field]) {
        seen.add(token);
      }
    }
    for (const token of seen) {
      docFrequency.set(token, (docFrequency.get(token) ?? 0) + 1);
    }
  }
  return docFrequency;
}

function scoreCandidate(
  entry: IndexedCandidate,
  query: PreparedSearchQuery,
  corpus: CorpusStats,
): number {
  let score = bm25fScore(entry, query.tokens, corpus);

  const { name, title } = entry.searchText;
  const { normalizedQuery } = query;
  if (name === normalizedQuery) {
    score += EXACT_NAME_BOOST;
  } else if (name.includes(normalizedQuery)) {
    score += NAME_SUBSTRING_BOOST;
  }
  if (title === normalizedQuery) {
    score += EXACT_TITLE_BOOST;
  } else if (title?.includes(normalizedQuery)) {
    score += TITLE_SUBSTRING_BOOST;
  }
  return score;
}

function bm25fScore(
  entry: IndexedCandidate,
  queryTokens: string[],
  corpus: CorpusStats,
): number {
  let score = 0;
  for (const term of queryTokens) {
    const docsWithTerm = corpus.docFrequency.get(term);
    if (!docsWithTerm) {
      continue;
    }
    const idf = Math.log(
      1 + (corpus.docCount - docsWithTerm + 0.5) / (docsWithTerm + 0.5),
    );

    let weightedTf = 0;
    for (const field of BM25F_FIELDS) {
      const fieldTokens = entry.fieldTokens[field];
      const tf = countOccurrences(fieldTokens, term);
      if (tf === 0) {
        continue;
      }
      const { weight, b } = BM25F_FIELD_CONFIG[field];
      const avgLength = corpus.avgFieldLength[field] || 1;
      const normalization = 1 - b + (b * fieldTokens.length) / avgLength;
      weightedTf += (weight * tf) / normalization;
    }

    if (weightedTf > 0) {
      score += (idf * weightedTf) / (BM25F_K1 + weightedTf);
    }
  }
  return score;
}

function countOccurrences(tokens: string[], term: string): number {
  let count = 0;
  for (const token of tokens) {
    if (token === term) {
      count += 1;
    }
  }
  return count;
}
