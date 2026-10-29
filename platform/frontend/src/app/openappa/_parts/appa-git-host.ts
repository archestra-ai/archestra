import {
  GIT_PROVIDER_LABELS,
  type GitProvider,
  gitChangeRequestNoun,
  gitHostFromUrl,
  gitWebUrls,
} from "@archestra/shared";

/**
 * Words and links for the host the policy syncs with: GitHub pull requests or
 * GitLab merge requests, on the cloud or a self-hosted instance.
 */
export function appaGitHost(
  sync: { provider?: GitProvider; githubWebUrl?: string } | null | undefined,
) {
  const provider: GitProvider = sync?.provider ?? "github";
  const host = gitHostFromUrl({ provider, url: sync?.githubWebUrl });
  const noun = gitChangeRequestNoun(provider);
  return {
    provider,
    /** "GitHub" or "GitLab". */
    label: GIT_PROVIDER_LABELS[provider],
    /** "pull request" or "merge request". */
    changeRequest: noun,
    /** "PR" or "MR". */
    changeRequestShort: provider === "gitlab" ? "MR" : "PR",
    /** "repository" or "project". */
    repository: provider === "gitlab" ? "project" : "repository",
    urls: (repo: string) => gitWebUrls({ host, path: repo }),
  };
}
