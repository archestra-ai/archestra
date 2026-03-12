import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ARCHESTRA_MCP_SERVER_NAME,
  DEFAULT_ARCHESTRA_TOOL_NAMES,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import {
  type ArchestraToolShortName,
  getArchestraMcpTools,
} from "@/archestra-mcp-server";
import { toolShortNames as knowledgeToolShortNames } from "@/archestra-mcp-server/knowledge";
import logger from "@/logging";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TOOL_PREFIX = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}`;

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
  KnowledgeBase = "Knowledge Base",
  Chat = "Chat",
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
  [ToolGroup.KnowledgeBase]: 8,
  [ToolGroup.Chat]: 9,
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

  create_mcp_gateway: ToolGroup.MCPGateways,
  get_mcp_gateway: ToolGroup.MCPGateways,

  search_private_mcp_registry: ToolGroup.MCPServers,
  get_mcp_servers: ToolGroup.MCPServers,
  get_mcp_server_tools: ToolGroup.MCPServers,
  edit_mcp: ToolGroup.MCPServers,
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

  query_knowledge_sources: ToolGroup.KnowledgeBase,

  todo_write: ToolGroup.Chat,
  artifact_write: ToolGroup.Chat,
  swap_agent: ToolGroup.Chat,
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

  const allPreInstalledShortNames = DEFAULT_ARCHESTRA_TOOL_NAMES.map((name) =>
    name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name,
  );

  // Knowledge tools are conditionally assigned (only when knowledge sources are attached)
  const knowledgeToolSet = new Set<string>(knowledgeToolShortNames);
  const preInstalledShortNames = allPreInstalledShortNames.filter(
    (n) => !knowledgeToolSet.has(n),
  );

  // Group tools
  const grouped = new Map<
    ToolGroup,
    { shortName: string; description: string }[]
  >();

  for (const tool of tools) {
    const shortName = tool.name.startsWith(TOOL_PREFIX)
      ? tool.name.slice(TOOL_PREFIX.length)
      : tool.name;

    const group = toolGroups[shortName as ArchestraToolShortName];
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
      shortName,
      description: truncateDescription(tool.description ?? ""),
    });
  }

  // Sort groups by order
  const sortedGroups = [...grouped.entries()].sort(
    ([a], [b]) => groupOrder[a] - groupOrder[b],
  );

  // Build markdown sections
  const sections: string[] = [];
  for (const [group, groupTools] of sortedGroups) {
    let section = `## ${group}\n\n`;
    section += "| Tool | Description |\n";
    section += "|------|-------------|\n";

    for (const tool of groupTools) {
      section += `| \`${tool.shortName}\` | ${escapeTableCell(tool.description)} |\n`;
    }

    sections.push(section);
  }

  const preInstalledList = preInstalledShortNames
    .map((n) => `\`${n}\``)
    .join(", ");

  return `
<!--
This file is auto-generated by \`pnpm codegen:archestra-mcp-server-docs\`.
Do not edit manually.
-->

The Archestra MCP Server is a built-in MCP server that ships with the platform and requires no installation. It exposes tools for managing platform resources such as agents, MCP servers, policies, and limits.

Most tools require explicit assignment to Agents or MCP Gateways before they can be used. The following tools are pre-installed on all new agents by default: ${preInstalledList}.

Additionally, \`query_knowledge_sources\` is automatically assigned to Agents and MCP Gateways that have at least one [knowledge base](/platform-knowledge-bases) or [knowledge connector](/platform-knowledge-connectors) attached.

All Archestra tools are prefixed with \`archestra__\` and are always trusted — they bypass tool invocation and trusted data policies.

${sections.join("\n")}`;
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
