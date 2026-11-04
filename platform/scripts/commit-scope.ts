/**
 * Which workspace checks a commit needs, from the paths it stages.
 *
 * The pre-commit hook used to run `check:commit` (type-check, knip, Biome and
 * the backend's own checks) in every package. Turbo's cache skips unchanged
 * packages in a long-lived checkout, but every fresh worktree starts with an
 * empty cache, so its first commit type-checked and linted the whole platform
 * even when it touched one package or none.
 *
 * - A path inside a workspace package selects that package; Turbo adds its
 *   dependents (`...<name>`) and their prerequisite tasks.
 * - A path elsewhere under platform/ can change how every package is checked
 *   (biome.json, turbo.json, scripts/, tsconfig, the lockfile), so it selects
 *   everything, unless it is in an area no check reads.
 * - A path outside platform/ (docs/, .github/, .agents/) needs no platform check.
 */
export type CommitScope =
  | { kind: "all" }
  | { kind: "none" }
  | { kind: "packages"; names: string[] };

export function commitScope(params: {
  /** Staged paths, relative to the repository root. */
  stagedPaths: readonly string[];
  /** platform/'s path from the repository root, with a trailing slash. */
  platformPrefix: string;
  /** Workspace packages: directory relative to platform/, and package name. */
  packages: readonly { dir: string; name: string }[];
}): CommitScope {
  const names = new Set<string>();
  for (const stagedPath of params.stagedPaths) {
    if (!stagedPath.startsWith(params.platformPrefix)) continue;
    const relative = stagedPath.slice(params.platformPrefix.length);
    const owner = params.packages
      .filter(({ dir }) => relative.startsWith(`${dir}/`))
      // The deepest directory owns the path (no package nests today).
      .sort((a, b) => b.dir.length - a.dir.length)[0];
    if (owner) {
      names.add(owner.name);
      for (const consumer of UNDECLARED_CONSUMERS[owner.name] ?? []) {
        names.add(consumer);
      }
      continue;
    }
    const reader = OUTSIDE_INPUTS.find(({ dir }) => relative.startsWith(dir));
    if (reader) {
      names.add(reader.name);
      continue;
    }
    if (isUnchecked(relative)) continue;
    return { kind: "all" };
  }
  return names.size === 0
    ? { kind: "none" }
    : { kind: "packages", names: [...names].sort() };
}

// ===== Internal helpers =====

/**
 * Consumers Turbo cannot see because no package.json declares them: the
 * backend imports the migration linter through a tsconfig path and runs it
 * in its migration lint, so a linter change must check the backend too.
 */
const UNDECLARED_CONSUMERS: Readonly<Record<string, readonly string[]>> = {
  "@archestra/drizzle-migration-linter": ["@backend"],
};

/**
 * Directories outside every package that one package's checks read: the
 * backend checks the sandbox base image against the Rust runtime's Python
 * requirements, and tests the agent images' Dockerfiles.
 */
const OUTSIDE_INPUTS: readonly { dir: string; name: string }[] = [
  { dir: "docker_images/", name: "@backend" },
];

/**
 * Areas under platform/ that no `check:commit` task reads: Tilt and
 * deployment files, images, and prose. Anything not listed here counts as
 * check configuration and runs every package's checks.
 */
const UNCHECKED_DIRS = [
  "dev/",
  "helm/",
  "docker/",
  "agent_images/",
  "mcp_server_docker_image/",
];
const UNCHECKED_FILES = new Set([".env.example", "Dockerfile", "Tiltfile"]);

function isUnchecked(relative: string): boolean {
  if (UNCHECKED_DIRS.some((dir) => relative.startsWith(dir))) return true;
  if (UNCHECKED_FILES.has(relative)) return true;
  // Prose at the platform root (AGENTS.md, CHANGELOG.md, ...).
  return !relative.includes("/") && relative.endsWith(".md");
}
