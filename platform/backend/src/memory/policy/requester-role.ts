export type MemoryRequesterRole = "admin" | "team-admin" | "member";

export function normalizeMemoryRequesterRole(
  role: string | null | undefined,
): MemoryRequesterRole {
  const normalizedRole = role?.trim().toLowerCase();

  if (normalizedRole === "admin") {
    return "admin";
  }

  if (
    normalizedRole === "team-admin" ||
    normalizedRole === "team_admin" ||
    normalizedRole === "team admin" ||
    normalizedRole === "editor"
  ) {
    return "team-admin";
  }

  return "member";
}
