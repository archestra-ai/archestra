/**
 * Reading a skill's `sourceRef`: `owner/repo@ref:path` for an imported skill,
 * `builtin:<id>` for a built-in one.
 */

/** The `owner/repo` a skill was imported from; null for a built-in. */
export function parseRepoFromSourceRef(
  sourceRef: string | null,
): string | null {
  const parsed = parseSourceRef(sourceRef);
  return parsed && `${parsed.owner}/${parsed.repo}`;
}

/**
 * GitHub URL for a skill's directory as it stood at one commit.
 *
 * Only the commit is versioned, so the repo and path come from the skill's
 * *current* `sourceRef`: a directory renamed upstream since resolves against
 * its new path and 404s, which beats showing the wrong files.
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
  // An identity token, not a repo — rendering it would leak the unbranded
  // "archestra" id into the UI.
  if (sourceRef.startsWith("builtin:")) return null;

  const atIdx = sourceRef.indexOf("@");
  const repoPart = atIdx === -1 ? sourceRef : sourceRef.slice(0, atIdx);
  const [owner, repo, ...rest] = repoPart.split("/");
  // `owner/repo` exactly — anything longer or shorter is not a repo reference.
  if (!owner || !repo || rest.length > 0) return null;

  // The ref may itself contain slashes (`release/2.0`) but never a colon, so
  // the first colon after the `@` starts the skill path.
  const colonIdx = atIdx === -1 ? -1 : sourceRef.indexOf(":", atIdx);
  return {
    owner,
    repo,
    path: colonIdx === -1 ? "" : sourceRef.slice(colonIdx + 1),
  };
}
