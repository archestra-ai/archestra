import type {
  ResourcePermissionAction,
  ResourcePermissionGrant,
} from "@archestra/shared";

/**
 * Who a test object is shared with when a fixture creates it.
 *
 * - omitted or `"personal"`: the author only (creation always grants the
 *   author full access).
 * - `"org"`: the audience the system create path gives, through
 *   `ResourcePermissionPolicyModel.createInitial`'s organization branch —
 *   read and use for every role holding the resource's read action, plus
 *   organization-wide use where the resource allows it.
 * - `{ teams, level }`: each team, at `use` (read + use, the default) or
 *   `edit` (read + use + update). A team given as `{ id, level }` takes its
 *   own level.
 * - `{ users, preset }`: each named user, at `view`, `use` (default), `edit`
 *   or `manage`.
 *
 * @example
 *   await makeAgent({ organizationId, authorId, access: "org" });
 *   await makeSkill(org.id, { access: { teams: [team.id], level: "edit" } });
 *   await makeLlmProviderApiKey(org.id, secret.id, {
 *     access: { users: [alice.id], preset: "view" },
 *   });
 */
export type TestAccess =
  | "personal"
  | "org"
  | {
      teams: Array<string | { id: string; level: "use" | "edit" }>;
      level?: "use" | "edit";
    }
  | { users: string[]; preset?: "view" | "use" | "edit" | "manage" };

/**
 * The creation options that give an object `access`. Pass the result to a
 * model's create method: the grants are written through
 * `ResourcePermissionPolicyModel.createInitial`, the production path, never
 * by a raw insert.
 */
export function accessGrants(access: TestAccess | undefined): {
  initialPermissionGrants?: ResourcePermissionGrant[];
  publishToOrganization?: boolean;
} {
  if (access === undefined || access === "personal") {
    return { initialPermissionGrants: [] };
  }
  if (access === "org") return { publishToOrganization: true };
  if ("teams" in access) {
    const byTeam = new Map<string, "use" | "edit">();
    for (const team of access.teams) {
      if (typeof team === "string") byTeam.set(team, access.level ?? "use");
      else byTeam.set(team.id, team.level);
    }
    return {
      initialPermissionGrants: [...byTeam].map(([id, level]) => ({
        subject: { type: "team" as const, id },
        actions: level === "edit" ? ["read", "use", "update"] : ["read", "use"],
      })),
    };
  }
  const actions = USER_PRESETS[access.preset ?? "use"];
  return {
    initialPermissionGrants: [...new Set(access.users)].map((id) => ({
      subject: { type: "user" as const, id },
      actions: [...actions],
    })),
  };
}

// ===== Internal =====

const USER_PRESETS: Record<
  "view" | "use" | "edit" | "manage",
  ResourcePermissionAction[]
> = {
  view: ["read"],
  use: ["read", "use"],
  edit: ["read", "use", "update"],
  manage: ["delete", "manage-permissions", "read", "update", "use"],
};
