import type { Permissions, ScopedPermission } from "@archestra/shared";
import {
  predefinedPermissionsMap,
  requiredPagePermissionsMap,
} from "@archestra/shared/access-control";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSettingsTabs } from "@/app/settings/settings-tabs";
import { hasPagePermissions } from "@/lib/auth/auth.utils";
import {
  canSeeSettingsArea,
  getSettingsNavigationUrl,
  needsOrganizationCredentials,
  SETTINGS_MANAGE_PERMISSIONS,
  SETTINGS_TAB_HREFS,
  settingsAreaFallbackUrl,
} from "./settings-navigation";

const allPermitted = Object.fromEntries(
  SETTINGS_TAB_HREFS.map((href) => [href, true]),
);

vi.mock("@/lib/auth/auth.query", () => ({
  usePermissionMap: () =>
    Object.fromEntries(
      [
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
      ].map((href) => [href, true]),
    ),
}));

vi.mock("@/lib/secrets.query", () => ({
  useSecretsType: () => ({ data: { type: "Vault" } }),
}));

let openappaEnabled = true;
vi.mock("@/lib/config/config.query", () => ({
  useFeature: (feature: string) =>
    feature === "openappaEnabled" ? openappaEnabled : true,
}));

describe("settings navigation", () => {
  // The Guardrails tab only renders while OpenAPPA is on; either way the rest
  // of the order must match.
  it.each([
    { openappa: true, hidden: null },
    { openappa: false, hidden: "/settings/guardrails" },
  ])("lists the same tabs, in the same order, as the settings page renders (openappa=%j)", ({
    openappa,
    hidden,
  }) => {
    openappaEnabled = openappa;
    const { result } = renderHook(() => useSettingsTabs());

    // The sidebar picks the first entry of this list; if a tab is added to
    // the rendered tabs but not here, the sidebar would skip past it and open
    // a page further down than the one the user actually lands on via
    // /settings.
    expect(result.current.map((tab) => tab.href)).toEqual(
      SETTINGS_TAB_HREFS.filter((href) => href !== hidden),
    );
  });

  it("sends the sidebar to the first tab the reader may open", () => {
    expect(getSettingsNavigationUrl(allPermitted)).toBe("/settings/appearance");

    expect(
      getSettingsNavigationUrl({
        "/settings/appearance": false,
        "/settings/auth": false,
        "/settings/llm": true,
      }),
    ).toBe("/settings/llm");
  });

  it("falls back to the stub when it cannot decide", () => {
    // Nothing readable yet: permissions are still loading.
    expect(getSettingsNavigationUrl(undefined)).toBe("/settings");

    // Secrets is the one tab that needs more than the permission map, so a
    // reader with only that one goes through the stub, which resolves it.
    expect(getSettingsNavigationUrl({ "/settings/secrets": true })).toBe(
      "/settings",
    );
  });
});

