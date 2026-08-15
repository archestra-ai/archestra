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

/** Convert comma-separated string fields to arrays before sending to the API. */
export function transformConfigArrayFields(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...config };

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
