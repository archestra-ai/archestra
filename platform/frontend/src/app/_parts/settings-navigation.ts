import type { Permissions, ScopedPermission } from "@archestra/shared";

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
  "/settings/guardrails",
  "/settings/messaging-channels",
  "/settings/llm",
  "/settings/mcp",
  "/settings/connection",
  "/settings/apps",
  "/settings/skills",
  "/settings/knowledge",
  "/settings/environments",
  "/settings/users",
  "/settings/teams",
  "/settings/roles",
  "/settings/credentials",
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

/**
 * Whether the reader may see the Settings area at all — the sidebar row, the
 * palette entry, and every `/settings/*` route.
 *
 * Teams, Credentials and OAuth Clients open on read access that the member
 * baseline holds for the API, and the one thing a member needs from them —
 * their own credentials — lives in Personal Settings. So those three count
 * only for a reader who can manage them: create, update or delete on the
 * resource, or a Can update or Full access grant on every object of it (`*`).
 * A grant on one object counts for Teams and OAuth Clients, and for
 * Credentials only on an organization credential: credentials that take a
 * personal value, your own included, belong on the reader's credentials page
 * (`useCredentialsPage`) and never open Settings by themselves. Any other
 * permitted tab is enough on its own. Gated on permissions, never on role
 * names, so custom roles resolve the same way.
 */
export function canSeeSettingsArea(params: {
  /** Results for `requiredPagePermissionsMap` and {@link SETTINGS_MANAGE_PERMISSIONS}. */
  permissionMap: Partial<Record<string, boolean>>;
  capabilities: readonly ScopedPermission[];
  /**
   * Ids of the organization credentials the reader can see. Needed only when
   * {@link needsOrganizationCredentials} says so; without it, a grant on one
   * credential opens nothing.
   */
  organizationCredentialIds?: ReadonlySet<string>;
}): boolean {
  const { permissionMap, capabilities, organizationCredentialIds } = params;
  return SETTINGS_TAB_HREFS.some((href) => {
    if (permissionMap[href] !== true) return false;
    const resources = MANAGED_ONLY_TABS[href];
    if (!resources) return true;
    return resources.some(
      (resource) =>
        ROLE_MANAGE_ACTIONS.some(
          (action) => permissionMap[`${resource}:${action}`] === true,
        ) ||
        capabilities.some(
          (grant) =>
            isManageGrant(grant, resource) &&
            (grant.scope === "*" ||
              resource !== "credential" ||
              organizationCredentialIds?.has(grant.scope) === true),
        ),
    );
  });
}

/**
 * Whether {@link canSeeSettingsArea} turns on which credentials are the
 * organization's: the reader manages some credential through a grant on it,
 * and nothing else already opens Settings. Only then is the credential list
 * worth fetching.
 */
export function needsOrganizationCredentials(params: {
  permissionMap: Partial<Record<string, boolean>>;
  capabilities: readonly ScopedPermission[];
}): boolean {
  return (
    params.permissionMap["/settings/credentials"] === true &&
    params.capabilities.some(
      (grant) => grant.scope !== "*" && isManageGrant(grant, "credential"),
    ) &&
    // Without organization credential ids, no single credential grant
    // counts: this asks whether anything else already opens Settings.
    !canSeeSettingsArea(params)
  );
}

/**
 * The role permissions {@link canSeeSettingsArea} reads, keyed
 * `resource:action`, in the shape `usePermissionMap` takes: managing a
 * resource of one of the tabs the member baseline can only read.
 */
export const SETTINGS_MANAGE_PERMISSIONS = {
  "team:create": { team: ["create"] },
  "team:update": { team: ["update"] },
  "team:delete": { team: ["delete"] },
  "credential:create": { credential: ["create"] },
  "credential:update": { credential: ["update"] },
  "credential:delete": { credential: ["delete"] },
  "oauthClient:create": { oauthClient: ["create"] },
  "oauthClient:update": { oauthClient: ["update"] },
  "oauthClient:delete": { oauthClient: ["delete"] },
} satisfies Record<string, Permissions>;

/**
 * Where a reader without the Settings area lands when they open a
 * `/settings/*` URL: their own credentials for the Credentials page, and
 * Personal Settings for anything else.
 */
export function settingsAreaFallbackUrl(pathname: string): string {
  return pathname === "/settings/credentials" ||
    pathname.startsWith("/settings/credentials/")
    ? "/account/credentials"
    : "/account";
}

export function isSettingsAreaPath(pathname: string): boolean {
  return pathname === "/settings" || pathname.startsWith("/settings/");
}

// === Internal helpers

/** Settings tabs the member baseline can read, and the resources they manage. */
const MANAGED_ONLY_TABS: Partial<
  Record<(typeof SETTINGS_TAB_HREFS)[number], (keyof Permissions)[]>
> = {
  "/settings/teams": ["team"],
  "/settings/credentials": ["credential"],
  // One resource governs LLM proxy and MCP clients alike.
  "/settings/oauth-clients": ["oauthClient"],
};

const ROLE_MANAGE_ACTIONS = ["create", "update", "delete"] as const;

function isManageGrant(
  grant: ScopedPermission,
  resource: keyof Permissions,
): boolean {
  return (
    grant.resource === resource && OBJECT_MANAGE_ACTIONS.includes(grant.action)
  );
}

/** Actions that only the Can update and Full access presets carry. */
const OBJECT_MANAGE_ACTIONS: readonly ScopedPermission["action"][] = [
  "update",
  "delete",
  "manage-permissions",
];
