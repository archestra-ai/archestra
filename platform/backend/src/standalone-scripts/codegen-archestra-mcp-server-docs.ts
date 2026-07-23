import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ARCHESTRA_TOOL_GROUP_BY_SHORT_NAME,
  ARCHESTRA_TOOL_GROUPS,
  type ArchestraToolGroupId,
  type ArchestraToolShortName,
  DEFAULT_ARCHESTRA_TOOL_NAMES,
  getArchestraToolGroupId,
  getArchestraToolShortName,
} from "@archestra/shared";
import { getArchestraMcpTools } from "@/archestra-mcp-server";
import { TOOL_PERMISSIONS } from "@/archestra-mcp-server/rbac";
import logger from "@/logging";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type ToolPermissionDisplay = string;

// === Tool group definitions ===

// Domain groups and their shortName→group mapping are the shared taxonomy in
// `@archestra/shared` (also drives the agent tool-picker UI). Here we derive a
// display label and a display order from the canonical ordered list.
const groupLabel = new Map<ArchestraToolGroupId, string>(
  ARCHESTRA_TOOL_GROUPS.map((group) => [group.id, group.label]),
);
const groupOrder = new Map<ArchestraToolGroupId, number>(
  ARCHESTRA_TOOL_GROUPS.map((group, index) => [group.id, index]),
);

/**
 * Extra access requirements for tools whose real authorization is finer-grained
 * than the coarse RBAC permission in `TOOL_PERMISSIONS` — for example a team
 * tool that gates on `team:read` but then enforces a team-member-role check in
 * its handler. Rendered in the docs beside the RBAC permission so these
 * handler-level rules are not silently lost. Keyed by tool short name; a tool
 * with no entry has no requirement beyond its RBAC permission.
 */
