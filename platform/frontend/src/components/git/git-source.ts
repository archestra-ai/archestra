import {
  type GitHost,
  type GitProvider,
  gitHostFromUrl,
  gitWebUrls,
  isCloudGitHost,
  normalizeGitSubpath,
  parseGitRepoUrl,
} from "@archestra/shared";
import type { GitCredential } from "@/lib/git-credentials.query";

/**
 * How a Git setup reads the repository: a saved GitHub App or GitLab token, or
 * nothing at all for a public repository on github.com or gitlab.com.
 */
export type GitAccess =
  | { kind: "public" }
  | { kind: "credential"; credential: GitCredential };

/** The host the repository lives on: the credential's, or the public cloud. */
export function gitAccessHost(params: {
  provider: GitProvider;
  access: GitAccess;
}): GitHost {
  return gitHostFromUrl({
    provider: params.provider,
    url:
      params.access.kind === "credential"
        ? params.access.credential.webUrl
        : null,
  });
}

/** The provider and credential fields every skills and plugins Git route takes. */
export function gitAuthFields(params: {
  provider: GitProvider;
  access: GitAccess;
}): {
  provider: GitProvider;
  githubAppConfigId?: string;
  gitlabTokenId?: string;
} {
  const { provider, access } = params;
  if (access.kind === "public") return { provider };
  return provider === "gitlab"
    ? { provider, gitlabTokenId: access.credential.id }
    : { provider, githubAppConfigId: access.credential.id };
}

export type ResolvedGitRepository =
  | {
      ok: true;
      host: GitHost;
      /** `owner/repo` or `group/sub/project`. */
      path: string;
      /** The repository's web address, without a branch or folder. */
      repoUrl: string;
      ref: string | null;
      subpath: string;
      /** What to show for it: the path, with the host when self-hosted. */
      label: string;
      /** The owner's avatar, only on github.com where it is public. */
      avatarUrl: string | null;
    }
  | { ok: false; error: string | null };

/**
 * Read what the user picked or pasted against the chosen host. A branch or
 * folder typed under Advanced wins over one in a pasted `/tree/` URL.
 */
export function resolveGitRepository(params: {
  provider: GitProvider;
  access: GitAccess;
  input: string;
  ref?: string;
  subpath?: string;
}): ResolvedGitRepository {
  const host = gitAccessHost(params);
  if (!params.input.trim()) return { ok: false, error: null };
  let location: ReturnType<typeof parseGitRepoUrl>;
  try {
    location = parseGitRepoUrl({ input: params.input, host });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Invalid repository",
    };
  }
  const urls = gitWebUrls({ host, path: location.path });
  const owner = location.path.split("/")[0];
  const cloud = isCloudGitHost(host);
  return {
    ok: true,
    host,
    path: location.path,
    repoUrl: urls.repo,
    ref: params.ref?.trim() || location.ref,
    subpath: normalizeGitSubpath(params.subpath?.trim() || location.subpath),
    label: cloud
      ? location.path
      : `${new URL(host.webUrl).host}/${location.path}`,
    avatarUrl:
      cloud && host.provider === "github"
        ? `https://github.com/${encodeURIComponent(owner)}.png`
        : null,
  };
}

/**
 * A repository address the Git routes accept, pointing at a branch when one
 * is set: skills read the branch from a `/tree/<ref>` URL.
 */
export function gitRepositoryUrlWithRef(
  repository: Extract<ResolvedGitRepository, { ok: true }>,
): string {
  if (!repository.ref) return repository.repoUrl;
  return gitWebUrls({ host: repository.host, path: repository.path }).tree(
    repository.ref,
  );
}

/** "github.com/acme" style host label, or null on the public cloud. */
export function selfHostedLabel(webUrl: string, provider: GitProvider) {
  const host = gitHostFromUrl({ provider, url: webUrl });
  return isCloudGitHost(host) ? null : new URL(host.webUrl).host;
}
