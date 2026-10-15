import { useNavPermissionMap } from "./use-settings-area-access";

/**
 * The one Credentials page each reader uses. A reader who can open Settings →
 * Credentials — the Settings area is visible to them and its Credentials page
 * permission passes — connects and adds their own credentials there, so
 * admins and editors have a single credentials view. Everyone else uses
 * Personal Settings → Credentials. Null until permissions load.
 */
export function useCredentialsPage(): {
  href: "/settings/credentials" | "/account/credentials";
} | null {
  const navPermissionMap = useNavPermissionMap();
  if (!navPermissionMap) return null;
  const canOpenSettingsCredentials =
    navPermissionMap["/settings"] === true &&
    navPermissionMap["/settings/credentials"] === true;
  return {
    href: canOpenSettingsCredentials
      ? "/settings/credentials"
      : "/account/credentials",
  };
}
