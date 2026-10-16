import { eq, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { serviceAccountIdFromUserId } from "@/auth/service-account-user-id";

/**
 * Matches rows owned by a principal on a table owned by a person (`user_id`)
 * or a service account (`service_account_id`).
 */
export function ownedBy(
  table: { userId: PgColumn; serviceAccountId: PgColumn },
  userId: string,
): SQL {
  const serviceAccountId = serviceAccountIdFromUserId(userId);
  return serviceAccountId
    ? eq(table.serviceAccountId, serviceAccountId)
    : eq(table.userId, userId);
}
