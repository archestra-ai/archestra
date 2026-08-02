import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import OrganizationRoleModel from "@/models/organization-role";

/**
 * better-auth's admin plugin gates impersonation on the system-level
 * `user.role` column, which historically only the seeded bootstrap admin ever
 * received — so members promoted to an org role carrying `member:impersonate`
 * (the org-level source of truth) were still rejected. This module keeps the
 * two in lockstep: `user.role = "admin"` exactly when the member's org role
 * grants `member:impersonate`.
 *
 * Every path that changes what role a member effectively has must resync:
 * member create/role-update (MemberModel), better-auth's own adapter writes
 * (update-member-role / accept-invitation / remove-member after-hooks), and
 * custom-role permission edits (which resync every holder of the role).
 *
 * The remaining better-auth `/admin/*` endpoints this column unlocks are
 * gated on org RBAC in the auth before-hook, so holding the synced system
 * role grants nothing beyond what the member's org permissions already allow.
 */
export async function syncSystemRoleWithOrgPermissions(
  userId: string,
  organizationId: string,
): Promise<void> {
  const [member] = await db
    .select({ role: schema.membersTable.role })
    .from(schema.membersTable)
    .where(
      and(
        eq(schema.membersTable.userId, userId),
        eq(schema.membersTable.organizationId, organizationId),
      ),
    )
    .limit(1);

  const permissions = member
    ? await OrganizationRoleModel.getPermissions(member.role, organizationId)
    : {};
  const shouldHoldSystemAdmin =
    permissions.member?.includes("impersonate") ?? false;

  const [user] = await db
    .select({ role: schema.usersTable.role })
    .from(schema.usersTable)
    .where(eq(schema.usersTable.id, userId))
    .limit(1);
  if (!user) {
    return;
  }

  const holdsSystemAdmin = user.role === "admin";
  if (shouldHoldSystemAdmin === holdsSystemAdmin) {
    return;
  }

  await db
    .update(schema.usersTable)
    .set({ role: shouldHoldSystemAdmin ? "admin" : null })
    .where(eq(schema.usersTable.id, userId));
  logger.info(
    { userId, organizationId, systemAdmin: shouldHoldSystemAdmin },
    "[auth] synced system-level user.role with org member:impersonate grant",
  );
}

/**
 * Resync every member holding the given org role — for custom-role
 * permission edits, where the role's grant of `member:impersonate` may have
 * just appeared or disappeared.
 */
export async function syncSystemRoleForRoleHolders(
  roleIdentifier: string,
  organizationId: string,
): Promise<void> {
  const holders = await db
    .select({ userId: schema.membersTable.userId })
    .from(schema.membersTable)
    .where(
      and(
        eq(schema.membersTable.organizationId, organizationId),
        eq(schema.membersTable.role, roleIdentifier),
      ),
    );
  for (const holder of holders) {
    await syncSystemRoleWithOrgPermissions(holder.userId, organizationId);
  }
}
