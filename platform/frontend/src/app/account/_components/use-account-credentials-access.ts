import { useCredentialsPage } from "@/app/_parts/use-credentials-page";
import { useHasPermissions } from "@/lib/auth/auth.query";

/**
 * What Personal Settings → Credentials can show the reader. A reader who can
 * open Settings → Credentials uses that page instead ({@link
 * useCredentialsPage}), so they get no tab here and are sent there. For
 * everyone else the credentials table needs `credential:read`. `hasTab` is
 * false when that does not apply, null until known; `redirectTo` is where the
 * tab's address sends a reader who has no tab.
 */
export function useAccountCredentialsAccess(): {
  canReadCredentials: boolean | undefined;
  hasTab: boolean | null;
  redirectTo: "/settings/credentials" | "/account" | null;
} {
  const credentialsPage = useCredentialsPage();
  const { data: canReadCredentials } = useHasPermissions({
    credential: ["read"],
  });
  const unknown = { canReadCredentials, hasTab: null, redirectTo: null };
  if (!credentialsPage) return unknown;
  if (credentialsPage.href === "/settings/credentials")
    return {
      canReadCredentials,
      hasTab: false,
      redirectTo: "/settings/credentials",
    };
  if (canReadCredentials === true)
    return { canReadCredentials, hasTab: true, redirectTo: null };
  if (canReadCredentials === undefined) return unknown;
  return { canReadCredentials, hasTab: false, redirectTo: "/account" };
}
