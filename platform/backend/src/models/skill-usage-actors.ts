import {
  isServiceAccountUserId,
  SERVICE_ACCOUNT_USER_ID_PREFIX,
} from "@/auth/utils";
import {
  type SkillUsageActorKind,
  type SkillUsageStatistics,
  UuidIdSchema,
} from "@/types";
import ServiceAccountModel from "./service-account";
import UserModel from "./user";

/**
 * Names the actors behind a skill's activation totals, for both activation
 * logs: a stored skill's (`skill_usage_events`) and an MCP-served skill's
 * (`external_mcp_skill_usage_events`). Both record a bare `user_id` with no
 * foreign key, so resolving one is the same problem in either table.
 *
 * The id is resolved against `users` or, for a synthetic
 * `service-account:<id>`, against `service_accounts` — scoped to the caller's
 * organization. Each row also carries a `kind` describing what the id
 * *addresses* rather than whether it resolved, so it stays meaningful once the
 * owning row is gone: `name === null` then means deleted, and the two axes
 * together still tell a deleted user from a deleted service account, and both
 * from an activation that carried no actor at all.
 */
export async function describeUsageActors({
  totals,
  organizationId,
}: {
  /** Activations per actor id; `null` is an activation with no signed-in user. */
  totals: Map<string | null, number>;
  organizationId: string;
}): Promise<SkillUsageStatistics["users"]> {
  const actorIds = [...totals.keys()].filter((id): id is string => id !== null);
  const [userNames, serviceAccountNames] = await Promise.all([
    UserModel.getNamesByIds(actorIds.filter((id) => !isServiceAccountUserId(id))),
    ServiceAccountModel.getNamesByIds(
      actorIds.map(serviceAccountId).filter((id): id is string => id !== null),
      organizationId,
    ),
  ]);

  return [...totals.entries()]
    .map(([userId, total]) => ({
      ...resolveActor({ userId, userNames, serviceAccountNames }),
      total,
    }))
    .sort((a, b) => b.total - a.total);
}

// === internal ===

/**
 * The `service_accounts.id` a synthetic `service-account:<id>` user id points
 * at, or null when it is not one — or when the suffix is not a uuid. The
 * column is `uuid`, so passing a malformed value to the lookup would fail the
 * whole query rather than simply miss, and the activation log is append-only
 * text that no constraint keeps well-formed.
 */
function serviceAccountId(userId: string): string | null {
  if (!isServiceAccountUserId(userId)) return null;
  const id = userId.slice(SERVICE_ACCOUNT_USER_ID_PREFIX.length);
  return UuidIdSchema.safeParse(id).success ? id : null;
}

function resolveActor({
  userId,
  userNames,
  serviceAccountNames,
}: {
  userId: string | null;
  userNames: Map<string, string>;
  serviceAccountNames: Map<string, string>;
}): { userId: string | null; name: string | null; kind: SkillUsageActorKind } {
  if (userId === null) {
    return { userId, name: null, kind: "unattributed" };
  }
  if (isServiceAccountUserId(userId)) {
    const id = serviceAccountId(userId);
    return {
      userId,
      name: (id === null ? null : serviceAccountNames.get(id)) ?? null,
      kind: "service_account",
    };
  }
  return { userId, name: userNames.get(userId) ?? null, kind: "user" };
}
