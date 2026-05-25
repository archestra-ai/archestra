import {
  type AuthRequiredAction,
  extractMcpToolError,
  MCP_CATALOG_INSTALL_QUERY_PARAM,
  MCP_CATALOG_REAUTH_QUERY_PARAM,
  MCP_CATALOG_SERVER_QUERY_PARAM,
} from "@shared";
import type { PolicyDeniedPart } from "@/components/message-thread";

export interface AuthRequiredResult {
  catalogName: string;
  actionUrl: string;
  action: AuthRequiredAction;
  providerId: string | null;
}

export interface ExpiredAuthResult {
  catalogName: string;
  reauthUrl: string;
}

export type ToolAuthState =
  | {
      kind: "policy-denied";
      policyDenied: PolicyDeniedPart;
    }
  | {
      kind: "assigned-credential-unavailable";
      catalogName: string;
      message: string;
      catalogId: string | null;
    }
  | {
      kind: "auth-required";
      catalogName: string;
      actionUrl: string;
      action: AuthRequiredAction;
      providerId: string | null;
      catalogId: string | null;
    }
  | {
      kind: "auth-expired";
      catalogName: string;
      reauthUrl: string;
      catalogId: string | null;
      serverId: string | null;
    };

export function parsePolicyDenied(text: string): PolicyDeniedPart | null {
  const policyDenied = extractMcpToolError(text);
  if (policyDenied?.type !== "policy_denied") {
    return null;
  }

  return {
    type: `tool-${policyDenied.toolName}`,
    toolCallId: "",
    state: "output-denied",
    input: policyDenied.input,
    unsafeContextActiveAtRequestStart:
      policyDenied.reasonType === "sensitive_context",
    errorText: JSON.stringify({ reason: policyDenied.reason }),
  };
}

export function parseAuthRequired(
  errorText: string,
): AuthRequiredResult | null {
  let message = errorText;
  try {
    const json = JSON.parse(errorText);
    message = json?.originalError?.message || json?.message || errorText;
  } catch {
    /* not JSON, use raw text */
  }

  if (!message.includes("Authentication required for")) return null;

  const nameMatch = message.match(/Authentication required for "([^"]+)"/);
  const urlMatch = message.match(/visit(?:\s+this\s+URL)?:\s*(https?:\/\/\S+)/);
  if (!nameMatch || !urlMatch) return null;

  const actionUrl = urlMatch[1];
  return {
    catalogName: nameMatch[1],
    actionUrl,
    action: inferAuthRequiredAction(actionUrl),
    providerId: extractProviderIdFromSsoUrl(actionUrl),
  };
}

export function parseExpiredAuth(errorText: string): ExpiredAuthResult | null {
  let message = errorText;
  try {
    const json = JSON.parse(errorText);
    message = json?.originalError?.message || json?.message || errorText;
  } catch {
    /* not JSON, use raw text */
  }

  if (
    !message.includes("Expired or invalid authentication for") &&
    !message.includes("Your credentials have expired")
  ) {
    return null;
  }

  const nameMatch = message.match(
    /Expired or invalid authentication for "([^"]+)"/,
  );
  const urlMatch = message.match(
    /(?:To\s+re-authenticate,\s*)?(?:Please\s+visit|visit)(?:\s+this\s+URL)?[:\s]+(https?:\/\/\S+)/i,
  );
  if (!urlMatch) return null;

  return { catalogName: nameMatch?.[1] ?? "", reauthUrl: urlMatch[1] };
}

export function extractCatalogIdFromInstallUrl(
  installUrl: string,
): string | null {
  try {
    const url = new URL(installUrl);
    return url.searchParams.get(MCP_CATALOG_INSTALL_QUERY_PARAM);
  } catch {
    return null;
  }
}

export function extractIdsFromReauthUrl(reauthUrl: string): {
  catalogId: string | null;
  serverId: string | null;
} {
  try {
    const url = new URL(reauthUrl);
    return {
      catalogId: url.searchParams.get(MCP_CATALOG_REAUTH_QUERY_PARAM),
      serverId: url.searchParams.get(MCP_CATALOG_SERVER_QUERY_PARAM),
    };
  } catch {
    return { catalogId: null, serverId: null };
  }
}

