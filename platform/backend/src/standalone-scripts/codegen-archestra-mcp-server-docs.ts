import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type ArchestraToolShortName,
  DEFAULT_ARCHESTRA_TOOL_NAMES,
  getArchestraToolShortName,
} from "@shared";
import { getArchestraMcpTools } from "@/archestra-mcp-server";
import { toolShortNames as knowledgeManagementToolShortNames } from "@/archestra-mcp-server/knowledge-management";
import { TOOL_PERMISSIONS } from "@/archestra-mcp-server/rbac";
import logger from "@/logging";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type ToolPermissionDisplay = string;

// === Tool group definitions ===

enum ToolGroup {
  Identity = "Identity",
  Agents = "Agents",
  LLMProxies = "LLM Proxies",
  MCPGateways = "MCP Gateways",
  MCPServers = "MCP Servers",
  Limits = "Limits",
  Policies = "Policies",
  ToolAssignment = "Tool Assignment",
  KnowledgeManagement = "Knowledge Management",
  Chat = "Chat",
  Meta = "Meta",
}

const groupOrder: Record<ToolGroup, number> = {
  [ToolGroup.Identity]: 0,
  [ToolGroup.Agents]: 1,
  [ToolGroup.LLMProxies]: 2,
  [ToolGroup.MCPGateways]: 3,
  [ToolGroup.MCPServers]: 4,
  [ToolGroup.Limits]: 5,
  [ToolGroup.Policies]: 6,
  [ToolGroup.ToolAssignment]: 7,
  [ToolGroup.KnowledgeManagement]: 8,
  [ToolGroup.Chat]: 9,
  [ToolGroup.Meta]: 10,
};

/**
 * Maps every Archestra tool short name to its documentation group.
 * Typed as Record<ArchestraToolShortName, ToolGroup> so that adding a new tool
 * to any group file without updating this mapping causes a compile error.
 */
const toolGroups: Record<ArchestraToolShortName, ToolGroup> = {
  whoami: ToolGroup.Identity,

  create_agent: ToolGroup.Agents,
  get_agent: ToolGroup.Agents,
  list_agents: ToolGroup.Agents,
  edit_agent: ToolGroup.Agents,

  create_llm_proxy: ToolGroup.LLMProxies,
  get_llm_proxy: ToolGroup.LLMProxies,
  edit_llm_proxy: ToolGroup.LLMProxies,

  create_mcp_gateway: ToolGroup.MCPGateways,
  get_mcp_gateway: ToolGroup.MCPGateways,
  edit_mcp_gateway: ToolGroup.MCPGateways,

  search_private_mcp_registry: ToolGroup.MCPServers,
  get_mcp_servers: ToolGroup.MCPServers,
  get_mcp_server_tools: ToolGroup.MCPServers,
  edit_mcp_description: ToolGroup.MCPServers,
  edit_mcp_config: ToolGroup.MCPServers,
  create_mcp_server: ToolGroup.MCPServers,
  deploy_mcp_server: ToolGroup.MCPServers,
  list_mcp_server_deployments: ToolGroup.MCPServers,
  get_mcp_server_logs: ToolGroup.MCPServers,
  create_mcp_server_installation_request: ToolGroup.MCPServers,

  create_limit: ToolGroup.Limits,
  get_limits: ToolGroup.Limits,
  update_limit: ToolGroup.Limits,
  delete_limit: ToolGroup.Limits,
  get_agent_token_usage: ToolGroup.Limits,
  get_llm_proxy_token_usage: ToolGroup.Limits,

  get_autonomy_policy_operators: ToolGroup.Policies,
  get_tool_invocation_policies: ToolGroup.Policies,
  create_tool_invocation_policy: ToolGroup.Policies,
  get_tool_invocation_policy: ToolGroup.Policies,
  update_tool_invocation_policy: ToolGroup.Policies,
  delete_tool_invocation_policy: ToolGroup.Policies,
  get_trusted_data_policies: ToolGroup.Policies,
  create_trusted_data_policy: ToolGroup.Policies,
  get_trusted_data_policy: ToolGroup.Policies,
  update_trusted_data_policy: ToolGroup.Policies,
  delete_trusted_data_policy: ToolGroup.Policies,

  bulk_assign_tools_to_agents: ToolGroup.ToolAssignment,
  bulk_assign_tools_to_mcp_gateways: ToolGroup.ToolAssignment,

  query_knowledge_sources: ToolGroup.KnowledgeManagement,
  create_knowledge_base: ToolGroup.KnowledgeManagement,
  get_knowledge_bases: ToolGroup.KnowledgeManagement,
  get_knowledge_base: ToolGroup.KnowledgeManagement,
  update_knowledge_base: ToolGroup.KnowledgeManagement,
  delete_knowledge_base: ToolGroup.KnowledgeManagement,
  create_knowledge_connector: ToolGroup.KnowledgeManagement,
  get_knowledge_connectors: ToolGroup.KnowledgeManagement,
  get_knowledge_connector: ToolGroup.KnowledgeManagement,
  update_knowledge_connector: ToolGroup.KnowledgeManagement,
  delete_knowledge_connector: ToolGroup.KnowledgeManagement,
  assign_knowledge_connector_to_knowledge_base: ToolGroup.KnowledgeManagement,
  unassign_knowledge_connector_from_knowledge_base:
    ToolGroup.KnowledgeManagement,
  assign_knowledge_base_to_agent: ToolGroup.KnowledgeManagement,
  unassign_knowledge_base_from_agent: ToolGroup.KnowledgeManagement,
  assign_knowledge_connector_to_agent: ToolGroup.KnowledgeManagement,
  unassign_knowledge_connector_from_agent: ToolGroup.KnowledgeManagement,

  todo_write: ToolGroup.Chat,
  artifact_write: ToolGroup.Chat,
  swap_agent: ToolGroup.Chat,
  swap_to_default_agent: ToolGroup.Chat,

  search_tools: ToolGroup.Meta,
  run_tool: ToolGroup.Meta,
};