const toolAccessNotes: Partial<Record<ArchestraToolShortName, string>> = {
  // Membership mutations gate on `team:read`, then require the caller to be an
  // organization-level team manager (holds `team:create`) OR an admin
  // (team-member role) of the target team.
  add_team_member:
    "Beyond `team:read`, the caller must be an organization-level team manager (a role granting `team:create`) or an **admin** of the target team.",
  update_team_member_role:
    "Beyond `team:read`, the caller must be an organization-level team manager (a role granting `team:create`) or an **admin** of the target team.",
  remove_team_member:
    "Beyond `team:read`, the caller must be an organization-level team manager (a role granting `team:create`) or an **admin** of the target team.",
  // Reads are scoped: non-managers only see teams they belong to.
  get_team:
    "Callers without organization-level team management (`team:create`) can only read teams they are a member of.",
  list_team_members:
    "Callers without organization-level team management (`team:create`) can only read members of teams they are a member of.",
  list_teams:
    "Callers without organization-level team management (`team:create`) only see teams they are a member of.",
  // Sharing gates on `project:update`, then the handler restricts to the
  // project's owner (or a `project:admin`) and org-wide visibility changes to
  // callers holding `project:share-org`.
  set_project_share:
    "Beyond `project:update`, the caller must own the project (or hold `project:admin`), and moving a project into or out of organization-wide visibility additionally requires `project:share-org`.",
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
  const groupCount = new Set(Object.values(ARCHESTRA_TOOL_GROUP_BY_SHORT_NAME))
    .size;

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

  const preInstalledShortNames = allPreInstalledShortNames.filter(
    (n): n is ArchestraToolShortName => isArchestraToolShortName(n),
  );

  // Group tools
  const grouped = new Map<
    ArchestraToolGroupId,
    {
      shortName: ArchestraToolShortName;
      description: string;
      requiredPermission: ToolPermissionDisplay;
      accessNote?: string;
      inputSchema: JsonSchema;
      outputSchema?: JsonSchema;
    }[]
  >();

  for (const tool of tools) {
    const shortName = getArchestraToolShortName(tool.name) ?? tool.name;

    const typedShortName = shortName as ArchestraToolShortName;
    const group = getArchestraToolGroupId(shortName);
    if (!group) {
      throw new Error(
        `Tool "${shortName}" has no group mapping. ` +
          "Add it to ARCHESTRA_TOOL_GROUP_BY_SHORT_NAME in @archestra/shared.",
      );
    }

    if (!grouped.has(group)) {
      grouped.set(group, []);
    }
    grouped.get(group)?.push({
      shortName: typedShortName,
      description: truncateDescription(tool.description ?? ""),
      requiredPermission: formatToolPermission(typedShortName),
      accessNote: toolAccessNotes[typedShortName],
      inputSchema: tool.inputSchema as JsonSchema,
      outputSchema: tool.outputSchema as JsonSchema | undefined,
    });
  }

  // Sort groups by order
  const sortedGroups = [...grouped.entries()].sort(
    ([a], [b]) => (groupOrder.get(a) ?? 0) - (groupOrder.get(b) ?? 0),
  );

  // Build unified Tools Reference sections (overview table + detailed schemas per group)
  const referenceSections: string[] = [];
  for (const [group, groupTools] of sortedGroups) {
    let section = `### ${groupLabel.get(group) ?? group}\n\n`;
    section += "| Tool | Description | Required RBAC Permission |\n";
    section += "|------|-------------|--------------------------|\n";

    for (const tool of groupTools) {
      // A trailing dagger flags tools whose real requirement is finer than the
      // RBAC permission; the full note lives in the tool's detail section.
      const permissionCell = tool.accessNote
        ? `${tool.requiredPermission} †`
        : tool.requiredPermission;
      section += `| \`${tool.shortName}\` | ${escapeTableCell(tool.description)} | ${escapeTableCell(permissionCell)} |\n`;
    }

    if (groupTools.some((tool) => tool.accessNote)) {
      section +=
        "\n† This tool enforces an additional access requirement beyond its RBAC permission — see its details below.\n";
    }

    // Add detailed input schemas for each tool in this group
    for (const tool of groupTools) {
      const schemaMarkdown = renderToolSchemas(
        tool.shortName,
        tool.requiredPermission,
        tool.inputSchema,
        tool.outputSchema,
        tool.accessNote,
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
Renaming/deleting this page? Add a redirect in docs/redirects.json.
-->

The Archestra MCP Server is a built-in MCP server that ships with the platform and requires no installation. It exposes tools for managing platform resources such as agents, MCP servers, policies, and limits.

Most tools require explicit assignment to Agents or MCP Gateways before they can be used. The following tools are pre-installed on all new agents by default: ${preInstalledList}.

${formatToolLink("query_knowledge_sources")} appears for Agents and MCP Gateways only when at least one [knowledge base or connector](/docs/platform-knowledge) is attached. To use it, the user must have ${queryKnowledgeSourcesPermission}.

All Archestra tools are prefixed with \`archestra__\`. Most built-in tools are always trusted — they bypass tool invocation and trusted data policies.

${formatToolLink("query_knowledge_sources")} is an exception: its output is treated as sensitive by default and is evaluated by trusted data policies. See [AI Tool Guardrails](/docs/platform-ai-tool-guardrails) for more details.

## Auth

Archestra tools are **trusted** by default, meaning they bypass [tool invocation and trusted data policies](/docs/platform-ai-tool-guardrails) — the tool will always execute without policy evaluation.

${formatToolLink("query_knowledge_sources")} is evaluated by trusted data policies and its results are treated as sensitive by default.

However, **RBAC (role-based access control) is still enforced**. Every tool is mapped to a required permission (resource + action). The \`tools/list\` endpoint dynamically filters tools so users only see tools they have permission to use. For example, a user without \`knowledgeSource:create\` permission will not see ${formatToolLink("create_knowledge_base")} in their tool list and cannot execute it.

Some tools enforce an **additional access requirement** in their handler beyond this RBAC permission — for example, the team membership tools gate on \`team:read\` but then require the caller to be an organization-level team manager or an admin (team-member role) of the specific team. These tools are marked with a † in the tables below, and the requirement is spelled out in each tool's details.

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
  return Object.hasOwn(ARCHESTRA_TOOL_GROUP_BY_SHORT_NAME, toolShortName);
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
  accessNote?: string,
): string | null {
  let md = `#### ${toolName}\n\n`;
  md += `Required RBAC permission: ${requiredPermission}\n\n`;
  if (accessNote) {
    md += `Additional access requirement: ${accessNote}\n\n`;
  }

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
