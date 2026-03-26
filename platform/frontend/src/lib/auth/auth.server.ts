import { archestraApiSdk, type Permissions } from "@shared";
import { requiredPagePermissionsMap } from "@shared/access-control";
import { hasPermissions } from "@/lib/auth/auth.utils";
import { getServerApiHeaders } from "@/lib/utils/server";

export async function serverCanAccessPage(pathname: string): Promise<boolean> {
  return serverHasPermissions(requiredPagePermissionsMap[pathname] ?? {});
}

export async function serverHasPermissions(
  permissionsToCheck: Permissions,
): Promise<boolean> {
  const headers = await getServerApiHeaders();
  const { data: userPermissions } = await archestraApiSdk.getUserPermissions({
    headers,
  });

  return hasPermissions(userPermissions ?? undefined, permissionsToCheck);
}
