import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ParsedSkill,
  parseSkillManifest,
  SkillParseError,
} from "../backend/src/skills/parser";
import { dedupeSkillCatalogEntries } from "../backend/src/skills/skill-catalog-index";
import { POPULAR_REPOS } from "../frontend/src/app/skills/_parts/popular-repos";

interface CrawledSkill {
  repo: string;
  repoDescription: string;
  skillPath: string;
  name: string;
  description: string;
  compatibility: string | null;
  fileCount: number;
}

interface SkillIndexError {
  repo: string;
  path: string | null;
  message: string;
}

// repos are normalized out and skills are positional tuples to keep the
// artifact small; the backend rehydrates via decodeSkillCatalog in
// backend/src/skills/skill-catalog-index.ts.
type CompactRepo = [repo: string, repoDescription: string];
type CompactSkill = [
  repoIndex: number,
  skillPath: string,
  name: string,
  description: string,
  compatibility: string | null,
  fileCount: number,
];

interface GeneratedSkillIndex {
  v: number;
  generatedAt: string;
  source: {
    type: "popular-repos";
    repoCount: number;
  };
  repos: CompactRepo[];
  skills: CompactSkill[];
  errors: SkillIndexError[];
}

interface GithubRepoResponse {
  default_branch: string;
}

interface GithubTreeResponse {
  truncated?: boolean;
  tree?: GithubTreeItem[];
}

interface GithubTreeItem {
  type?: string;
  path?: string;
}

const GITHUB_API_URL = "https://api.github.com";
const GITHUB_RAW_URL = "https://raw.githubusercontent.com";
const SKILL_MANIFEST_FILENAME = "SKILL.md";
const REPO_CONCURRENCY = readPositiveInteger("SKILL_INDEX_REPO_CONCURRENCY", 6);
const MANIFEST_CONCURRENCY = readPositiveInteger(
  "SKILL_INDEX_MANIFEST_CONCURRENCY",
  12,
);

const scriptPath = fileURLToPath(import.meta.url);
const platformRoot = path.resolve(path.dirname(scriptPath), "..");
const outputPath = path.join(
  platformRoot,
  "backend/src/skills/skill-catalog.generated.json",
);

async function main() {
  if (!process.env.GITHUB_TOKEN) {
    console.warn(
      `No GITHUB_TOKEN set: crawling ${POPULAR_REPOS.length} repos unauthenticated will likely exceed GitHub's 60 req/hour limit. Set GITHUB_TOKEN to regenerate the full index.`,
    );
  }

  const results = await mapConcurrent(
    POPULAR_REPOS,
    REPO_CONCURRENCY,
    async (repo) => crawlRepo(repo),
  );

  // refuse to overwrite the checked-in index with a partial crawl — a single
  // failed repo (rate limiting, network, truncated tree) would silently drop
  // every skill it contains.
  const incomplete = results.filter((result) => !result.ok);
  if (incomplete.length > 0) {
    console.error(
      `Aborting without writing: ${incomplete.length}/${POPULAR_REPOS.length} repositories could not be fully crawled. The existing index was left untouched.`,
    );
    for (const result of incomplete) {
      for (const error of result.errors) {
        if (error.path === null) {
          console.error(`  ${error.repo}: ${error.message}`);
        }
      }
    }
    process.exitCode = 1;
    return;
  }

  // the crawl records every on-disk copy of a skill (repos bundle the same
  // skill into many plugin folders and re-vendor each other's skills); collapse
  // identical copies so the catalog lists each distinct skill once.
  const deduped = dedupeSkillCatalogEntries(results.flatMap((r) => r.skills));
  deduped.sort(compareCrawledSkills);

  const { repos, skills } = compact(deduped);
  const index: GeneratedSkillIndex = {
    v: 1,
    generatedAt: new Date().toISOString(),
    source: {
      type: "popular-repos",
      repoCount: POPULAR_REPOS.length,
    },
    repos,
    skills,
    errors: results.flatMap((result) => result.errors),
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serializeIndex(index), "utf8");

  console.log(
    `Generated ${index.skills.length} skill index entries from ${POPULAR_REPOS.length} repositories.`,
  );
  if (index.errors.length > 0) {
    console.log(
      `Skipped ${index.errors.length} entries. See generated errors.`,
    );
  }
  console.log(outputPath);
}

