import { z } from "zod";

/**
 * Access level a scoped team holds on a team-scoped catalog item.
 *
 * `use` — discover the item, install it for oneself, resolve tool calls through
 * its shared installs. `write` — everything `use` allows plus modifying the
 * definition; exercisable only by the team's admins.
 */
export const CatalogTeamAccessLevelSchema = z.enum(["use", "write"]);

export type CatalogTeamAccessLevel = z.infer<
  typeof CatalogTeamAccessLevelSchema
>;

/**
 * The level an assignment takes when none is given — on the wire, and as the
 * column default that backfills rows predating per-team levels. `write` keeps
 * a team the capability it had before levels existed.
 */
export const DEFAULT_CATALOG_TEAM_ACCESS_LEVEL: CatalogTeamAccessLevel =
  "write";

/** A team assignment on a catalog item; `level` unset means "keep what is stored". */
export interface CatalogTeamAssignment {
  id: string;
  level?: CatalogTeamAccessLevel;
}

/** Accepted on the wire: a bare team id, or an id with an explicit level. */
export type CatalogTeamInput = string | CatalogTeamAssignment;

export const CatalogTeamInputSchema = z.union([
  z.string().min(1),
  z.object({
    id: z.string().min(1),
    level: CatalogTeamAccessLevelSchema.optional(),
  }),
]);

/**
 * Collapse the wire shape to assignments, last entry winning for a repeated id.
 * A bare id yields no level, which {@link McpCatalogTeamModel.syncCatalogTeams}
 * reads as "preserve the stored level" — so id-only callers never escalate a
 * `use` team back to `write`.
 */
export function normalizeCatalogTeamInput(
  teams: CatalogTeamInput[],
): CatalogTeamAssignment[] {
  const byId = new Map<string, CatalogTeamAssignment>();
  for (const entry of teams) {
    const assignment =
      typeof entry === "string"
        ? { id: entry }
        : { id: entry.id, level: entry.level };
    byId.set(assignment.id, assignment);
  }
  return [...byId.values()];
}