// === Script entry point ===

async function main() {
  logger.info("Generating Archestra MCP Server documentation...");

  const docsFilePath = path.join(
    __dirname,
    "../../../../docs/pages/platform-archestra-mcp-server.md",
  );

  const docsDir = path.dirname(docsFilePath);
  if (!fs.existsSync(docsDir)) {
    fs.mkdirSync(docsDir, { recursive: true });
  }

  let existingContent: string | null = null;
  if (fs.existsSync(docsFilePath)) {
    existingContent = fs.readFileSync(docsFilePath, "utf-8");
  }

  const markdownContent = generateMarkdownContent(existingContent);
  fs.writeFileSync(docsFilePath, markdownContent);

  const tools = getArchestraMcpTools();
  const groupCount = new Set(Object.values(toolGroups)).size;

  logger.info(`Documentation generated at: ${docsFilePath}`);
  logger.info(`Generated tables for:`);
  logger.info(`   - ${tools.length} tools`);
  logger.info(`   - ${groupCount} groups`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    logger.error({ error }, "Error generating documentation");
    process.exit(1);
  });
}

// === Internal helpers ===

function generateFrontmatter(lastUpdated: string): string {
  return `---
title: "Archestra MCP Server"
category: MCP
description: "Built-in MCP server providing tools for managing Archestra platform resources"
order: 5
lastUpdated: ${lastUpdated}
---`;
}

