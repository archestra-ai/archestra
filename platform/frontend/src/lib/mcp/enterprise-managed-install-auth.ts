import { LINKED_IDP_SSO_MODE } from "@archestra/shared";
import type { CatalogItem } from "@/app/mcp/registry/_parts/mcp-server-card";

const PENDING_ENTERPRISE_MANAGED_INSTALL =
  "pending_enterprise_managed_mcp_install";

export type EnterpriseManagedInstallIntent =
  | {
      action: "direct";
      catalogId: string;
      scope: "personal" | "team" | "org";
      teamId?: string;
    }
  | {
      action: "open-local" | "open-remote" | "open-no-auth";
      catalogId: string;
      scope?: "personal" | "team" | "org";
      teamId?: string;
    };

export async function getEnterpriseManagedInstallConnectUrl(params: {
  catalogItem: CatalogItem;
  redirectTo: string;
}): Promise<string | null> {
  const identityProviderId =
    params.catalogItem.enterpriseManagedConfig?.identityProviderId;
  if (!identityProviderId) {
    return null;
  }

  const status = await fetchIdentityProviderLinkStatus(identityProviderId);
  if (!status || status.connected) {
    return null;
  }

  const searchParams = new URLSearchParams({
    redirectTo: params.redirectTo,
    mode: LINKED_IDP_SSO_MODE,
  });

  return `/auth/sso/${encodeURIComponent(status.providerId)}?${searchParams.toString()}`;
}

export function setPendingEnterpriseManagedInstall(
  intent: EnterpriseManagedInstallIntent,
) {
  sessionStorage.setItem(
    PENDING_ENTERPRISE_MANAGED_INSTALL,
    JSON.stringify(intent),
  );
}

export function consumePendingEnterpriseManagedInstall(): EnterpriseManagedInstallIntent | null {
  const intent = getPendingEnterpriseManagedInstall();
  clearPendingEnterpriseManagedInstall();
  return intent;
}

export function getPendingEnterpriseManagedInstall(): EnterpriseManagedInstallIntent | null {
  const raw = sessionStorage.getItem(PENDING_ENTERPRISE_MANAGED_INSTALL);
  if (!raw) {
    return null;
  }

  try {
    return parsePendingEnterpriseManagedInstall(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function clearPendingEnterpriseManagedInstall() {
  sessionStorage.removeItem(PENDING_ENTERPRISE_MANAGED_INSTALL);
}

async function fetchIdentityProviderLinkStatus(identityProviderId: string) {
  const response = await fetch(
    `/api/identity-providers/${encodeURIComponent(identityProviderId)}/link-status`,
    {
      credentials: "include",
    },
  );

  if (!response.ok) {
    return null;
  }

  const body = (await response.json()) as {
    providerId?: unknown;
    connected?: unknown;
  };
  if (typeof body.providerId !== "string") {
    return null;
  }

  return {
    providerId: body.providerId,
    connected: body.connected === true,
  };
}

function parsePendingEnterpriseManagedInstall(
  value: unknown,
): EnterpriseManagedInstallIntent | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const intent = value as Record<string, unknown>;
  if (typeof intent.catalogId !== "string") {
    return null;
  }

  if (intent.action === "direct") {
    const scope = parseScope(intent.scope);
    if (!scope) {
      return null;
    }

    return {
      action: "direct",
      catalogId: intent.catalogId,
      scope,
      ...(typeof intent.teamId === "string" ? { teamId: intent.teamId } : {}),
    };
  }

  if (
    intent.action === "open-local" ||
    intent.action === "open-remote" ||
    intent.action === "open-no-auth"
  ) {
    return {
      action: intent.action,
      catalogId: intent.catalogId,
      scope: parseScope(intent.scope),
      ...(typeof intent.teamId === "string" ? { teamId: intent.teamId } : {}),
    };
  }

  return null;
}

function parseScope(value: unknown): "personal" | "team" | "org" | undefined {
  if (value === "personal" || value === "team" || value === "org") {
    return value;
  }

  return undefined;
}
