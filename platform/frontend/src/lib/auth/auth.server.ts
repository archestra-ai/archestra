import { archestraApiSdk, type Permissions } from "@archestra/shared";
import { requiredPagePermissionsMap } from "@archestra/shared/access-control";
import { hasPagePermissions, hasPermissions } from "@/lib/auth/auth.utils";
import { getServerApiHeaders } from "@/lib/utils/server";

export async function serverCanAccessPage(pathname: string): Promise<boolean> {
  const required = requiredPagePermissionsMap[pathname] ?? {};
  const userPermissions = await getServerPermissions();
  if (hasPermissions(userPermissions, required)) return true;
  // This is a navigation fallback only. Each API operation retains its own
  // resource authorization, including list filtering and exact-object checks.
  const headers = await getServerApiHeaders();
  const { data, error, response } = await archestraApiSdk.getScopedCapabilities(
    { headers },
  );
  if (error && (!response || response.status >= 500))
    throw new Error("Scoped permission lookup failed", { cause: error });
  return hasPagePermissions({
    userPermissions,
    required,
    capabilities: data ?? [],
  });
}

export async function serverHasPermissions(
  permissionsToCheck: Permissions,
): Promise<boolean> {
  return hasPermissions(await getServerPermissions(), permissionsToCheck);
}

async function getServerPermissions(): Promise<Permissions | undefined> {
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

  return userPermissions ?? undefined;
}
