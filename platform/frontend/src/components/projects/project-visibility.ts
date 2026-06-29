// A project's share visibility, as returned on each project list item. `null`
// means the project is personal (unshared, owner-only) — the API types it as
// non-nullable, but the value is null at runtime for personal projects.
export type ProjectVisibility = "organization" | "team" | null;

export type ProjectScope = "personal" | "team" | "org";

/**
 * Maps a project's share visibility to the scope language shared across the app
 * (personal / team / org) and the label shown on its visibility pill. Team
 * names are only known to the project's owner, so they're folded into the label
 * when present and fall back to a bare "Team" otherwise.
 */
export function describeProjectVisibility(
  visibility: ProjectVisibility,
  teamNames?: string[] | null,
): { scope: ProjectScope; label: string } {
  if (visibility === "organization") {
    return { scope: "org", label: "Organization" };
  }
  if (visibility === "team") {
    const names = teamNames?.filter(Boolean) ?? [];
    return {
      scope: "team",
      label: names.length > 0 ? `Team: ${names.join(", ")}` : "Team",
    };
  }
  return { scope: "personal", label: "Personal" };
}
