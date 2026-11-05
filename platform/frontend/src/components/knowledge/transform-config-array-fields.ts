/**
 * Brace-wrap a bare M-Files vault GUID. M-Files Admin shows GUIDs
 * brace-wrapped and the backend requires that form, but pastes often arrive
 * bare — normalize instead of bouncing the user with a format error.
 */
export function normalizeMFilesVaultGuid(value: string): string {
  const guid = value.trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    guid,
  )
    ? `{${guid}}`
    : guid;
}

/** Render an array config field back as the comma-separated string the form edits. */
export function joinIfArray(value: unknown): string {
  return Array.isArray(value)
    ? (value as string[]).join(", ")
    : ((value as string) ?? "");
}

/** Complete settings for a newly added repository, independent of shared legacy values. */
export function githubRepositoryStandardSettingsDraft() {
  return {
    includeIssues: true,
    includePullRequests: true,
    includeRepositoryFiles: false,
    labelsToSkip: [],
    fileTypes: [],
    includePaths: [],
    excludePaths: [],
  };
}

export type GithubRepositoryEntryDraft = {
  repository: string;
  settings: Record<string, unknown>;
};
const GITHUB_SETTING_FIELDS = Object.keys(
  githubRepositoryStandardSettingsDraft(),
);

/** Concrete card values from production flat settings or a qualified repository policy. */
export function githubRepositorySettingsDraft(
  config: Record<string, unknown>,
  override?: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(githubRepositoryStandardSettingsDraft()).map(
      ([field, fallback]) => {
        const value = override?.[field] ?? config[field] ?? fallback;
        return [field, Array.isArray(fallback) ? joinIfArray(value) : value];
      },
    ),
  );
}
export function githubRepositoryEntriesDraft(
  config: Record<string, unknown>,
): GithubRepositoryEntryDraft[] {
  const repos = Array.isArray(config.repos)
    ? config.repos
    : typeof config.repos === "string"
      ? config.repos.split(",")
      : [];
  const policies = Array.isArray(config.repositoryOverrides)
    ? (config.repositoryOverrides as Record<string, unknown>[])
    : [];
  return repos
    .map((raw: string) => raw.trim())
    .filter(Boolean)
    .map((repository) => {
      const qualified = repository.includes("/")
        ? repository
        : `${config.owner}/${repository}`;
      const policy = policies.find(
        (entry) =>
          typeof entry.repository === "string" &&
          entry.repository.toLowerCase() === qualified.toLowerCase(),
      );
      return {
        repository: qualified,
        settings: githubRepositorySettingsDraft(config, policy),
      };
    });
}
function serializedGithubEntry(
  entry: GithubRepositoryEntryDraft,
): Record<string, unknown> {
  return transformConfigArrayFields({
    repository: entry.repository.trim(),
    ...Object.fromEntries(
      GITHUB_SETTING_FIELDS.map((field) => [field, entry.settings[field]]),
    ),
  });
}
/** Compare effective settings, ignoring CSV formatting and order within lists. */
export function githubRepositoryDraftFingerprint(
  entries: GithubRepositoryEntryDraft[],
): string {
  return JSON.stringify(
    entries
      .map((entry) => {
        const policy = serializedGithubEntry(entry);
        return {
          repository: entry.repository.trim().toLowerCase(),
          ...Object.fromEntries(
            GITHUB_SETTING_FIELDS.map((field) => [
              field,
              Array.isArray(policy[field])
                ? [...new Set(policy[field] as string[])].sort()
                : policy[field],
            ]),
          ),
        };
      })
      .sort((left, right) => left.repository.localeCompare(right.repository)),
  );
}

