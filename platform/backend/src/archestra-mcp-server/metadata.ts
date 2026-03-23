import { DocsPage, getDocsUrl } from "@shared";
import type { InsertInternalMcpCatalog } from "@/types";
import { archestraMcpBranding } from "./branding";

export function getArchestraMcpCatalogMetadata(): Pick<
  InsertInternalMcpCatalog,
  "name" | "description" | "docsUrl" | "serverType" | "requiresAuth" | "icon"
> {
  const isWhiteLabeled = archestraMcpBranding.identity.fullWhiteLabeling;

  return {
    name: archestraMcpBranding.catalogName,
    description: isWhiteLabeled
      ? "Built-in tools for creating and managing agents, tools, MCP servers, policies, limits, and other platform resources."
      : "Built-in Archestra tools for creating and managing agents, tools, MCP servers, policies, limits, and other platform resources.",
    docsUrl: isWhiteLabeled
      ? null
      : getDocsUrl(DocsPage.PlatformArchestraMcpServer),
    serverType: "builtin" as const,
    requiresAuth: false,
    icon: archestraMcpBranding.iconLogo,
  };
}
