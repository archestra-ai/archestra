import {
  extractMcpToolError,
  MCP_CATALOG_INSTALL_QUERY_PARAM,
  MCP_CATALOG_REAUTH_QUERY_PARAM,
  MCP_CATALOG_SERVER_QUERY_PARAM,
} from "@shared";
import type { PolicyDeniedPart } from "@/components/message-thread";

export interface AuthRequiredResult {
  catalogName: string;
  installUrl: string;
}

export interface ExpiredAuthResult {
  catalogName: string;
  reauthUrl: string;
}

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

  return { catalogName: nameMatch[1], installUrl: urlMatch[1] };
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
