import {
  GIT_PROVIDER_LABELS,
  type GitProvider,
  gitChangeRequestNoun,
  gitHostFromUrl,
  gitWebUrls,
} from "@archestra/shared";

/**
 * Whether a failure GitHub reported is GitHub refusing the App: a 403, or a
 * token its installation would not grant. The server reports a failure as
 * its message only, so the message is what tells. For a source that syncs
 * through an App such a failure is never printed: what the App lacks is the
 * Finish setup notice's to say, and a second notice would only repeat it.
 */
export function isAccessRefusal(error: string | null | undefined): boolean {
  return !!error && /\bHTTP 403\b|^The GitHub App cannot act on /.test(error);
}

/**
 * A failure's message as a page prints it for this source: nothing when
 * there is none, and nothing when GitHub refused the source's App.
 */
export function shownFailure(
  source: { githubAppConfigId?: string | null } | null | undefined,
  error: string | null | undefined,
): string | null {
  if (!error) return null;
  return source?.githubAppConfigId && isAccessRefusal(error) ? null : error;
}

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
    /** What to click on the host to merge an open change request. */
    mergePath:
      provider === "gitlab"
        ? ["Merge"]
        : ["Merge pull request", "Confirm merge"],
    urls: (repo: string) => gitWebUrls({ host, path: repo }),
  };
}
