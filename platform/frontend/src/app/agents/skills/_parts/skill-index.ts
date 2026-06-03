export interface SkillIndexEntry {
  repo: string;
  repoDescription: string;
  skillPath: string;
  name: string;
  description: string;
  compatibility: string | null;
  fileCount: number;
}

// ===== Compact on-disk format (decoded once at load) =====

// repos are normalized out of the per-skill rows so the 50 repo strings aren't
// duplicated across 2,445 skills; skills are positional tuples to drop repeated
// JSON key names. See standalone-scripts/generate-skill-index.ts.
type CompactRepo = [repo: string, repoDescription: string];
type CompactSkill = [
  repoIndex: number,
  skillPath: string,
  name: string,
  description: string,
  compatibility: string | null,
  fileCount: number,
];

export interface CompactSkillIndex {
  repos: CompactRepo[];
  skills: CompactSkill[];
}

export function decodeSkillIndex(data: CompactSkillIndex): SkillIndexEntry[] {
  return data.skills.map(
    ([repoIndex, skillPath, name, description, compatibility, fileCount]) => {
      // reuse the repo/description string references from the repos table so
      // skills sharing a repo don't each retain their own copy in memory.
      const [repo, repoDescription] = data.repos[repoIndex];
      return {
        repo,
        repoDescription,
        skillPath,
        name,
        description,
        compatibility,
        fileCount,
      };
    },
  );
}

// ===== Token inverted index (built once at load, not shipped) =====

// Field a token was found in, ordered by search weight (lower = stronger).
const Field = {
  Name: 0,
  Repo: 1,
  SkillPath: 2,
  Description: 3,
  RepoDescription: 4,
  Compatibility: 5,
} as const;
type Field = (typeof Field)[keyof typeof Field];

// Per-field score; Field.Name is scored separately (exact vs prefix).
const FIELD_WEIGHT = [0, 35, 30, 25, 15, 10];
const NAME_EXACT_WEIGHT = 100;
const NAME_PREFIX_WEIGHT = 80;
const FULL_NAME_MATCH_BONUS = 120;

// A posting packs (entryIndex, field) into one integer: entryIndex * 8 + field.
// Field fits in 3 bits (0..5), so the shift is lossless and avoids allocating
// an object per (token, entry) pair.
const FIELD_BITS = 3;
const FIELD_MASK = (1 << FIELD_BITS) - 1;

export interface SkillSearchIndex {
  entries: readonly SkillIndexEntry[];
  /** Sorted distinct tokens, for prefix range scans via binary search. */
  tokens: string[];
  /** token -> packed postings. */
  postings: Map<string, number[]>;
  /** Normalized full name per entry, for the exact-name bonus. */
  normalizedNames: string[];
}

export function buildSkillIndex(
  entries: readonly SkillIndexEntry[],
): SkillSearchIndex {
  const postings = new Map<string, number[]>();
  const normalizedNames = new Array<string>(entries.length);

  entries.forEach((entry, entryIndex) => {
    normalizedNames[entryIndex] = normalize(entry.name);

    // strongest field each token appears in for this entry
    const tokenField = new Map<string, Field>();
    indexField(tokenField, entry.name, Field.Name);
    indexField(tokenField, entry.repo, Field.Repo);
    indexField(tokenField, entry.skillPath, Field.SkillPath);
    indexField(tokenField, entry.description, Field.Description);
    indexField(tokenField, entry.repoDescription, Field.RepoDescription);
    if (entry.compatibility) {
      indexField(tokenField, entry.compatibility, Field.Compatibility);
    }

    for (const [token, field] of tokenField) {
      const packed = (entryIndex << FIELD_BITS) | field;
      const bucket = postings.get(token);
      if (bucket) bucket.push(packed);
      else postings.set(token, [packed]);
    }
  });

  return {
    entries,
    tokens: [...postings.keys()].sort(),
    postings,
    normalizedNames,
  };
}

