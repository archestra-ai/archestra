import type { GithubConfig } from "@/types/knowledge-connector";

type GithubRepositorySettings = {
  includeIssues: boolean;
  includePullRequests: boolean;
  includeRepositoryFiles: boolean;
  labelsToSkip: string[];
  fileTypes: string[];
  includePaths: string[];
  excludePaths: string[];
};

export function resolveGithubRepositorySettings(
  config: GithubConfig,
  repo: { owner: string; name: string },
): GithubRepositorySettings {
  const fullName = `${repo.owner}/${repo.name}`.toLowerCase();
  const override = config.repositoryOverrides?.find(
    (entry) => entry.repository.toLowerCase() === fullName,
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
