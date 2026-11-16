import { userHasPermission } from "@/auth/utils";
import config from "@/config";

export type TunerAccess = "read" | "update";

/**
 * Tuners read organization-wide logs, so every tuner action needs the tuner
 * permission AND `log:admin`, checked against the database each time.
 */
export async function hasTunerAccess(params: {
  userId: string;
  organizationId: string;
  access: TunerAccess;
}): Promise<boolean> {
  if (!config.tuners.enabled) return false;
  const [tuner, logAdmin] = await Promise.all([
    userHasPermission(
      params.userId,
      params.organizationId,
      "tuner",
      params.access,
    ),
    userHasPermission(params.userId, params.organizationId, "log", "admin"),
  ]);
  return tuner && logAdmin;
}
