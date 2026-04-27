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

export type ExternalToolCapabilitySource = "metadata" | "fallback";

export type ExternalToolSecurityMetadata = {
  capabilities: ExternalToolCapability[];
  source: ExternalToolCapabilitySource;
};

export type ExternalToolCapabilityAssessment = {
  capabilities: Set<ExternalToolCapability>;
  hasExternalCommunicationCapability: boolean;
  usedMetadata: boolean;
  usedFallback: boolean;
  fallbackToolNames: string[];
  unknownCapabilityToolNames: string[];
};

export const EXTERNAL_TOOL_SECURITY_METADATA_KEY =
  "__archestraSecurityMetadata";

type ExternalToolWithSecurityMetadata = {
  [EXTERNAL_TOOL_SECURITY_METADATA_KEY]?: ExternalToolSecurityMetadata;
};

export function attachExternalToolSecurityMetadata<T extends object>(
  tool: T,
  metadata: ExternalToolSecurityMetadata,
): T & ExternalToolWithSecurityMetadata {
  return Object.assign(tool, {
    [EXTERNAL_TOOL_SECURITY_METADATA_KEY]: metadata,
  });
}

export function buildExternalToolSecurityMetadata(params: {
  toolName: string;
  toolDefinition?: unknown;
}): ExternalToolSecurityMetadata {
  const metadataCapabilities = extractCapabilitiesFromToolMetadata(
    params.toolDefinition,
  );
  if (metadataCapabilities.length > 0) {
    return {
      capabilities: metadataCapabilities,
      source: "metadata",
    };
  }

  return {
    capabilities: [classifyToolName(params.toolName)],
    source: "fallback",
  };
}

export function hasExternalCommunicationCapability(
  tools: Iterable<[string, unknown]> | string[],
): boolean {
  return assessExternalToolCapabilities(tools)
    .hasExternalCommunicationCapability;
}

export function getExternalToolCapabilities(
  tools: Iterable<[string, unknown]> | string[],
): Set<ExternalToolCapability> {
  return assessExternalToolCapabilities(tools).capabilities;
}

export function assessExternalToolCapabilities(
  tools: Iterable<[string, unknown]> | string[],
): ExternalToolCapabilityAssessment {
  const capabilities = new Set<ExternalToolCapability>();
  const fallbackToolNames: string[] = [];
  const unknownCapabilityToolNames: string[] = [];
  let usedMetadata = false;
  let usedFallback = false;

  for (const [toolName, tool] of normalizeToolEntries(tools)) {
    if (archestraMcpBranding.isToolName(toolName)) {
      continue;
    }

    // Fall back to deterministic name classification only when explicit metadata is missing.
    const securityMetadata = getSecurityMetadata(tool) ?? {
      capabilities: [classifyToolName(toolName)],
      source: "fallback" as const,
    };

    if (securityMetadata.source === "metadata") {
      usedMetadata = true;
    } else {
      usedFallback = true;
      fallbackToolNames.push(toolName);
    }

    for (const capability of securityMetadata.capabilities) {
      capabilities.add(capability);
      if (capability === "unknown_external") {
        unknownCapabilityToolNames.push(toolName);
      }
    }
  }

  return {
    capabilities,
    // Conservative policy: any detected capability (including unknown_external) means "external-capable".
    hasExternalCommunicationCapability: capabilities.size > 0,
    usedMetadata,
    usedFallback,
    fallbackToolNames,
    unknownCapabilityToolNames,
  };
}

function normalizeToolEntries(
  tools: Iterable<[string, unknown]> | string[],
): Array<[string, unknown]> {
  if (Array.isArray(tools)) {
    return tools.map((entry) =>
      Array.isArray(entry)
        ? [String(entry[0] ?? ""), entry[1]]
        : [String(entry), undefined],
    );
  }

  return Array.from(tools);
}

function getSecurityMetadata(
  tool: unknown,
): ExternalToolSecurityMetadata | undefined {
  if (!isRecord(tool)) {
    return undefined;
  }

  const rawMetadata = tool[EXTERNAL_TOOL_SECURITY_METADATA_KEY];
  if (!isRecord(rawMetadata)) {
    return undefined;
  }

  const capabilities = normalizeCapabilities(rawMetadata.capabilities);
  if (capabilities.length === 0) {
    return undefined;
  }

  const source = rawMetadata.source === "metadata" ? "metadata" : "fallback";
  return { capabilities, source };
}

function extractCapabilitiesFromToolMetadata(
  toolDefinition: unknown,
): ExternalToolCapability[] {
  if (!isRecord(toolDefinition)) {
    return [];
  }

  const metadataCandidates = [
    toolDefinition.annotations,
    toolDefinition.meta,
    toolDefinition._meta,
    toolDefinition.security,
  ];

  for (const candidate of metadataCandidates) {
    const capabilities = extractCapabilitiesFromMetadataCandidate(candidate);
    if (capabilities.length > 0) {
      return capabilities;
    }
  }

  return [];
}

function extractCapabilitiesFromMetadataCandidate(
  candidate: unknown,
): ExternalToolCapability[] {
  if (!isRecord(candidate)) {
    return [];
  }

  const directCapabilities = normalizeCapabilities(candidate.capabilities);
  if (directCapabilities.length > 0) {
    return directCapabilities;
  }

  const aliasCapabilities = normalizeCapabilities(
    candidate.externalCapabilities,
  );
  if (aliasCapabilities.length > 0) {
    return aliasCapabilities;
  }

  const securityCapabilities = isRecord(candidate.security)
    ? normalizeCapabilities(candidate.security.capabilities)
    : [];
  if (securityCapabilities.length > 0) {
    return securityCapabilities;
  }

  const archestraCapabilities = isRecord(candidate.archestra)
    ? normalizeCapabilities(candidate.archestra.capabilities)
    : [];
  if (archestraCapabilities.length > 0) {
    return archestraCapabilities;
  }

  return [];
}

function normalizeCapabilities(value: unknown): ExternalToolCapability[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized = new Set<ExternalToolCapability>();
  for (const capability of value) {
    const mapped = normalizeCapability(capability);
    if (mapped) {
      normalized.add(mapped);
    }
  }

  return Array.from(normalized);
}

function normalizeCapability(
  capability: unknown,
): ExternalToolCapability | null {
  if (typeof capability !== "string") {
    return null;
  }

  switch (capability.trim().toLowerCase()) {
    case "web":
      return "web";
    case "browser":
      return "browser";
    case "search":
      return "search";
    case "file":
      return "file";
    case "api":
    case "network":
      return "api";
    case "mcp_fetch":
    case "mcpfetch":
      return "mcp_fetch";
    case "unknown":
    case "unknown_external":
      return "unknown_external";
    default:
      return null;
  }
}

function classifyToolName(toolName: string): ExternalToolCapability {
  const { toolName: shortName } = parseFullToolName(toolName);
  const normalized = String(shortName ?? toolName).toLowerCase();

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
