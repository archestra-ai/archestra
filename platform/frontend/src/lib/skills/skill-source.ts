/**
 * Reading a skill's `sourceRef` — the packed provenance string the backend
 * writes for imported skills, shaped `owner/repo@ref:path` (built-in skills
 * carry `builtin:<id>` instead, which is an identity token, not a repo).
 */

/** Extract `owner/repo` from a `source_ref` shaped like `owner/repo@ref:path`. */
export function parseRepoFromSourceRef(
  sourceRef: string | null,
): string | null {
  const parsed = parseSourceRef(sourceRef);
  return parsed && `${parsed.owner}/${parsed.repo}`;
}

/**
 * GitHub URL for a skill's directory as it stood at one commit, for a version
 * that recorded the commit it was pulled from.
 *
 * The repo and path come from the skill's *current* `sourceRef` because only
 * the commit is versioned, so a directory renamed upstream since resolves
 * against its new path. GitHub 404s that rather than showing the wrong files,
 * which is the right failure for an informational link.
 */
export function githubSourceUrlAtCommit(params: {
  sourceRef: string | null;
  commit: string | null;
}): string | null {
  const parsed = parseSourceRef(params.sourceRef);
  if (!parsed || !params.commit) return null;
  const path = parsed.path
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  const base = `https://github.com/${parsed.owner}/${parsed.repo}/tree/${params.commit}`;
  return path ? `${base}/${path}` : base;
}

// === Internal helpers ===

interface ParsedSourceRef {
  owner: string;
  repo: string;
  /** Skill directory relative to the repo root; empty when the skill is the repo. */
  path: string;
}

function parseSourceRef(sourceRef: string | null): ParsedSourceRef | null {
  if (!sourceRef) return null;
  // Built-in skills carry an internal `builtin:<id>` ref (e.g.
  // `builtin:archestra-platform-operations`); it is an identity token, not a
  // source repo, and would leak the unbranded "archestra" id into the UI.
  if (sourceRef.startsWith("builtin:")) return null;

  const atIdx = sourceRef.indexOf("@");
  const repoPart = atIdx === -1 ? sourceRef : sourceRef.slice(0, atIdx);
  const [owner, repo, ...rest] = repoPart.split("/");
  // `owner/repo` exactly — anything longer or shorter is not a repo reference.
  if (!owner || !repo || rest.length > 0) return null;

  // The ref may itself contain slashes (`release/2.0`) but never a colon, so
  // the first colon after the `@` starts the skill path. Matches the backend's
  // parseSourceRef in the GitHub sync handler.
  const colonIdx = atIdx === -1 ? -1 : sourceRef.indexOf(":", atIdx);
  return {
    owner,
    repo,
    path: colonIdx === -1 ? "" : sourceRef.slice(colonIdx + 1),
  };
}
