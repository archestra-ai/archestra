import { z } from "zod";
import { CatalogTeamAccessLevelSchema } from "./catalog-team-level";

/**
 * Access level an individually-named user holds on a user-scoped catalog item.
 * Same two-level domain as a team grant — see {@link CatalogTeamAccessLevelSchema}.
 */
export const CatalogUserAccessLevelSchema = CatalogTeamAccessLevelSchema;

export type CatalogUserAccessLevel = z.infer<
  typeof CatalogUserAccessLevelSchema
>;

/**
 * The level a per-user assignment takes when none is given. Unlike team grants —
 * which default to `write` to preserve what teams held before levels existed —
 * this is a new grant type with no history to keep, so it starts at least
 * privilege: sharing an app with someone lets them run it, not rewrite it.
 */
export const DEFAULT_CATALOG_USER_ACCESS_LEVEL: CatalogUserAccessLevel = "use";

/** A user assignment on a catalog item; `level` unset means "keep what is stored". */
export interface CatalogUserAssignment {
  id: string;
  level?: CatalogUserAccessLevel;
}

/** Accepted on the wire: a bare user id, or an id with an explicit level. */
export type CatalogUserInput = string | CatalogUserAssignment;

export const CatalogUserInputSchema = z.union([
  z.string().min(1),
  z.object({
    id: z.string().min(1),
    level: CatalogUserAccessLevelSchema.optional(),
  }),
]);

/**
 * Collapse the wire shape to assignments, last entry winning for a repeated id.
 * Mirrors `normalizeCatalogTeamInput`: a bare id yields no level, which the sync
 * reads as "preserve the stored level", so id-only callers never escalate a
 * `use` grant to `write`.
 */
export function normalizeCatalogUserInput(
  users: CatalogUserInput[],
): CatalogUserAssignment[] {
  const byId = new Map<string, CatalogUserAssignment>();
  for (const entry of users) {
    const assignment =
      typeof entry === "string"
        ? { id: entry }
        : { id: entry.id, level: entry.level };
    byId.set(assignment.id, assignment);
  }
  return [...byId.values()];
}
