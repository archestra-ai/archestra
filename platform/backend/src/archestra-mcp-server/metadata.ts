import { DocsPage, getDocsUrl } from "@shared";
import type { InsertInternalMcpCatalog } from "@/types";

export const ARCHESTRA_MCP_CATALOG_METADATA: Pick<
  InsertInternalMcpCatalog,
  "name" | "description" | "docsUrl" | "serverType" | "requiresAuth"
> = {
  name: "Archestra",
  description:
    "Built-in Archestra tools for creating and managing agents, tools, MCP servers, policies, limits, and other platform resources.",
  docsUrl: getDocsUrl(DocsPage.PlatformArchestraMcpServer),
  serverType: "builtin" as const,
  requiresAuth: false,
};