describe("canSeeSettingsArea", () => {
  const organizationId = "org-1";
  const credentialId = "00000000-0000-4000-8000-000000000001";
  const serviceAccountId = "00000000-0000-4000-8000-000000000002";
  const organizationCredentialId = "00000000-0000-4000-8000-000000000003";
  const personalCredentialId = "00000000-0000-4000-8000-000000000004";
  // The credentials the reader sees that the organization provides.
  const organizationCredentialIds = new Set([
    credentialId,
    organizationCredentialId,
  ]);
  // Can update on one credential; Full access adds delete and sharing.
  const canEdit = (scope: string): ScopedPermission[] =>
    (["read", "use", "update"] as const).map((action) => ({
      organizationId,
      resource: "credential",
      scope,
      action,
    }));
  const fullAccess = (scope: string): ScopedPermission[] => [
    ...canEdit(scope),
    ...(["delete", "manage-permissions"] as const).map((action) => ({
      organizationId,
      resource: "credential" as const,
      scope,
      action,
    })),
  ];
  // What every member holds on a credential shared with the organization.
  const sharedCredential: ScopedPermission[] = (["read", "use"] as const).map(
    (action) => ({
      organizationId,
      resource: "credential",
      scope: credentialId,
      action,
    }),
  );

  function permissionMapFor(
    userPermissions: Permissions,
    capabilities: ScopedPermission[],
  ) {
    return Object.fromEntries(
      Object.entries({
        ...requiredPagePermissionsMap,
        ...SETTINGS_MANAGE_PERMISSIONS,
      }).map(([key, required]) => [
        key,
        hasPagePermissions({ userPermissions, required, capabilities }),
      ]),
    );
  }

  function canSee(
    userPermissions: Permissions,
    capabilities: ScopedPermission[] = [],
  ) {
    return canSeeSettingsArea({
      permissionMap: permissionMapFor(userPermissions, capabilities),
      capabilities,
      organizationCredentialIds,
    });
  }

  it("hides Settings from the member baseline", () => {
    // Members can read Teams, Credentials and OAuth Clients, but have nothing
    // to manage there.
    expect(canSee(predefinedPermissionsMap.member, sharedCredential)).toBe(
      false,
    );
  });

  it("shows Settings to editors and admins", () => {
    expect(canSee(predefinedPermissionsMap.editor, sharedCredential)).toBe(
      true,
    );
    expect(canSee(predefinedPermissionsMap.admin)).toBe(true);
  });

  it("shows Settings to a member granted a service account", () => {
    expect(
      canSee(predefinedPermissionsMap.member, [
        ...sharedCredential,
        {
          organizationId,
          resource: "serviceAccount",
          scope: serviceAccountId,
          action: "read",
        },
      ]),
    ).toBe(true);
  });

  it("keeps Settings hidden from a member who added their own credential", () => {
    // Its author holds Full access, but it takes a personal value, so it is
    // managed in Personal Settings.
    expect(
      canSee(predefinedPermissionsMap.member, [
        ...sharedCredential,
        ...fullAccess(personalCredentialId),
      ]),
    ).toBe(false);
  });

  it("keeps Settings hidden for Can update on someone else's personal credential", () => {
    expect(
      canSee(predefinedPermissionsMap.member, [
        ...sharedCredential,
        ...canEdit(personalCredentialId),
      ]),
    ).toBe(false);
  });

  it("shows Settings to a member who can edit an organization credential", () => {
    expect(
      canSee(predefinedPermissionsMap.member, [
        ...sharedCredential,
        ...canEdit(organizationCredentialId),
      ]),
    ).toBe(true);
  });

  it("shows Settings to a member who can update one OAuth client", () => {
    expect(
      canSee(predefinedPermissionsMap.member, [
        ...sharedCredential,
        {
          organizationId,
          resource: "oauthClient",
          scope: "00000000-0000-4000-8000-000000000005",
          action: "update",
        },
      ]),
    ).toBe(true);
  });

  it("counts managing every credential as managing the tab", () => {
    expect(
      canSeeSettingsArea({
        permissionMap: permissionMapFor(predefinedPermissionsMap.member, []),
        capabilities: canEdit("*"),
      }),
    ).toBe(true);
  });

  it("fetches credentials only when a grant on one could open Settings", () => {
    const needs = (
      userPermissions: Permissions,
      capabilities: ScopedPermission[],
    ) =>
      needsOrganizationCredentials({
        permissionMap: permissionMapFor(userPermissions, capabilities),
        capabilities,
      });
    const member = predefinedPermissionsMap.member;
    expect(needs(member, sharedCredential)).toBe(false);
    expect(needs(member, canEdit(personalCredentialId))).toBe(true);
    // Already in Settings through the role.
    expect(
      needs(predefinedPermissionsMap.editor, canEdit(personalCredentialId)),
    ).toBe(false);
  });

  it("counts a role that may create teams, credentials or OAuth clients", () => {
    const member = predefinedPermissionsMap.member;
    expect(canSee({ ...member, team: ["read", "create"] })).toBe(true);
    expect(canSee({ ...member, credential: ["read", "delete"] })).toBe(true);
    expect(canSee({ ...member, oauthClient: ["read", "create"] })).toBe(true);
  });

  it("does not count managing a tab the reader cannot open", () => {
    expect(
      canSee({ ...predefinedPermissionsMap.member, credential: ["create"] }),
    ).toBe(false);
  });

  it("sends a reader without Settings to the matching personal page", () => {
    expect(settingsAreaFallbackUrl("/settings/credentials")).toBe(
      "/account/credentials",
    );
    expect(settingsAreaFallbackUrl("/settings/teams")).toBe("/account");
    expect(settingsAreaFallbackUrl("/settings")).toBe("/account");
  });
});