export function resolveToolAuthState(params: {
  errorText?: string;
  rawOutput?: unknown;
}): ToolAuthState | null {
  const structuredError = extractMcpToolError(params.rawOutput);

  if (structuredError?.type === "auth_expired") {
    return {
      kind: "auth-expired",
      catalogName: structuredError.catalogName,
      reauthUrl: structuredError.reauthUrl,
      catalogId: structuredError.catalogId,
      serverId: structuredError.serverId,
    };
  }

  if (structuredError?.type === "auth_required") {
    const actionUrl = structuredError.actionUrl ?? structuredError.installUrl;
    if (!actionUrl) {
      return null;
    }
    const action = inferAuthRequiredAction(actionUrl, structuredError.action);
    return {
      kind: "auth-required",
      catalogName: structuredError.catalogName,
      actionUrl,
      action,
      providerId:
        structuredError.providerId ?? extractProviderIdFromSsoUrl(actionUrl),
      catalogId: structuredError.catalogId,
    };
  }

  if (structuredError?.type === "assigned_credential_unavailable") {
    return {
      kind: "assigned-credential-unavailable",
      catalogName: structuredError.catalogName,
      message: structuredError.message,
      catalogId: structuredError.catalogId,
    };
  }

  if (params.errorText) {
    const policyDenied = parsePolicyDenied(params.errorText);
    if (policyDenied) {
      return {
        kind: "policy-denied",
        policyDenied,
      };
    }

    const expiredAuth = parseExpiredAuth(params.errorText);
    if (expiredAuth) {
      const ids = extractIdsFromReauthUrl(expiredAuth.reauthUrl);
      return {
        kind: "auth-expired",
        catalogName: expiredAuth.catalogName,
        reauthUrl: expiredAuth.reauthUrl,
        catalogId: ids.catalogId,
        serverId: ids.serverId,
      };
    }

    const authRequired = parseAuthRequired(params.errorText);
    if (authRequired) {
      return {
        kind: "auth-required",
        catalogName: authRequired.catalogName,
        actionUrl: authRequired.actionUrl,
        action: authRequired.action,
        providerId: authRequired.providerId,
        catalogId: extractCatalogIdFromInstallUrl(authRequired.actionUrl),
      };
    }
  }

  if (typeof params.rawOutput === "string") {
    const expiredAuth = parseExpiredAuth(params.rawOutput);
    if (expiredAuth) {
      const ids = extractIdsFromReauthUrl(expiredAuth.reauthUrl);
      return {
        kind: "auth-expired",
        catalogName: expiredAuth.catalogName,
        reauthUrl: expiredAuth.reauthUrl,
        catalogId: ids.catalogId,
        serverId: ids.serverId,
      };
    }

    const authRequired = parseAuthRequired(params.rawOutput);
    if (authRequired) {
      return {
        kind: "auth-required",
        catalogName: authRequired.catalogName,
        actionUrl: authRequired.actionUrl,
        action: authRequired.action,
        providerId: authRequired.providerId,
        catalogId: extractCatalogIdFromInstallUrl(authRequired.actionUrl),
      };
    }
  }

  return null;
}

export function resolveAssistantTextAuthState(
  text: string,
): Extract<ToolAuthState, { kind: "auth-required" | "auth-expired" }> | null {
  const authState = resolveToolAuthState({ errorText: text });
  if (
    authState?.kind === "auth-required" ||
    authState?.kind === "auth-expired"
  ) {
    return authState;
  }

  return null;
}

export function hasToolPartsWithAuthErrors(
  parts: Array<{ output?: unknown; errorText?: string }> | undefined,
): boolean {
  for (const part of parts ?? []) {
    const authState = resolveToolAuthState({
      errorText: part.errorText,
      rawOutput: part.output,
    });
    if (
      authState?.kind === "assigned-credential-unavailable" ||
      authState?.kind === "auth-required" ||
      authState?.kind === "auth-expired"
    ) {
      return true;
    }
  }

  return false;
}

function inferAuthRequiredAction(
  actionUrl: string,
  action?: AuthRequiredAction,
): AuthRequiredAction {
  if (action) {
    return action;
  }

  return extractProviderIdFromSsoUrl(actionUrl)
    ? "connect_identity_provider"
    : "install_mcp_credentials";
}

function extractProviderIdFromSsoUrl(actionUrl: string): string | null {
  try {
    const url = new URL(actionUrl);
    const parts = url.pathname.split("/");
    const ssoIndex = parts.indexOf("sso");
    const providerId = ssoIndex >= 0 ? parts[ssoIndex + 1] : null;
    return providerId ? decodeURIComponent(providerId) : null;
  } catch {
    return null;
  }
}

export function isAuthInstructionText(text: string): boolean {
  if (resolveAssistantTextAuthState(text)) {
    return true;
  }

  return (
    /(authentication|credentials|credential assignment|personal connection)/i.test(
      text,
    ) &&
    /(install=|reauth=|re-authenticate|set up your credentials|visiting this url|visit this url|agent owner|admin)/i.test(
      text,
    )
  );
}
