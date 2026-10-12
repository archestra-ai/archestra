import { getGithubApiBaseUrl, getGithubWebOrigin } from "./github";

/**
 * Git hosts the platform reads skills, plugins, and policies from. Each runs in
 * the cloud or self-hosted: GitHub.com or GitHub Enterprise Server, GitLab.com
 * or self-managed GitLab.
 */
export const GIT_PROVIDERS = ["github", "gitlab"] as const;
export type GitProvider = (typeof GIT_PROVIDERS)[number];

export const GIT_PROVIDER_LABELS: Record<GitProvider, string> = {
  github: "GitHub",
  gitlab: "GitLab",
};

/** Where a provider's repositories and REST API live. */
export interface GitHost {
  provider: GitProvider;
  /** e.g. https://github.com, https://gitlab.example.com */
  webUrl: string;
  /** e.g. https://api.github.com, https://gitlab.example.com/api/v4 */
  apiUrl: string;
}

/** A repository on a host. `path` is `owner/repo` or a nested `group/sub/project`. */
export interface GitRepoLocation {
  host: GitHost;
  path: string;
  /** Branch, tag, or commit from the URL; null means the default branch. */
  ref: string | null;
  /** Folder inside the repository, without leading or trailing slashes. */
  subpath: string;
}

export const DEFAULT_GIT_WEB_URLS: Record<GitProvider, string> = {
  github: "https://github.com",
  gitlab: "https://gitlab.com",
};

/**
 * A host from its web address (what users type) or, for GitHub, its API base.
 * Paths are dropped except for GitLab installed under a relative URL root.
 */
export function gitHostFromUrl(params: {
  provider: GitProvider;
  url?: string | null;
}): GitHost {
  const { provider } = params;
  const raw = params.url?.trim() || DEFAULT_GIT_WEB_URLS[provider];
  const url = new URL(
    /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`,
  );
  if (provider === "github") {
    const looksLikeApi =
      url.hostname.startsWith("api.") || /\/api\/v3\/?$/.test(url.pathname);
    const webUrl = looksLikeApi ? getGithubWebOrigin(url.href) : url.origin;
    return { provider, webUrl, apiUrl: getGithubApiBaseUrl(webUrl) };
  }
  const base = url.pathname.replace(/\/api\/v4\/?$/, "").replace(/\/+$/, "");
  const webUrl = `${url.origin}${base}`;
  return { provider, webUrl, apiUrl: `${webUrl}/api/v4` };
}

/** True when the host is the provider's public cloud. */
export function isCloudGitHost(host: GitHost): boolean {
  return host.webUrl === DEFAULT_GIT_WEB_URLS[host.provider];
}

/**
 * Parse what a user pastes for a repository: `owner/repo`, a host-less
 * `group/sub/project`, or a full URL, optionally pointing at a folder
 * (`/tree/<ref>/<path>` on GitHub, `/-/tree/<ref>/<path>` on GitLab).
 * A URL must belong to `host`; a host-less path is read against it.
 */
export function parseGitRepoUrl(params: {
  input: string;
  host: GitHost;
}): GitRepoLocation {
  const { host } = params;
  const trimmed = params.input.trim();
  if (!trimmed) throw new Error("Repository URL is required");
  const expected = new URL(host.webUrl);
  const hasProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed);
  const first = trimmed.split("/")[0];
  const hasHost =
    hasProtocol ||
    first.includes(".") ||
    first.includes(":") ||
    first.toLowerCase() === expected.host.toLowerCase();
  let pathname = trimmed;
  if (hasHost) {
    let url: URL;
    try {
      url = new URL(hasProtocol ? trimmed : `${expected.protocol}//${trimmed}`);
    } catch {
      throw new Error("Invalid repository URL");
    }
    if (url.username || url.password)
      throw new Error("Repository URL must not include credentials");
    if (url.host.toLowerCase() !== expected.host.toLowerCase())
      throw new Error(`Repository URL must belong to ${host.webUrl}`);
    pathname = url.pathname;
    // GitLab under a relative URL root, e.g. https://example.com/gitlab
    const base = expected.pathname.replace(/\/+$/, "");
    if (base && pathname.startsWith(`${base}/`))
      pathname = pathname.slice(base.length);
  }
  let segments = pathname.split("/").filter(Boolean);
  let ref: string | null = null;
  let urlSubpath: string[] = [];
  const treeIndex =
    host.provider === "gitlab"
      ? segments.indexOf("-")
      : segments.findIndex(
          (segment, index) =>
            index >= 2 && (segment === "tree" || segment === "blob"),
        );
  if (treeIndex >= 0) {
    const rest =
      host.provider === "gitlab"
        ? segments.slice(treeIndex + 1)
        : segments.slice(treeIndex);
    segments = segments.slice(0, treeIndex);
    if ((rest[0] === "tree" || rest[0] === "blob") && rest.length >= 2) {
      try {
        ref = decodeURIComponent(rest[1]);
        urlSubpath = rest.slice(2).map(decodeURIComponent);
      } catch {
        throw new Error("Invalid repository URL encoding");
      }
    }
  }
  if (segments.length > 0)
    segments[segments.length - 1] = segments[segments.length - 1].replace(
      /\.git$/,
      "",
    );
  if (segments.length < 2)
    throw new Error(
      host.provider === "gitlab"
        ? "Repository URL must include a group and project, e.g. group/project"
        : "Repository URL must include an owner and repo, e.g. owner/repo",
    );
  if (host.provider === "github" && segments.length !== 2)
    throw new Error("GitHub repositories are owner/repo");
  if (!segments.every((segment) => /^[\w.-]+$/.test(segment)))
    throw new Error("Invalid repository path");
  return {
    host,
    path: segments.join("/"),
    ref,
    subpath: normalizeGitSubpath(urlSubpath.join("/")),
  };
}

export function normalizeGitSubpath(path: string): string {
  return path.replace(/^\.?\/+/, "").replace(/\/+$/, "");
}

/** Browser links for a repository, its files, commits, and change requests. */
export function gitWebUrls(params: { host: GitHost; path: string }) {
  const { host, path } = params;
  const repo = `${host.webUrl}/${path}`;
  const sep = host.provider === "gitlab" ? "/-" : "";
  const encode = (value: string) =>
    value.split("/").map(encodeURIComponent).join("/");
  return {
    repo,
    tree: (ref: string, subpath = "") =>
      `${repo}${sep}/tree/${encode(ref)}${subpath ? `/${encode(subpath)}` : ""}`,
    file: (ref: string, filePath: string) =>
      `${repo}${sep}/blob/${encode(ref)}/${encode(filePath)}`,
    commit: (sha: string) => `${repo}${sep}/commit/${sha}`,
    changeRequest: (number: number) =>
      host.provider === "gitlab"
        ? `${repo}/-/merge_requests/${number}`
        : `${repo}/pull/${number}`,
  };
}

/** "pull request" on GitHub, "merge request" on GitLab. */
export function gitChangeRequestNoun(provider: GitProvider): string {
  return provider === "gitlab" ? "merge request" : "pull request";
}
