import type { archestraApiTypes } from "@archestra/shared";

type Source = archestraApiTypes.GetAppaGithubSyncResponses["200"]["source"];

/**
 * What became of the initial policy pull request a repository was created with.
 * The row only keeps the number until the merge imports the policy, so a
 * caller that remembers the number can tell a merge from a repository that
 * never needed a pull request.
 */
type SetupPullRequestOutcome =
  // Open, or closed without merging: the server's lastSyncError says which.
  | "pending"
  // Merged and the policy imported.
  | "merged"
  // Sync was stopped or re-pointed elsewhere while the dialog was open.
  | "gone";

export function setupPullRequestOutcome(
  source: Source | null | undefined,
  number: number,
): SetupPullRequestOutcome {
  if (!source?.interval || !source.repo) return "gone";
  if (source.setupPullRequestNumber === number) return "pending";
  if (source.setupPullRequestNumber) return "gone";
  return "merged";
}
