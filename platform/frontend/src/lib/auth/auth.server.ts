import { archestraApiSdk, type Permissions } from "@archestra/shared";
import { requiredPagePermissionsMap } from "@archestra/shared/access-control";
import { hasPermissions } from "@/lib/auth/auth.utils";
import { getServerApiHeaders } from "@/lib/utils/server";

export async function serverCanAccessPage(pathname: string): Promise<boolean> {
  return serverHasPermissions(requiredPagePermissionsMap[pathname] ?? {});
}

export async function serverHasPermissions(
  permissionsToCheck: Permissions,
): Promise<boolean> {
  const headers = await getServerApiHeaders();
  const {
    data: userPermissions,
    error,
    response,
  } = await archestraApiSdk.getUserPermissions({ headers });

  // The SDK is configured with `throwOnError: false`, so a transport failure
  // comes back as an error with no response rather than as a thrown exception.
  // Treating that as "no permissions" renders a 403 for what is really a
  // backend or network fault — misleading to the user, and invisible in logs
  // because nothing was thrown. Faults propagate instead, so the caller's
  // error boundary reports them. A 4xx is a real authorization answer and
  // falls through to the check below.
  if (
    error !== undefined &&
    (response === undefined || response.status >= 500)
  ) {
    throw new Error(
      `Permission lookup failed: ${response === undefined ? "no response" : `status ${response.status}`}`,
      { cause: error },
    );
  }

  return hasPermissions(userPermissions ?? undefined, permissionsToCheck);
}
