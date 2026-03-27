/** Convert comma-separated string fields to arrays before sending to the API. */
export function transformConfigArrayFields(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...config };

  // String array fields: split by comma, trim, filter empty
  const stringArrayFields = [
    "repos",
    "spaceKeys",
    "pageIds",
    "labelsToSkip",
    "commentEmailBlacklist",
    "states",
    "assignmentGroups",
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

  // Number array fields: split, trim, parse, filter NaN
  if (typeof result.projectIds === "string") {
    const value = result.projectIds as string;
    result.projectIds = value
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => !Number.isNaN(n));
  }

  return result;
}
