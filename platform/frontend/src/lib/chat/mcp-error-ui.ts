import {
  type AuthRequiredAction,
  extractMcpToolError,
  MCP_CATALOG_INSTALL_QUERY_PARAM,
  MCP_CATALOG_REAUTH_QUERY_PARAM,
  MCP_CATALOG_SERVER_QUERY_PARAM,
  type ResourceVisibilityScope,
} from "@archestra/shared";
import { DESKTOP_MCP_COPY } from "@/lib/mcp/desktop-mcp";

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
      // Which credential expired (personal / team / org) and, for team
      // credentials, the owning team's name. Absent for text-parsed errors and
      // for chat history predating the structured field, in which case the card
      // falls back to generic "Your credentials …" copy.
      credentialScope?: ResourceVisibilityScope;
      credentialTeamName?: string | null;
    };

export function parseAuthRequired(
  errorText: string,
): AuthRequiredResult | null {
  // Cheap rejection before JSON.parse: these run for every tool result on
  // every render, and a tool's output can be a large JSON document.
  if (!AUTH_REQUIRED_MARKERS.some((marker) => errorText.includes(marker))) {
    return null;
  }
  let message = errorText;
  try {
    const json = JSON.parse(errorText);
    message = json?.originalError?.message || json?.message || errorText;
  } catch {
    /* not JSON, use raw text */
  }

  // A desktop MCP server the caller has not added to their computer: the
  // same link, worded as adding it, not as credentials.
  // The older wording stays for errors saved in chat history.
  const desktopMatch = message.match(
    /"([^"]+)" is not (?:connected from your device|linked to your device|on your computer)/,
  );
  const nameMatch =
    desktopMatch ?? message.match(/Authentication required for "([^"]+)"/);
  const urlMatch = message.match(/visit(?:\s+this\s+URL)?:\s*(https?:\/\/\S+)/);
  if (!nameMatch || !urlMatch) return null;

  const actionUrl = urlMatch[1];
  return {
    catalogName: nameMatch[1],
    actionUrl,
    action: desktopMatch
      ? "add_desktop_mcp_server"
      : inferAuthRequiredAction(actionUrl),
    providerId: extractProviderIdFromSsoUrl(actionUrl),
  };
}

