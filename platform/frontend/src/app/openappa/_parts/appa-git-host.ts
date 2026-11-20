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
 * its message only, so the message is what tells.
 */
export function isAccessRefusal(error: string | null | undefined): boolean {
  return !!error && /\bHTTP 403\b|^The GitHub App cannot act on /.test(error);
}

/**
 * What a page prints for a refusal that nothing else on it explains: the
 * App holds every permission as far as GitHub says, so something else turns
 * it away (the App is not installed on the repository, a limit, an
 * organization's access rule).
 */
export const UNEXPLAINED_REFUSAL =
  "GitHub refused the App. Check that it is installed on the repository, then sync again.";

/**
 * A failure's message as a page prints it for this source: nothing when
 * there is none, and never GitHub's own words for refusing the source's
 * App. While the Finish setup notice names a permission the App lacks
 * (`explained`), that refusal is the notice's to say and a second notice
 * would only repeat it. With nothing to explain it, a plain sentence stands
 * in, so a failed sync is never left without a reason on screen. Any other
 * failure is printed as it is.
 */
export function shownFailure(
  source: { githubAppConfigId?: string | null } | null | undefined,
  error: string | null | undefined,
  explained: boolean,
): string | null {
  if (!error) return null;
  if (!source?.githubAppConfigId || !isAccessRefusal(error)) return error;
  return explained ? null : UNEXPLAINED_REFUSAL;
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
