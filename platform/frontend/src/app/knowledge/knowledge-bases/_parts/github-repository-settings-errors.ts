const REPOSITORY_SETTINGS_FIELDS = new Set([
  "repos",
  "repositoryEntries",
  "repositoryOverrides",
  "includeIssues",
  "includePullRequests",
  "includeRepositoryFiles",
  "labelsToSkip",
  "fileTypes",
  "includePaths",
  "excludePaths",
]);

export function hasOnlyGithubRepositorySettingsErrors(
  formErrors: unknown,
): boolean {
  if (!formErrors || typeof formErrors !== "object") return false;
  const errors = formErrors as Record<string, unknown>;
  if (Object.keys(errors).some((key) => key !== "config")) return false;
  if (!errors.config || typeof errors.config !== "object") return false;
  const fields = Object.keys(errors.config);
  return (
    fields.length > 0 &&
    fields.every((field) => REPOSITORY_SETTINGS_FIELDS.has(field))
  );
}
