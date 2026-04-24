import { parseFullToolName } from "@shared";
import { archestraMcpBranding } from "@/archestra-mcp-server";

export type ExternalToolCapability =
  | "web"
  | "browser"
  | "search"
  | "file"
  | "api"
  | "mcp_fetch"
  | "unknown_external";

export function hasExternalCommunicationCapability(
  toolNames: string[],
): boolean {
  return getExternalToolCapabilities(toolNames).size > 0;
}

export function getExternalToolCapabilities(
  toolNames: string[],
): Set<ExternalToolCapability> {
  const capabilities = new Set<ExternalToolCapability>();

  for (const toolName of toolNames) {
    if (archestraMcpBranding.isToolName(toolName)) {
      continue;
    }

    const classification = classifyToolName(toolName);
    capabilities.add(classification);
  }

  return capabilities;
}

function classifyToolName(toolName: string): ExternalToolCapability {
  const { toolName: shortName } = parseFullToolName(toolName);
  const normalized = shortName.toLowerCase();

  if (containsAny(normalized, ["browser", "navigate", "screenshot"])) {
    return "browser";
  }
  if (containsAny(normalized, ["web", "http", "url", "scrape"])) {
    return "web";
  }
  if (containsAny(normalized, ["search", "query", "lookup"])) {
    return "search";
  }
  if (
    containsAny(normalized, ["file", "read", "write", "upload", "download"])
  ) {
    return "file";
  }
  if (containsAny(normalized, ["api", "request", "fetch", "endpoint"])) {
    return "api";
  }
  if (containsAny(normalized, ["mcp_fetch", "mcpfetch"])) {
    return "mcp_fetch";
  }

  return "unknown_external";
}

function containsAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}