/** Convert comma-separated string fields to arrays before sending to the API. */
export function transformConfigArrayFields(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...config };

  if (Array.isArray(config.repositoryOverrides))
    result.repositoryOverrides = config.repositoryOverrides.map(
      (entry: Record<string, unknown>) =>
        transformConfigArrayFields({
          ...entry,
          repository:
            typeof entry.repository === "string"
              ? entry.repository.trim()
              : entry.repository,
        }),
    );
  const selectedMode =
    config.repositorySelectionMode === "selected" ||
    (config.repositorySelectionMode === undefined &&
      (Array.isArray(config.repos)
        ? config.repos.length > 0
        : typeof config.repos === "string" && config.repos.trim() !== ""));
  if (selectedMode && Array.isArray(config.repositoryEntries)) {
    const entries = config.repositoryEntries as GithubRepositoryEntryDraft[];
    const baseline = config.repositoryLegacyBaseline as
      | { owner?: string; fingerprint?: string }
      | undefined;
    const unchangedLegacy =
      baseline &&
      (baseline.owner ?? "").trim().toLowerCase() ===
        String(config.owner ?? "")
          .trim()
          .toLowerCase() &&
      baseline.fingerprint === githubRepositoryDraftFingerprint(entries);
    if (!unchangedLegacy) {
      result.repos = entries.map((entry) => entry.repository.trim());
      result.repositoryOverrides = entries.map(serializedGithubEntry);
    }
  } else if (!selectedMode && config.repositoryApplyShared === true) {
    result.repos = [];
    result.repositoryOverrides = [];
    const shared = config.repositorySharedSettings as
      | Record<string, unknown>
      | undefined;
    if (shared)
      for (const field of GITHUB_SETTING_FIELDS) result[field] = shared[field];
  }
  delete result.repositorySharedSettings;
  delete result.repositoryEntries;
  delete result.repositorySelectionMode;
  delete result.repositoryApplyShared;
  delete result.repositoryLegacyBaseline;

  // String array fields: split by comma, trim, filter empty
  const stringArrayFields = [
    "repos",
    "teamIds",
    "spaceKeys",
    "pageIds",
    "databaseIds",
    "labelsToSkip",
    "commentEmailBlacklist",
    "states",
    "assignmentGroups",
    "driveIds",
    "fileTypes",
    "includePaths",
    "depotPaths",
    "excludePaths",
    "userIds",
    "projectGids",
    "tagsToSkip",
    "objects",
    "collectionIds",
    "includePathPrefixes",
    "additionalStartUrls",
    "allowedOrigins",
    "excludePathPatterns",
    "excludeSelectors",
  ];
  for (const key of stringArrayFields) {
    if (typeof result[key] === "string") {
      const value = result[key] as string;
      result[key] = value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }

  if (typeof result.projectIds === "string") {
    const value = result.projectIds as string;

    if (result.type === "gitlab") {
      result.projectIds = value
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => !Number.isNaN(n));
    } else {
      result.projectIds = value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }

  if (typeof result.objectTypeIds === "string") {
    result.objectTypeIds = result.objectTypeIds
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value >= 0);
  }

  if (
    result.type === "servicenow" &&
    result.roleAudiences !== null &&
    typeof result.roleAudiences === "object"
  ) {
    // Per-table comma-separated role names → Record<table, string[]>; empty
    // entries (and an all-empty map) are dropped rather than stored.
    const roleAudiences: Record<string, string[]> = {};
    for (const [table, value] of Object.entries(
      result.roleAudiences as Record<string, unknown>,
    )) {
      const roles =
        typeof value === "string"
          ? value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : Array.isArray(value)
            ? (value as string[]).filter(Boolean)
            : [];
      if (roles.length > 0) roleAudiences[table] = roles;
    }
    if (Object.keys(roleAudiences).length > 0) {
      result.roleAudiences = roleAudiences;
    } else {
      delete result.roleAudiences;
    }
  }

  if (result.type === "perforce") {
    // Optional permission-sync fields: an empty string (rendered then cleared,
    // or left behind after switching away from auto-sync visibility) must be
    // absent rather than fail the backend's regex/min-length validation.
    for (const field of ["p4Port", "adminUsername"]) {
      if (result[field] === "" || result[field] === undefined) {
        delete result[field];
      }
    }
  }

  if (result.type === "mfiles") {
    if (typeof result.vaultGuid === "string") {
      result.vaultGuid = normalizeMFilesVaultGuid(result.vaultGuid);
    }
    if (result.domain === "") delete result.domain;
    const oauthFields = [
      "oauthTokenEndpoint",
      "oauthScope",
      "oauthResource",
      "oauthAuthConfig",
      "oauthAuthConfigScope",
      "oauthAccountName",
      "oauthUseIdToken",
      "oauthClientAuthMethod",
    ];
    // Absent means the legacy password-token mode — the backend's default —
    // so the seeded OAuth presets must not ride along in a password config.
    if (
      (result.authMethod ?? "mfiles_password_token") === "mfiles_password_token"
    ) {
      for (const field of oauthFields) delete result[field];
    } else {
      delete result.domain;
      for (const field of ["oauthScope", "oauthResource"]) {
        if (result[field] === "") delete result[field];
      }
    }
  }

  return result;
}
