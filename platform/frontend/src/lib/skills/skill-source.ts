import { DEFAULT_GIT_WEB_URLS, type GitProvider } from "@archestra/shared";

/**
 * Reading a skill's `sourceRef`: `owner/repo@ref:path` for an imported skill
 * (`group/subgroup/project@ref:path` on GitLab), `builtin:<id>` for a
 * built-in one.
 */

/**
 * Repository identity: `owner/repo` on github.com, the full URL anywhere else
 * (GitHub Enterprise, GitLab); null for a built-in.
 */
export function parseRepoFromSourceRef(
  sourceRef: string | null,
  sourceOrigin?: string | null,
  provider?: GitProvider | null,
): string | null {
  const parsed = parseSourceRef(sourceRef);
  if (!parsed) return null;
  const repo = `${parsed.owner}/${parsed.repo}`;
  const origin = sourceOrigin ?? DEFAULT_GIT_WEB_URLS[provider ?? "github"];
  return origin !== DEFAULT_GIT_WEB_URLS.github ? `${origin}/${repo}` : repo;
}

/** The skill's folder in its repository; empty when the skill is the repo. */
export function skillSourcePath(sourceRef: string | null): string {
  return parseSourceRef(sourceRef)?.path ?? "";
}

/** A repository identity for display: `gitlab.com/group/project`, not a URL. */
export function repositoryLabel(identity: string): string {
  return identity.replace(/^https?:\/\//i, "");
}

/**
 * GitHub or GitLab URL for a skill's directory as it stood at one commit.
 *
 * Only the commit is versioned, so the repo and path come from the skill's
 * *current* `sourceRef`: a directory renamed upstream since resolves against
 * its new path and 404s, which beats showing the wrong files.
 */
export function githubSourceUrlAtCommit(params: {
  sourceRef: string | null;
  commit: string | null;
  sourceOrigin?: string | null;
  provider?: GitProvider | null;
}): string | null {
  const parsed = parseSourceRef(params.sourceRef);
  if (!parsed || !params.commit) return null;
  const path = parsed.path
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  const provider = params.provider ?? "github";
  const origin = params.sourceOrigin ?? DEFAULT_GIT_WEB_URLS[provider];
  // GitLab puts `/-` before a project's tree pages.
  const tree = provider === "gitlab" ? "/-/tree" : "/tree";
  const base = `${origin}/${parsed.owner}/${parsed.repo}${tree}/${params.commit}`;
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
  // `owner/repo`, or a GitLab project under nested groups. A lone segment is
  // not a repo reference.
  const segments = repoPart.split("/");
  if (segments.length < 2 || segments.some((segment) => !segment)) return null;
  const repo = segments.pop() as string;
  const owner = segments.join("/");

  // The ref may itself contain slashes (`release/2.0`) but never a colon, so
  // the first colon after the `@` starts the skill path.
  const colonIdx = atIdx === -1 ? -1 : sourceRef.indexOf(":", atIdx);
  return {
    owner,
    repo,
    path: colonIdx === -1 ? "" : sourceRef.slice(colonIdx + 1),
  };
}
