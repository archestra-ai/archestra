import generatedSkillIndex from "./skill-index.generated.json";

export interface SkillIndexEntry {
  repo: string;
  repoDescription: string;
  repoStars: number;
  skillPath: string;
  name: string;
  description: string;
  compatibility: string | null;
  fileCount: number;
  sourceRef: string;
}

interface GeneratedSkillIndex {
  skills: SkillIndexEntry[];
}

interface RankedSkillIndexEntry {
  entry: SkillIndexEntry;
  score: number;
}

const skillIndex = generatedSkillIndex as GeneratedSkillIndex;

export const SKILL_INDEX_ENTRIES = skillIndex.skills;
export const SKILL_INDEX_ENTRY_COUNT = SKILL_INDEX_ENTRIES.length;

export function searchSkillIndex(
  query: string,
  limit = 100,
): SkillIndexEntry[] {
  return searchSkillIndexEntries({
    entries: SKILL_INDEX_ENTRIES,
    query,
    limit,
  });
}

export function searchSkillIndexEntries(params: {
  entries: readonly SkillIndexEntry[];
  query: string;
  limit?: number;
}): SkillIndexEntry[] {
  const tokens = tokenize(params.query);
  if (tokens.length === 0) return [];

  const ranked: RankedSkillIndexEntry[] = [];
  for (const entry of params.entries) {
    const score = scoreEntry(entry, tokens);
    if (score > 0) ranked.push({ entry, score });
  }

  ranked.sort(compareRankedEntries);
  return ranked.slice(0, params.limit ?? 100).map(({ entry }) => entry);
}

function scoreEntry(entry: SkillIndexEntry, tokens: readonly string[]): number {
  const fields = {
    name: normalize(entry.name),
    description: normalize(entry.description),
    repo: normalize(entry.repo),
    repoDescription: normalize(entry.repoDescription),
    skillPath: normalize(entry.skillPath),
    compatibility: normalize(entry.compatibility ?? ""),
  };

  let score = 0;
  for (const token of tokens) {
    const tokenScore = scoreToken(fields, token);
    if (tokenScore === 0) return 0;
    score += tokenScore;
  }

  if (fields.name === tokens.join(" ")) score += 120;
  return score;
}

function scoreToken(
  fields: {
    name: string;
    description: string;
    repo: string;
    repoDescription: string;
    skillPath: string;
    compatibility: string;
  },
  token: string,
): number {
  if (fields.name === token) return 100;
  if (fields.name.startsWith(token)) return 80;
  if (fields.name.includes(token)) return 60;
  if (fields.repo.includes(token)) return 35;
  if (fields.skillPath.includes(token)) return 30;
  if (fields.description.includes(token)) return 25;
  if (fields.repoDescription.includes(token)) return 15;
  if (fields.compatibility.includes(token)) return 10;
  return 0;
}

function compareRankedEntries(
  left: RankedSkillIndexEntry,
  right: RankedSkillIndexEntry,
): number {
  if (left.score !== right.score) return right.score - left.score;
  if (left.entry.repoStars !== right.entry.repoStars) {
    return right.entry.repoStars - left.entry.repoStars;
  }
  const nameComparison = left.entry.name.localeCompare(right.entry.name);
  if (nameComparison !== 0) return nameComparison;
  return left.entry.skillPath.localeCompare(right.entry.skillPath);
}

function tokenize(query: string): string[] {
  return normalize(query).split(/\s+/).filter(Boolean);
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}
