import { z } from "zod";

/**
 * Access level an individually-named user holds on a resource shared with them.
 *
 * `use` — reach the resource and work with it as its scope otherwise allows.
 * `write` — everything `use` allows plus modifying the definition.
 *
 * The same two-level domain the team junctions use, so a per-user grant and a
 * per-team grant mean the same thing wherever both appear.
 */
export const ResourceUserAccessLevelSchema = z.enum(["use", "write"]);

export type ResourceUserAccessLevel = z.infer<
  typeof ResourceUserAccessLevelSchema
>;

/**
 * The level a per-user assignment takes when none is given. Unlike team grants —
 * which default to `write` to preserve what teams held before levels existed —
 * per-user sharing is new everywhere it appears, so it has no history to keep
 * and starts at least privilege: sharing something lets someone use it, not
 * rewrite it.
 */
export const DEFAULT_RESOURCE_USER_ACCESS_LEVEL: ResourceUserAccessLevel =
  "use";

/** A user assignment on a resource; `level` unset means "keep what is stored". */
export interface ResourceUserAssignment {
  id: string;
  level?: ResourceUserAccessLevel;
}

/** Accepted on the wire: a bare user id, or an id with an explicit level. */
export type ResourceUserInput = string | ResourceUserAssignment;

export const ResourceUserInputSchema = z.union([
  z.string().min(1),
  z.object({
    id: z.string().min(1),
    level: ResourceUserAccessLevelSchema.optional(),
  }),
]);

/**
 * Collapse the wire shape to assignments, last entry winning for a repeated id.
 * A bare id yields no level, which the sync reads as "preserve the stored
 * level", so id-only callers never escalate a `use` grant to `write`.
 */
export function normalizeResourceUserInput(
  users: ResourceUserInput[],
): ResourceUserAssignment[] {
  const byId = new Map<string, ResourceUserAssignment>();
  for (const entry of users) {
    const assignment =
      typeof entry === "string"
        ? { id: entry }
        : { id: entry.id, level: entry.level };
    byId.set(assignment.id, assignment);
  }
  return [...byId.values()];
}
