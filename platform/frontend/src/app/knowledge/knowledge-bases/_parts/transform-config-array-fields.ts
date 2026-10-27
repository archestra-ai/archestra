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

const GITHUB_INHERITABLE_OVERRIDE_FIELDS = new Set([
  "includeIssues",
  "includePullRequests",
  "includeRepositoryFiles",
  "labelsToSkip",
  "fileTypes",
  "includePaths",
  "excludePaths",
]);

/** Null is a form-only inheritance value; undefined can restore a loaded Controller default. */
export function githubRepositoryOverrideDraft(
  override: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...override,
    ...Object.fromEntries(
      [...GITHUB_INHERITABLE_OVERRIDE_FIELDS].map((field) => [
        field,
        override[field] ?? null,
      ]),
    ),
  };
}

/** Convert comma-separated string fields to arrays before sending to the API. */
export function transformConfigArrayFields(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...config };

  const repositoryOverrides =
    config.repositoryOverrides ?? config.repositoryPathFilters;
  if (Array.isArray(repositoryOverrides)) {
    result.repositoryOverrides = repositoryOverrides.map(
      (override: Record<string, unknown>) => ({
        ...Object.fromEntries(
          Object.entries(transformConfigArrayFields(override)).filter(
            ([field, value]) =>
              value !== undefined &&
              (value !== null ||
                !GITHUB_INHERITABLE_OVERRIDE_FIELDS.has(field)),
          ),
        ),
        repository:
          typeof override.repository === "string"
            ? override.repository.trim()
            : override.repository,
      }),
    );
    delete result.repositoryPathFilters;
  }

  if (Array.isArray(config.repositoryEntries)) {
    const mode =
      config.repositorySelectionMode ??
      ((
        Array.isArray(config.repos)
          ? config.repos.length
          : typeof config.repos === "string"
            ? config.repos.trim().length
            : 0
      )
        ? "selected"
        : "all");
    if (mode === "selected") {
      result.repos = config.repositoryEntries.map(
        (entry: {
          repository: string;
          originalRepository?: string;
          originalDisplayRepository?: string;
          originalOwner?: string;
        }) => {
          const name = entry.repository.trim();
          const owner =
            typeof config.owner === "string" ? config.owner.trim() : "";
          if (
            entry.originalRepository !== undefined &&
            name === entry.originalDisplayRepository &&
            owner.toLowerCase() === entry.originalOwner?.trim().toLowerCase()
          )
            return entry.originalRepository;
          return name.includes("/") || !owner ? name : `${owner}/${name}`;
        },
      );
      const freshEntries = config.repositoryEntries.filter(
        (entry: { isNew?: boolean }) => entry.isNew,
      );
      if (freshEntries.length > 0) {
        const owner =
          typeof config.owner === "string"
            ? config.owner.trim().toLowerCase()
            : "";
        const identity = (repository: string) =>
          repository.trim().toLowerCase().includes("/")
            ? repository.trim().toLowerCase()
            : `${owner}/${repository.trim().toLowerCase()}`;
        const freshNames = new Set(
          freshEntries.map((entry: { repository: string }) =>
            identity(entry.repository),
          ),
        );
        const existing = Array.isArray(result.repositoryOverrides)
          ? (result.repositoryOverrides as Record<string, unknown>[])
          : [];
        result.repositoryOverrides = [
          ...existing.filter(
            (override) =>
              typeof override.repository !== "string" ||
              !freshNames.has(identity(override.repository)),
          ),
          ...freshEntries.map(
            (entry: {
              repository: string;
              settings?: Record<string, unknown>;
            }) => {
              const standard =
                githubRepositoryStandardSettingsDraft() as Record<
                  string,
                  unknown
                >;
              return transformConfigArrayFields({
                repository: entry.repository.trim(),
                ...Object.fromEntries(
                  [...GITHUB_INHERITABLE_OVERRIDE_FIELDS].map((field) => [
                    field,
                    entry.settings?.[field] ?? standard[field],
                  ]),
                ),
              });
            },
          ),
        ];
      }
    }
  }
  const selectedMode =
    config.repositorySelectionMode === "selected" ||
    (config.repositorySelectionMode === undefined &&
      (Array.isArray(config.repos)
        ? config.repos.length > 0
        : typeof config.repos === "string" && config.repos.trim() !== ""));
  if (!selectedMode && config.repositoryApplyShared === true) {
    result.repos = [];
    result.repositoryOverrides = [];
    delete result.repositoryPathFilters;
    if (
      config.repositorySharedSettings &&
      typeof config.repositorySharedSettings === "object"
    ) {
      const shared = config.repositorySharedSettings as Record<string, unknown>;
      for (const field of GITHUB_INHERITABLE_OVERRIDE_FIELDS)
        if (shared[field] !== undefined) result[field] = shared[field];
    }
  }
  delete result.repositorySharedSettings;
  delete result.repositoryEntries;
  delete result.repositorySelectionMode;
  delete result.repositoryApplyShared;

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
