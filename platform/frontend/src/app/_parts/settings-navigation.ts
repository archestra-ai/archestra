/**
 * Settings tab hrefs in the order they are displayed.
 *
 * `useSettingsTabs` owns the rendered list (it carries labels and icons); this
 * is the same sequence with nothing but the hrefs, for callers that only need
 * to know which page comes first. `settings-navigation.test.ts` pins the two
 * together so a tab added to one cannot silently go missing from the other.
 */
export const SETTINGS_TAB_HREFS = [
  "/settings/appearance",
  "/settings/auth",
  "/settings/service-accounts",
  "/settings/oauth-clients",
  "/settings/agents",
  "/settings/messaging-channels",
  "/settings/llm",
  "/settings/mcp",
  "/settings/connection",
  "/settings/apps",
  "/settings/skills",
  "/settings/security",
  "/settings/knowledge",
  "/settings/environments",
  "/settings/users",
  "/settings/teams",
  "/settings/roles",
  "/settings/github",
  "/settings/identity-providers",
  "/settings/secrets",
] as const;

/**
 * Where the sidebar's Settings row should actually go.
 *
 * `/settings` renders nothing: it waits for permissions and then forwards to
 * the first tab the reader may see. Following it from the sidebar therefore
 * costs two route loads for one click — measured at ~180ms to reach the stub
 * and another ~300ms to leave it. Sending the row straight to the destination
 * skips the middle hop, and `/settings` stays in place for bookmarks and deep
 * links.
 *
 * Secrets is deliberately not eligible here. It is the one tab whose presence
 * depends on more than the permission map (the deployment has to be on Vault),
 * and the sidebar has no reason to fetch that on every page just to label one
 * link — so a reader whose *only* settings page is Secrets falls through to
 * the stub, which resolves it properly.
 */
export function getSettingsNavigationUrl(
  permissionMap: Partial<Record<string, boolean>> | null | undefined,
): string {
  const firstPermitted = SETTINGS_TAB_HREFS.find(
    (href) => href !== "/settings/secrets" && permissionMap?.[href] === true,
  );
  return firstPermitted ?? "/settings";
}