export function parseExpiredAuth(errorText: string): ExpiredAuthResult | null {
  // Cheap rejection before JSON.parse (see parseAuthRequired).
  if (!EXPIRED_AUTH_MARKERS.some((marker) => errorText.includes(marker))) {
    return null;
  }
  let message = errorText;
  try {
    const json = JSON.parse(errorText);
    message = json?.originalError?.message || json?.message || errorText;
  } catch {
    /* not JSON, use raw text */
  }

  if (!EXPIRED_AUTH_MARKERS.some((marker) => message.includes(marker))) {
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
      credentialScope: structuredError.credentialScope,
      credentialTeamName: structuredError.credentialTeamName,
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

export type ConnectableAuthState = Extract<
  ToolAuthState,
  { kind: "auth-required" | "auth-expired" }
>;

/**
 * Auth state of a `tools/call` result proxied for an MCP App. Reads the
 * structured `archestraError` the gateway attaches (`_meta` /
 * `structuredContent`) and falls back to parsing the result's text blocks, so
 * the host can offer a connect affordance outside the iframe even when the app
 * itself only prints the error prose. Returns only the kinds a user can act on
 * with a URL (connect / re-authenticate); everything else is null.
 */
export function resolveMcpAppToolCallAuthState(
  result: unknown,
): ConnectableAuthState | null {
  if (typeof result !== "object" || result === null) {
    return null;
  }

  const envelope = result as { isError?: unknown; content?: unknown };
  if (envelope.isError !== true) {
    return null;
  }

  const errorText = Array.isArray(envelope.content)
    ? envelope.content
        .filter(
          (block): block is { type: "text"; text: string } =>
            typeof block === "object" &&
            block !== null &&
            (block as { type?: unknown }).type === "text" &&
            typeof (block as { text?: unknown }).text === "string",
        )
        .map((block) => block.text)
        .join("\n")
    : "";

  const authState = resolveToolAuthState({
    errorText: errorText || undefined,
    rawOutput: result,
  });

  return authState?.kind === "auth-required" ||
    authState?.kind === "auth-expired"
    ? authState
    : null;
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

/**
 * An auth-required prompt the chat answers with its own install dialog, not
 * with a link: setting up credentials for a server, or adding a desktop MCP
 * server to the user's computer.
 */
export function isInstallAuthAction(action: AuthRequiredAction): boolean {
  return (
    action === "install_mcp_credentials" || action === "add_desktop_mcp_server"
  );
}

/**
 * Whether a tool call failed because the caller has no device with the MCP
 * bridge: the chat then offers to set it up. Read from the text of the
 * error, which the gateway words for the model. The older wording stays for
 * errors saved in chat history. A device that is linked but offline is not
 * this case: setting the MCP bridge up again would not help.
 */
export function isNoDeviceError(params: {
  errorText?: string;
  rawOutput?: unknown;
}): boolean {
  // A string output only: this runs for every tool part on every render.
  const texts = [
    params.errorText,
    typeof params.rawOutput === "string" ? params.rawOutput : undefined,
  ];
  return texts.some(
    (text) =>
      typeof text === "string" &&
      NO_DEVICE_MARKERS.some((marker) => text.includes(marker)),
  );
}

/**
 * The words of the card for a tool call that found no device; `linked` once
 * the user has linked one since.
 */
export function noDevicePromptCopy(params: { linked: boolean }): {
  title: string;
  description: string;
  buttonText?: string;
} {
  return params.linked
    ? {
        title: "Device linked",
        description: "Your device is linked. Try again.",
      }
    : {
        title: "No device is linked",
        description:
          "This tool runs on your device. Set up the MCP bridge there to use it.",
        buttonText: "Set up the MCP bridge",
      };
}

/**
 * The words of the card for a tool of a desktop MCP server that the user has
 * not added to their computer; `resolved` once they have.
 */
export function desktopAddPromptCopy(params: {
  catalogName: string;
  resolved: boolean;
}): { title: string; description: string; buttonText?: string } {
  const { catalogName, resolved } = params;
  return resolved
    ? {
        title: "Connected from your device",
        description: `\u201c${catalogName}\u201d is connected from your device. Try again once it is ready.`,
      }
    : {
        title: DESKTOP_MCP_COPY.notAdded,
        description: `\u201c${catalogName}\u201d runs on your linked device. Connect it to use this tool.`,
        buttonText: "Connect from my device",
      };
}

/**
 * An "Authentication Required" install prompt is resolved once a server for its
 * catalog has been connected — at that point the card should read as connected
 * rather than as an outstanding error. Scoped deliberately to the install cases
 * (`install_mcp_credentials`, and a desktop MCP server to add to the user's
 * computer): identity-provider connect, expired/re-auth, and
 * assigned-credential-unavailable cards are NOT covered, since "a server exists"
 * is not a valid resolution signal for those.
 */
export function isInstallAuthResolved(params: {
  authState: ToolAuthState | null;
  connectedCatalogIds: ReadonlySet<string>;
}): boolean {
  const { authState, connectedCatalogIds } = params;
  return (
    authState?.kind === "auth-required" &&
    isInstallAuthAction(authState.action) &&
    authState.catalogId !== null &&
    connectedCatalogIds.has(authState.catalogId)
  );
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

const NO_DEVICE_MARKERS = ["No device is linked", "No device is connected"];

const AUTH_REQUIRED_MARKERS = [
  "Authentication required for",
  "is not connected from your device",
  // The words of earlier versions, in chats from before.
  "is not linked to your device",
  "is not on your computer",
];
const EXPIRED_AUTH_MARKERS = [
  "Expired or invalid authentication for",
  "Your credentials have expired",
];