export function searchSkillIndex(
  index: SkillSearchIndex,
  query: string,
  limit = 100,
): SkillIndexEntry[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  // intersect across query tokens: an entry must match every token, scored by
  // the best field each token hit.
  let scores: Map<number, number> | null = null;
  for (const queryToken of queryTokens) {
    const tokenScores = new Map<number, number>();
    for (const matched of matchingTokens(index.tokens, queryToken)) {
      const exact = matched === queryToken;
      for (const packed of index.postings.get(matched) as number[]) {
        const entryIndex = packed >> FIELD_BITS;
        const field = packed & FIELD_MASK;
        const weight =
          field === Field.Name
            ? exact
              ? NAME_EXACT_WEIGHT
              : NAME_PREFIX_WEIGHT
            : FIELD_WEIGHT[field];
        const current = tokenScores.get(entryIndex);
        if (current === undefined || weight > current) {
          tokenScores.set(entryIndex, weight);
        }
      }
    }

    if (scores === null) {
      scores = tokenScores;
    } else {
      const intersection = new Map<number, number>();
      for (const [entryIndex, weight] of tokenScores) {
        const accumulated = scores.get(entryIndex);
        if (accumulated !== undefined) {
          intersection.set(entryIndex, accumulated + weight);
        }
      }
      scores = intersection;
    }
    if (scores.size === 0) return [];
  }
  if (scores === null) return [];

  const joinedQuery = queryTokens.join(" ");
  const ranked: { entry: SkillIndexEntry; score: number }[] = [];
  for (const [entryIndex, score] of scores) {
    const bonus =
      index.normalizedNames[entryIndex] === joinedQuery
        ? FULL_NAME_MATCH_BONUS
        : 0;
    ranked.push({ entry: index.entries[entryIndex], score: score + bonus });
  }

  ranked.sort(compareRanked);
  return ranked.slice(0, limit).map(({ entry }) => entry);
}

/** Convenience for ad-hoc/tested searches: build a one-shot index, then query. */
export function searchSkillIndexEntries(params: {
  entries: readonly SkillIndexEntry[];
  query: string;
  limit?: number;
}): SkillIndexEntry[] {
  return searchSkillIndex(
    buildSkillIndex(params.entries),
    params.query,
    params.limit,
  );
}

// ===== Internal helpers =====

function indexField(
  tokenField: Map<string, Field>,
  value: string,
  field: Field,
): void {
  for (const token of tokenize(value)) {
    const current = tokenField.get(token);
    if (current === undefined || field < current) tokenField.set(token, field);
  }
}

/** Tokens in `sorted` that equal `prefix` or start with it (a contiguous run). */
function matchingTokens(sorted: string[], prefix: string): string[] {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < prefix) lo = mid + 1;
    else hi = mid;
  }
  const matches: string[] = [];
  for (let i = lo; i < sorted.length && sorted[i].startsWith(prefix); i += 1) {
    matches.push(sorted[i]);
  }
  return matches;
}

function compareRanked(
  left: { entry: SkillIndexEntry; score: number },
  right: { entry: SkillIndexEntry; score: number },
): number {
  if (left.score !== right.score) return right.score - left.score;
  const byName = left.entry.name.localeCompare(right.entry.name);
  if (byName !== 0) return byName;
  return left.entry.skillPath.localeCompare(right.entry.skillPath);
}

function tokenize(value: string): string[] {
  return normalize(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0 && !STOP_WORDS.has(token));
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

// dropped from both the index and queries: function words that carry no search
// signal but produce the corpus's largest posting lists (~16% of all postings).
const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "at",
  "by",
  "from",
  "as",
  "is",
  "are",
  "be",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "into",
  "your",
  "you",
  "our",
  "we",
  "their",
  "them",
  "they",
  "when",
  "use",
  "used",
  "using",
  "which",
  "while",
  "where",
  "what",
  "how",
  "can",
  "will",
  "should",
  "would",
  "more",
  "most",
  "other",
  "than",
  "then",
]);
