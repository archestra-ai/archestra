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
    "userIds",
    "projectGids",
    "tagsToSkip",
    "objects",
    "collectionIds",
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

  return result;
}