async function crawlRepo(repo: (typeof POPULAR_REPOS)[number]) {
  const errors: SkillIndexError[] = [];
  // a repo is only "ok" if we crawled its whole tree; a thrown request (e.g.
  // rate limiting) or a truncated tree means we'd be writing a partial index.
  let ok = true;
  try {
    const repoResponse = await fetchGithubJson<GithubRepoResponse>(
      `${GITHUB_API_URL}/repos/${repo.repo}`,
    );
    const defaultBranch = repoResponse.default_branch;
    const tree = await fetchGithubJson<GithubTreeResponse>(
      `${GITHUB_API_URL}/repos/${repo.repo}/git/trees/${encodeURIComponent(
        defaultBranch,
      )}?recursive=1`,
    );

    if (tree.truncated) {
      ok = false;
      errors.push({
        repo: repo.repo,
        path: null,
        message: "GitHub returned a truncated recursive tree",
      });
    }

    const treeItems = tree.tree ?? [];
    const manifestPaths = treeItems
      .filter(
        (item) =>
          item.type === "blob" &&
          item.path !== undefined &&
          basename(item.path) === SKILL_MANIFEST_FILENAME,
      )
      .map((item) => item.path as string)
      .sort((left, right) => left.localeCompare(right));

    const parsed = await mapConcurrent(
      manifestPaths,
      MANIFEST_CONCURRENCY,
      async (manifestPath): Promise<CrawledSkill | null> => {
        const raw = await fetchRawFile({
          repo: repo.repo,
          ref: defaultBranch,
          filePath: manifestPath,
        });
        let manifest: ParsedSkill;
        try {
          manifest = parseSkillManifest(raw);
        } catch (error) {
          // record skills the import flow itself would reject (missing or
          // malformed frontmatter) and skip them, without failing the repo.
          errors.push({
            repo: repo.repo,
            path: manifestPath,
            message:
              error instanceof SkillParseError
                ? error.message
                : errorMessage(error),
          });
          return null;
        }

        const skillPath = dirname(manifestPath);
        // count every file the skill ships, including its own SKILL.md, so an
        // instruction-only skill reads "1 file" rather than "0".
        const fileCount = treeItems.filter(
          (item) =>
            item.type === "blob" &&
            item.path !== undefined &&
            isUnderSkillDir(item.path, skillPath),
        ).length;

        return {
          repo: repo.repo,
          repoDescription: repo.description,
          skillPath,
          name: manifest.name,
          description: manifest.description,
          compatibility: manifest.compatibility,
          fileCount,
        };
      },
    );

    return {
      skills: parsed.filter((skill) => skill !== null),
      errors,
      ok,
    };
  } catch (error) {
    return {
      skills: [],
      errors: [
        ...errors,
        {
          repo: repo.repo,
          path: null,
          message: errorMessage(error),
        },
      ],
      ok: false,
    };
  }
}

async function fetchGithubJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: githubHeaders() });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${url}`);
  }
  return (await response.json()) as T;
}

async function fetchRawFile(params: {
  repo: string;
  ref: string;
  filePath: string;
}): Promise<string> {
  const response = await fetch(
    `${GITHUB_RAW_URL}/${params.repo}/${encodeURIComponentPath(
      params.ref,
    )}/${encodeURIComponentPath(params.filePath)}`,
    { headers: githubHeaders() },
  );
  if (!response.ok) {
    throw new Error(
      `${response.status} ${response.statusText} for ${params.repo}:${params.filePath}`,
    );
  }
  return response.text();
}

async function mapConcurrent<T, U>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results: U[] = [];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    worker(),
  );
  await Promise.all(workers);
  return results;
}

function githubHeaders(): HeadersInit {
  const headers: HeadersInit = {
    "User-Agent": "archestra-skill-index-generator",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
}

function compareCrawledSkills(left: CrawledSkill, right: CrawledSkill) {
  const repoComparison = left.repo.localeCompare(right.repo);
  if (repoComparison !== 0) return repoComparison;
  return left.skillPath.localeCompare(right.skillPath);
}

function compact(skills: CrawledSkill[]): {
  repos: CompactRepo[];
  skills: CompactSkill[];
} {
  const repos: CompactRepo[] = [];
  const repoIndex = new Map<string, number>();
  const compactSkills = skills.map((skill): CompactSkill => {
    let index = repoIndex.get(skill.repo);
    if (index === undefined) {
      index = repos.length;
      repoIndex.set(skill.repo, index);
      repos.push([skill.repo, skill.repoDescription]);
    }
    return [
      index,
      skill.skillPath,
      skill.name,
      skill.description,
      skill.compatibility,
      skill.fileCount,
    ];
  });
  return { repos, skills: compactSkills };
}

// one positional row per line keeps the generated artifact compact while still
// producing readable git diffs.
function serializeIndex(index: GeneratedSkillIndex): string {
  const rows = (values: unknown[]) =>
    values.length === 0
      ? "[]"
      : `[\n${values.map((value) => JSON.stringify(value)).join(",\n")}\n]`;
  return `${[
    "{",
    `"v": ${JSON.stringify(index.v)},`,
    `"generatedAt": ${JSON.stringify(index.generatedAt)},`,
    `"source": ${JSON.stringify(index.source)},`,
    `"repos": ${rows(index.repos)},`,
    `"skills": ${rows(index.skills)},`,
    `"errors": ${rows(index.errors)}`,
    "}",
  ].join("\n")}\n`;
}

function readPositiveInteger(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function encodeURIComponentPath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

function isUnderSkillDir(filePath: string, skillPath: string): boolean {
  return skillPath ? filePath.startsWith(`${skillPath}/`) : true;
}

function basename(value: string): string {
  return value.split("/").pop() ?? value;
}

function dirname(value: string): string {
  const index = value.lastIndexOf("/");
  return index === -1 ? "" : value.slice(0, index);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
