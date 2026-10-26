import type { GithubConfig } from "@/types/knowledge-connector";

type GithubRepositoryOverride = NonNullable<
  GithubConfig["repositoryOverrides"]
>[number];

type GithubRepositorySettings = {
  includeIssues: boolean;
  includePullRequests: boolean;
  includeRepositoryFiles: boolean;
  labelsToSkip: string[];
  fileTypes: string[];
  includePaths: string[];
  excludePaths: string[];
};

/** An explicit empty canonical list resets old path-only overrides too. */
export function getGithubRepositoryOverrides(
  config: GithubConfig,
): readonly GithubRepositoryOverride[] {
  return config.repositoryOverrides ?? config.repositoryPathFilters ?? [];
}

export function resolveGithubRepositorySettings(
  config: GithubConfig,
  repo: { owner: string; name: string },
): GithubRepositorySettings {
  const overrides = getGithubRepositoryOverrides(config);
  const fullName = `${repo.owner}/${repo.name}`.toLowerCase();
  const override =
    overrides.find((entry) => entry.repository.toLowerCase() === fullName) ??
    overrides.find(
      (entry) =>
        repo.owner.toLowerCase() === config.owner.toLowerCase() &&
        entry.repository.toLowerCase() === repo.name.toLowerCase(),
    );

  return {
    includeIssues: override?.includeIssues ?? config.includeIssues ?? true,
    includePullRequests:
      override?.includePullRequests ?? config.includePullRequests ?? true,
    includeRepositoryFiles:
      override?.includeRepositoryFiles ??
      config.includeRepositoryFiles ??
      false,
    labelsToSkip: [...(override?.labelsToSkip ?? config.labelsToSkip ?? [])],
    // Empty fileTypes retains the connector's built-in Markdown/YAML fallback.
    fileTypes: [...(override?.fileTypes ?? config.fileTypes ?? [])],
    includePaths: [...(override?.includePaths ?? config.includePaths ?? [])],
    excludePaths: [...(override?.excludePaths ?? config.excludePaths ?? [])],
  };
}
