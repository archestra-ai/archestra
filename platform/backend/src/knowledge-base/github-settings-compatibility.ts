import { isDeepStrictEqual } from "node:util";
import type { GithubConfig } from "@/types/knowledge-connector";
import { resolveGithubRepositorySettings } from "./connectors/github/github-repository-settings";

export function githubRepositorySettingsWriteError(
  current: GithubConfig,
  next: GithubConfig,
): string | null {
  const omittedGlobalExclusions =
    (current.excludePaths?.length ?? 0) > 0 && next.excludePaths === undefined;
  if (omittedGlobalExclusions) {
    return "This configuration would discard existing repository settings. Reload the connector settings before saving, or reset the setting explicitly.";
  }
  if ((current.repositoryOverrides?.length ?? 0) === 0) return null;
  return next.repositoryOverrides !== undefined
    ? null
    : "This connector has repository overrides. Reload its settings in a client that supports repository overrides before changing its configuration.";
}

function syncConfiguration(config: GithubConfig) {
  const { repositoryOverrides: _overrides, ...base } = config;
  const defaults = resolveGithubRepositorySettings(
    { ...config, repositoryOverrides: [] },
    { owner: config.owner, name: "" },
  );
  const normalizeSettings = (settings: typeof defaults) => ({
    ...settings,
    fileTypes: settings.fileTypes.length ? settings.fileTypes : null,
  });
  const defaultSettings = normalizeSettings(defaults);
  const repositories = new Set(
    (config.repositoryOverrides ?? []).map(({ repository }) =>
      repository.toLowerCase(),
    ),
  );
  const overrides = [...repositories].sort().flatMap((repository) => {
    const slash = repository.indexOf("/");
    const settings = normalizeSettings(
      resolveGithubRepositorySettings(config, {
        owner: repository.slice(0, slash),
        name: repository.slice(slash + 1),
      }),
    );
    return isDeepStrictEqual(settings, defaultSettings)
      ? []
      : [{ repository, settings }];
  });
  return {
    ...base,
    repos: config.repos ?? [],
    ...defaultSettings,
    repositoryOverrides: overrides,
  };
}

/** Compare effective selection, so a representation-only save keeps its cursor. */
export function githubSyncConfigurationChanged(
  current: GithubConfig,
  next: GithubConfig,
): boolean {
  return !isDeepStrictEqual(
    syncConfiguration(current),
    syncConfiguration(next),
  );
}
