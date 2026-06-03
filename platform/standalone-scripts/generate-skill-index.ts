import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { POPULAR_REPOS } from "../frontend/src/app/agents/skills/_parts/popular-repos";

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

// repos are normalized out and skills are positional tuples to keep the shipped
// artifact small; the frontend rehydrates via decodeSkillIndex in skill-index.ts.
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

interface ParsedManifest {
  name: string;
  description: string;
  compatibility: string | null;
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
  "frontend/src/app/agents/skills/_parts/skill-index.generated.json",
);

async function main() {
  const results = await mapConcurrent(
    POPULAR_REPOS,
    REPO_CONCURRENCY,
    async (repo) => crawlRepo(repo),
  );

  const crawled = results.flatMap((result) => result.skills);
  crawled.sort(compareCrawledSkills);

  const { repos, skills } = compact(crawled);
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
        const manifest = parseSkillManifest(raw);
        if (!manifest) {
          errors.push({
            repo: repo.repo,
            path: manifestPath,
            message: "SKILL.md frontmatter is missing name or description",
          });
          return null;
        }

        const skillPath = dirname(manifestPath);
        const fileCount = treeItems.filter(
          (item) =>
            item.type === "blob" &&
            item.path !== undefined &&
            isUnderSkillDir(item.path, skillPath) &&
            basename(item.path) !== SKILL_MANIFEST_FILENAME,
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

function parseSkillManifest(raw: string): ParsedManifest | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/);
  if (!match) return null;

  const fields = parseFrontmatterScalars(match[1]);
  const name = fields.get("name")?.trim();
  const description = fields.get("description")?.trim();
  if (!name || !description) return null;

  const compatibility = fields.get("compatibility")?.trim() || null;
  return { name, description, compatibility };
}

function parseFrontmatterScalars(frontmatter: string): Map<string, string> {
  const fields = new Map<string, string>();
  const lines = frontmatter.replaceAll("\r\n", "\n").split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(line);
    if (!match) continue;

    const key = match[1];
    const value = match[2] ?? "";
    if (value.startsWith("|") || value.startsWith(">")) {
      const blockLines: string[] = [];
      index += 1;
      for (; index < lines.length; index += 1) {
        const blockLine = lines[index];
        if (/^[A-Za-z0-9_-]+:\s*/.test(blockLine)) {
          index -= 1;
          break;
        }
        blockLines.push(blockLine.replace(/^\s{2}/, ""));
      }
      fields.set(
        key,
        value.startsWith(">")
          ? blockLines.join(" ").replace(/\s+/g, " ").trim()
          : blockLines.join("\n").trim(),
      );
      continue;
    }

    fields.set(key, unquoteYamlScalar(value));
  }

  return fields;
}

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;

  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch (_error) {
      return trimmed.slice(1, -1);
    }
  }

  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }

  return trimmed;
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
