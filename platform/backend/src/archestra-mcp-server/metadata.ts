import { DocsPage, getDocsUrl } from "@archestra/shared";
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
      ? "Built-in tools, including the api tool for managing agents, MCP servers, policies, limits, and other platform resources via the platform's REST API."
      : "Built-in Archestra tools, including the archestra__api tool for managing agents, MCP servers, policies, limits, and other platform resources via the platform's REST API.",
    docsUrl: isWhiteLabeled
      ? null
      : getDocsUrl(DocsPage.PlatformArchestraMcpServer),
    serverType: "builtin" as const,
    requiresAuth: false,
    icon: archestraMcpBranding.iconLogo,
  };
}