function generateMarkdownBody(): string {
  const tools = getArchestraMcpTools();

  const allPreInstalledShortNames = DEFAULT_ARCHESTRA_TOOL_NAMES.map(
    (name) => getArchestraToolShortName(name) ?? name,
  );

  // Knowledge tools are conditionally assigned (only when knowledge sources are attached)
  const knowledgeToolSet = new Set<string>(knowledgeManagementToolShortNames);
  const preInstalledShortNames = allPreInstalledShortNames.filter(
    (n): n is ArchestraToolShortName =>
      isArchestraToolShortName(n) && !knowledgeToolSet.has(n),
  );

  // Group tools
  const grouped = new Map<
    ToolGroup,
    {
      shortName: ArchestraToolShortName;
      description: string;
      requiredPermission: ToolPermissionDisplay;
      inputSchema: JsonSchema;
      outputSchema?: JsonSchema;
    }[]
  >();

  for (const tool of tools) {
    const shortName = getArchestraToolShortName(tool.name) ?? tool.name;

    const typedShortName = shortName as ArchestraToolShortName;
    const group = toolGroups[typedShortName];
    if (!group) {
      throw new Error(
        `Tool "${shortName}" has no group mapping in toolGroups. ` +
          "Add it to the toolGroups record in codegen-archestra-mcp-server-docs.ts",
      );
    }

    if (!grouped.has(group)) {
      grouped.set(group, []);
    }
    grouped.get(group)?.push({
      shortName: typedShortName,
      description: truncateDescription(tool.description ?? ""),
      requiredPermission: formatToolPermission(typedShortName),
      inputSchema: tool.inputSchema as JsonSchema,
      outputSchema: tool.outputSchema as JsonSchema | undefined,
    });
  }

  // Sort groups by order
  const sortedGroups = [...grouped.entries()].sort(
    ([a], [b]) => groupOrder[a] - groupOrder[b],
  );

  // Build unified Tools Reference sections (overview table + detailed schemas per group)
  const referenceSections: string[] = [];
  for (const [group, groupTools] of sortedGroups) {
    let section = `### ${group}\n\n`;
    section += "| Tool | Description | Required RBAC Permission |\n";
    section += "|------|-------------|--------------------------|\n";

    for (const tool of groupTools) {
      section += `| \`${tool.shortName}\` | ${escapeTableCell(tool.description)} | ${escapeTableCell(tool.requiredPermission)} |\n`;
    }

    // Add detailed input schemas for each tool in this group
    for (const tool of groupTools) {
      const schemaMarkdown = renderToolSchemas(
        tool.shortName,
        tool.requiredPermission,
        tool.inputSchema,
        tool.outputSchema,
      );
      if (schemaMarkdown) {
        section += `\n${schemaMarkdown}`;
      }
    }

    referenceSections.push(section);
  }

  const preInstalledList = preInstalledShortNames
    .map((n) => formatToolLink(n))
    .join(", ");
  const queryKnowledgeSourcesPermission = formatToolPermission(
    "query_knowledge_sources",
  );

  return `
<!--
This file is auto-generated by \`pnpm codegen:archestra-mcp-server-docs\`.
Do not edit manually.
-->

The Archestra MCP Server is a built-in MCP server that ships with the platform and requires no installation. It exposes tools for managing platform resources such as agents, MCP servers, policies, and limits.

Most tools require explicit assignment to Agents or MCP Gateways before they can be used. The following tools are pre-installed on all new agents by default: ${preInstalledList}.

Additionally, ${formatToolLink("query_knowledge_sources")} is automatically assigned to Agents and MCP Gateways that have at least one [knowledge base](/platform-knowledge-bases) or [knowledge connector](/platform-knowledge-connectors) attached. To use it, the user must have ${queryKnowledgeSourcesPermission}.

All Archestra tools are prefixed with \`archestra__\` and are always trusted — they bypass tool invocation and trusted data policies.

## Auth

Archestra tools are **trusted**, meaning they bypass [tool invocation policies](/platform-tool-invocation-policies) and [trusted data policies](/platform-trusted-data-policies) — the tool will always execute without policy evaluation.

However, **RBAC (role-based access control) is still enforced**. Every tool is mapped to a required permission (resource + action). The \`tools/list\` endpoint dynamically filters tools so users only see tools they have permission to use. For example, a user without \`knowledgeSource:create\` permission will not see ${formatToolLink("create_knowledge_base")} in their tool list and cannot execute it.

## Tools Reference

${referenceSections.join("\n")}`;
}

function extractBodyFromMarkdown(content: string): string {
  const frontmatterEnd = content.indexOf("---", 4);
  if (frontmatterEnd === -1) return content;
  return content.slice(frontmatterEnd + 3).trim();
}

function extractLastUpdatedFromMarkdown(content: string): string | null {
  const match = content.match(/lastUpdated:\s*(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function generateMarkdownContent(existingContent: string | null): string {
  const newBody = generateMarkdownBody();

  let lastUpdated: string;

  if (existingContent) {
    const existingBody = extractBodyFromMarkdown(existingContent);
    const existingLastUpdated = extractLastUpdatedFromMarkdown(existingContent);

    if (existingBody === newBody.trim() && existingLastUpdated) {
      lastUpdated = existingLastUpdated;
    } else {
      lastUpdated = new Date().toISOString().split("T")[0];
    }
  } else {
    lastUpdated = new Date().toISOString().split("T")[0];
  }

  return `${generateFrontmatter(lastUpdated)}${newBody}`;
}

function truncateDescription(description: string): string {
  let cleaned = description.replace(/\s*IMPORTANT:.*$/s, "").trim();

  const sentenceMatch = cleaned.match(/^(.*?\.)(?:\s|$)/);
  if (sentenceMatch) {
    cleaned = sentenceMatch[1];
  }

  if (cleaned.length > 200) {
    cleaned = `${cleaned.slice(0, 197)}...`;
  }

  return cleaned;
}

function escapeTableCell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

export function formatToolPermission(
  toolShortName: ArchestraToolShortName,
): ToolPermissionDisplay {
  const permission = TOOL_PERMISSIONS[toolShortName];
  if (!permission) {
    return "None (no additional RBAC permission required)";
  }

  return `\`${permission.resource}:${permission.action}\``;
}

function formatToolLink(toolShortName: ArchestraToolShortName): string {
  return `[\`${toolShortName}\`](#${toolShortName})`;
}

function isArchestraToolShortName(
  toolShortName: string,
): toolShortName is ArchestraToolShortName {
  return Object.hasOwn(toolGroups, toolShortName);
}

// === Input schema rendering ===

interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  description?: string;
  enum?: string[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
}

function renderToolSchemas(
  toolName: ArchestraToolShortName,
  requiredPermission: ToolPermissionDisplay,
  inputSchema: JsonSchema,
  outputSchema?: JsonSchema,
): string | null {
  let md = `#### ${toolName}\n\n`;
  md += `Required RBAC permission: ${requiredPermission}\n\n`;

  const inputRows = renderSchemaRows(inputSchema);
  if (inputRows.length === 0) {
    md += "This tool takes no arguments.\n\n";
  } else {
    md += "##### Input\n\n";
    md += "| Parameter | Type | Required | Description |\n";
    md += "|-----------|------|----------|-------------|\n";
    for (const row of inputRows) {
      md += `| ${row.name} | ${row.type} | ${row.required} | ${escapeTableCell(row.description)} |\n`;
    }
    md += "\n";
  }

  if (outputSchema) {
    const outputRows = renderSchemaRows(outputSchema);
    if (outputRows.length === 0) {
      md +=
        "##### Output\n\nThis tool returns structured output with no documented fields.\n";
    } else {
      md += "##### Output\n\n";
      md += "| Field | Type | Required | Description |\n";
      md += "|-------|------|----------|-------------|\n";
      for (const row of outputRows) {
        md += `| ${row.name} | ${row.type} | ${row.required} | ${escapeTableCell(row.description)} |\n`;
      }
    }
  }

  return md;
}

export function renderSchemaRows(
  schema: JsonSchema,
  rootPrefix = "",
): { name: string; type: string; required: string; description: string }[] {
  const objectSchema = getObjectSchema(schema);
  if (objectSchema?.properties) {
    return renderProperties(
      objectSchema.properties,
      new Set(objectSchema.required ?? []),
      rootPrefix,
    );
  }

  const arrayItemObjectSchema = getObjectSchema(schema.items);
  if (schema.type === "array" && arrayItemObjectSchema?.properties) {
    return renderProperties(
      arrayItemObjectSchema.properties,
      new Set(arrayItemObjectSchema.required ?? []),
      rootPrefix ? `${rootPrefix}[]` : "[]",
    );
  }

  return [];
}

function renderProperties(
  properties: Record<string, JsonSchema>,
  requiredSet: Set<string>,
  prefix = "",
): { name: string; type: string; required: string; description: string }[] {
  const rows: {
    name: string;
    type: string;
    required: string;
    description: string;
  }[] = [];

  for (const [key, prop] of Object.entries(properties)) {
    const qualifiedName = prefix ? `${prefix}.${key}` : key;
    const isRequired = requiredSet.has(key);
    const typeStr = formatType(prop);
    const desc = prop.description ?? "";

    rows.push({
      name: `\`${qualifiedName}\``,
      type: `\`${typeStr}\``,
      required: isRequired ? "Yes" : "No",
      description: desc,
    });

    // Recurse into nested object properties
    const nestedObjectSchema = getObjectSchema(prop);
    if (nestedObjectSchema?.properties) {
      const nestedRequired = new Set(nestedObjectSchema.required ?? []);
      rows.push(
        ...renderProperties(
          nestedObjectSchema.properties,
          nestedRequired,
          qualifiedName,
        ),
      );
    }

    // Recurse into array item properties
    const itemObjectSchema = getObjectSchema(prop.items);
    if (prop.type === "array" && itemObjectSchema?.properties) {
      const itemRequired = new Set(itemObjectSchema.required ?? []);
      rows.push(
        ...renderProperties(
          itemObjectSchema.properties,
          itemRequired,
          `${qualifiedName}[]`,
        ),
      );
    }
  }

  return rows;
}

export function formatType(schema: JsonSchema): string {
  if (schema.enum) {
    return schema.enum.map((v) => `"${v}"`).join(" \\| ");
  }

  const variants = getUnionVariants(schema);
  if (variants) {
    return variants.map(formatType).join(" \\| ");
  }

  if (schema.type === "array") {
    if (schema.items) {
      if (getObjectSchema(schema.items)) {
        return "object[]";
      }
      return `${schema.items.type ?? "any"}[]`;
    }
    return "array";
  }

  return schema.type ?? "any";
}

function getObjectSchema(schema?: JsonSchema): JsonSchema | undefined {
  if (!schema) {
    return undefined;
  }

  if (schema.type === "object" && schema.properties) {
    return schema;
  }

  return getUnionVariants(schema)?.find(
    (variant) => variant.type === "object" && variant.properties,
  );
}

function getUnionVariants(schema: JsonSchema): JsonSchema[] | undefined {
  const variants = schema.anyOf ?? schema.oneOf;
  return variants && variants.length > 0 ? variants : undefined;
}
