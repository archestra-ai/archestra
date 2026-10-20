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
  isAppRuntimeOnlyArchestraToolShortName,
  type Resource,
  resourceLabels,
} from "@archestra/shared";
import {
  allAvailableActions,
  roleActionResourceFor,
} from "@archestra/shared/access-control";
import { getAllArchestraMcpTools } from "@/archestra-mcp-server";
import { TOOL_PERMISSIONS } from "@/archestra-mcp-server/rbac";
import logger from "@/logging";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type ToolPermissionDisplay = string;

// === Tool group definitions ===

// Domain groups and their shortName→group mapping are the shared taxonomy in
// `@archestra/shared` (also drives the agent tool-picker UI). The docs page
// orders groups by what a reader looks for — the agent's own work first, then
// the resources it manages, then organization administration — and renames the
// two groups whose picker labels do not match the docs' product names. A
// Record keyed by group id makes a new group a compile error until it is placed.
const docsGroupOrder: Record<ArchestraToolGroupId, number> = {
  identity: 0,
  chat: 1,
  meta: 2,
  skills: 3,
  files: 4,
  skill_sandbox: 5,
  apps: 6,
  projects: 7,
  tasks: 8,
  agents: 9,
  knowledge_management: 10,
  mcp_servers: 11,
  mcp_gateways: 12,
  tool_assignment: 13,
  openappa: 14,
  limits: 15,
  teams: 16,
  plugins: 17,
};
const docsGroupLabelOverrides: Partial<Record<ArchestraToolGroupId, string>> = {
  meta: "Tool Discovery",
  openappa: "Guardrails",
};
const groupLabel = new Map<ArchestraToolGroupId, string>(
  ARCHESTRA_TOOL_GROUPS.map((group) => [
    group.id,
    docsGroupLabelOverrides[group.id] ?? group.label,
  ]),
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
  post_thread_file:
    "Requires an authenticated messaging-channel conversation and a file in its own sandbox. The channel, thread, and bot identity come from that conversation; they cannot be supplied as tool arguments. The provider must support file uploads.",
  // Membership mutations gate on `team:read`, then require the caller to be an
  // organization-level team manager (holds `team:create`) OR an admin
  // (team-member role) of the target team.
  add_team_member:
    "Beyond `team:read`, the caller must be an organization-level team manager (a role granting `team:create`) or an **admin** of the target team.",
  update_team_member_role:
    "Beyond `team:read`, the caller must be an organization-level team manager (a role granting `team:create`) or an **admin** of the target team.",
  remove_team_member:
    "Beyond `team:read`, the caller must be an organization-level team manager (a role granting `team:create`) or an **admin** of the target team.",
  create_schedule_trigger:
    "Requires an acting user. Omitting `project_id` creates a private project with the task prompt as its instructions. Repeating the same new-project task returns the existing schedule. An existing project must be accessible to the caller.",
  get_schedule_trigger:
    "Requires a user token. The caller must be the schedule actor, a project member, or someone with organization-wide Projects **Can read** access.",
  list_schedule_trigger_runs:
    "Requires a user token. The caller must be the schedule actor, a project member, or someone with organization-wide Projects **Can read** access.",
  get_schedule_trigger_run:
    "Requires a user token. The caller must be the schedule actor, a project member, or someone with organization-wide Projects **Can read** access.",
  update_schedule_trigger:
    "Requires a user token. Only the schedule actor or someone with organization-wide Projects **Can update** access can perform this action. Project membership alone permits reading. See [Granular Access Control](/docs/admin/access-control#granular-access-control).",
  delete_schedule_trigger:
    "Requires a user token. Only the schedule actor or someone with organization-wide Projects **Full access** access can perform this action. Project membership alone permits reading. See [Granular Access Control](/docs/admin/access-control#granular-access-control).",
  enable_schedule_trigger:
    "Requires a user token. Only the schedule actor or someone with organization-wide Projects **Can update** access can perform this action. Project membership alone permits reading. See [Granular Access Control](/docs/admin/access-control#granular-access-control).",
  disable_schedule_trigger:
    "Requires a user token. Only the schedule actor or someone with organization-wide Projects **Can update** access can perform this action. Project membership alone permits reading. See [Granular Access Control](/docs/admin/access-control#granular-access-control).",
  run_schedule_trigger_now:
    "Requires a user token. Only the schedule actor or someone with organization-wide Projects **Can use** access can perform this action. Project membership alone permits reading. See [Granular Access Control](/docs/admin/access-control#granular-access-control).",
  // Reads are scoped: non-managers only see teams they belong to.
  get_team:
    "Callers without organization-level team management (`team:create`) can only read teams they are a member of.",
  list_team_members:
    "Callers without organization-level team management (`team:create`) can only read members of teams they are a member of.",
  list_teams:
    "Callers without organization-level team management (`team:create`) only see teams they are a member of.",
  // The read tools stay on the caller's own reach: `project:admin` oversight of
  // a foreign project is a REST/UI capability and does not extend to them.
  list_projects:
    "Returns only projects the caller owns or that are shared with them. Oversight of every project (a `*` grant) does **not** extend to this tool.",
  get_project:
    "Readable only for projects the caller owns or that are shared with them. Oversight of every project (a `*` grant) does **not** extend to this tool.",
};

/**
 * Deployment prerequisites for groups whose tools are only served once a
 * runtime is configured (the `isToolRuntimeEnabled` filter in
 * `archestra-mcp-server/index.ts`). This page documents the full product
 * surface, so a reader whose deployment omits the runtime needs to know why
 * these tools are absent from their `tools/list`.
 */
const CODE_RUNTIME_PREREQUISITE =
  "served only when the code runtime is enabled — set [`ARCHESTRA_CODE_RUNTIME_DAGGER_RUNNER_HOST`](/docs/reference/configuration#ARCHESTRA_CODE_RUNTIME_DAGGER_RUNNER_HOST), or [`ARCHESTRA_CODE_RUNTIME_ENABLED=true`](/docs/reference/configuration#ARCHESTRA_CODE_RUNTIME_ENABLED) together with an orchestrator kubeconfig. Without it they do not appear in `tools/list`.";

const groupAvailabilityNotes: Partial<Record<ArchestraToolGroupId, string>> = {
  skill_sandbox: `These tools are ${CODE_RUNTIME_PREREQUISITE} The [Code Sandbox](/docs/agents#code-sandbox) page covers what the runtime is and how an agent uses it.`,
};

const HOOK_RUNTIME_NOTE =
  "Served only when the code runtime is enabled (the same prerequisite as the [Code Sandbox](#code-sandbox) tools), because a hook executes in the conversation sandbox.";

/**
 * Availability notes for individual tools whose group is otherwise
 * unconditional — the hook tools sit in the Agents group but carry the code
 * runtime's prerequisite.
 */
const toolAvailabilityNotes: Partial<Record<ArchestraToolShortName, string>> = {
  list_hooks: HOOK_RUNTIME_NOTE,
  create_hook: HOOK_RUNTIME_NOTE,
  update_hook: HOOK_RUNTIME_NOTE,
  delete_hook: HOOK_RUNTIME_NOTE,
};

// === Script entry point ===

async function main() {
  logger.info("Generating Archestra MCP Server documentation...");

  const docsFilePath = path.join(
    __dirname,
    "../../../../docs/pages/reference/archestra-mcp-server.md",
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
  fs.writeFileSync(docsFilePath, `${markdownContent.trimEnd()}\n`);

  // App-runtime-only built-ins are not part of the agent-facing surface this
  // page documents (they are covered on the Apps page).
  const tools = getAllArchestraMcpTools().filter((tool) => {
    const shortName = getArchestraToolShortName(tool.name);
    return !(shortName && isAppRuntimeOnlyArchestraToolShortName(shortName));
  });
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
description: "Every built-in tool an agent uses to manage Archestra, with its inputs and required permission"
order: 4
lastUpdated: ${lastUpdated}
---`;
}

function generateMarkdownBody(): string {
  // App-runtime-only built-ins are not part of the agent-facing surface this
  // page documents (they are covered on the Apps page).
  const tools = getAllArchestraMcpTools().filter((tool) => {
    const shortName = getArchestraToolShortName(tool.name);
    return !(shortName && isAppRuntimeOnlyArchestraToolShortName(shortName));
  });

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
      availabilityNote?: string;
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
      availabilityNote: toolAvailabilityNotes[typedShortName],
      inputSchema: tool.inputSchema as JsonSchema,
      outputSchema: tool.outputSchema as JsonSchema | undefined,
    });
  }

  assertEveryMappedToolRendered(grouped);

  // Sort groups by order
  const sortedGroups = [...grouped.entries()].sort(
    ([a], [b]) => docsGroupOrder[a] - docsGroupOrder[b],
  );

  // Build unified Tools Reference sections (overview table + detailed schemas per group)
  const referenceSections: string[] = [];
  for (const [group, groupTools] of sortedGroups) {
    let section = `### ${groupLabel.get(group) ?? group}\n\n`;
    const groupAvailabilityNote = groupAvailabilityNotes[group];
    if (groupAvailabilityNote) {
      section += `${groupAvailabilityNote}\n\n`;
    }
    section += "| Tool | Description | Permission |\n";
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
      const schemaMarkdown = renderToolSchemas({
        toolName: tool.shortName,
        requiredPermission: tool.requiredPermission,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        accessNote: tool.accessNote,
        availabilityNote: tool.availabilityNote,
      });
      if (schemaMarkdown) {
        section += `\n${schemaMarkdown}`;
      }
    }

    referenceSections.push(section);
  }

  const preInstalledList = new Intl.ListFormat("en", {
    type: "conjunction",
  }).format(preInstalledShortNames.map((n) => formatToolLink(n)));

  return `
<!--
This file is auto-generated by \`pnpm codegen:archestra-mcp-server-docs\`.
Do not edit manually.
Renaming/deleting this page? Add a redirect in docs/redirects.json.
-->

Let an agent run Archestra for you: ask it to create an agent, install an MCP server, or build an app, and it calls these tools. The Archestra MCP Server is built into every deployment and acts as the person using the agent, with their permissions. Every tool name starts with \`archestra__\`. This page lists tools by their short name.

<span id="access"></span>

## Give an Agent These Tools

Pick these tools like any other MCP server's tools, on an agent's **Tools, Skills & Knowledge** tab or a gateway's **Tools & Knowledge** settings:

- **Manual:** assign the tools you want.
- **All:** the agent gets every tool the person can use, but built-in tools start out excluded. Remove a tool from the exclusions to allow it.

New agents include ${preInstalledList}. Turning on a feature adds its own default tools. ${formatToolLink("query_knowledge_sources")} appears only when the agent or gateway has a [knowledge base or connector](/docs/knowledge) attached.

## Permissions

Each tool needs the permission in the last column of its table. A person sees only the tools their permissions allow: without \`knowledgeSource:create\`, for example, ${formatToolLink("create_knowledge_base")} is hidden. A tool marked † has an extra condition, described in its entry. [Guardrails](/docs/agents/guardrails) policies apply on top of these permissions.

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
  const newBody = linkPermissionMentions(generateMarkdownBody());

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

/**
 * Fails the build when a tool carrying a group mapping never reached the page.
 * The `Record<ArchestraToolShortName, …>` typing of the taxonomy guarantees
 * every tool is *classified*; only this guarantees every tool is *rendered*,
 * which a conditionally-built source list can silently break.
 */
function assertEveryMappedToolRendered(
  grouped: Map<ArchestraToolGroupId, { shortName: ArchestraToolShortName }[]>,
): void {
  const rendered = new Set(
    [...grouped.values()].flat().map((tool) => tool.shortName),
  );

  const missing = Object.keys(ARCHESTRA_TOOL_GROUP_BY_SHORT_NAME).filter(
    (shortName) =>
      !rendered.has(shortName as ArchestraToolShortName) &&
      !isAppRuntimeOnlyArchestraToolShortName(shortName),
  );

  if (missing.length > 0) {
    throw new Error(
      `Tools missing from the generated reference: ${missing.join(", ")}. ` +
        "Every tool in ARCHESTRA_TOOL_GROUP_BY_SHORT_NAME must be documented — " +
        "check that getAllArchestraMcpTools() still returns it unconditionally, " +
        "or add it to APP_RUNTIME_ONLY_ARCHESTRA_TOOL_SHORT_NAMES if it is not " +
        "part of the agent-facing surface.",
    );
  }
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
    return "None";
  }

  // No role holds this action: it is granted on the individual item.
  const resource = roleActionResourceFor(permission.resource);
  if (!allAvailableActions[resource]?.includes(permission.action as never)) {
    const item = perItemNoun(resource);
    return `\`${permission.action}\` on the ${item} (granted per item)`;
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
  const?: string | number | boolean;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
}

function renderToolSchemas(params: {
  toolName: ArchestraToolShortName;
  requiredPermission: ToolPermissionDisplay;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  accessNote?: string;
  availabilityNote?: string;
}): string | null {
  const {
    toolName,
    requiredPermission,
    inputSchema,
    outputSchema,
    accessNote,
    availabilityNote,
  } = params;
  let md = `#### ${toolName}\n\n`;
  md += `Required RBAC permission: ${requiredPermission}\n\n`;
  if (availabilityNote) {
    md += `Availability: ${availabilityNote}\n\n`;
  }
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
    const nestedObjectVariants = getObjectUnionVariants(prop);
    const nestedObjectSchema = getObjectSchema(prop);
    if (nestedObjectVariants) {
      rows.push(
        ...renderUnionObjectProperties(nestedObjectVariants, qualifiedName),
      );
    } else if (nestedObjectSchema?.properties) {
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
    const itemObjectVariants = getObjectUnionVariants(prop.items);
    const itemObjectSchema = getObjectSchema(prop.items);
    if (prop.type === "array" && itemObjectVariants) {
      rows.push(
        ...renderUnionObjectProperties(
          itemObjectVariants,
          `${qualifiedName}[]`,
        ),
      );
    } else if (prop.type === "array" && itemObjectSchema?.properties) {
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

function renderUnionObjectProperties(
  variants: JsonSchema[],
  prefix: string,
): { name: string; type: string; required: string; description: string }[] {
  const keys = new Map<
    string,
    Array<{ schema: JsonSchema; required: boolean; variant: JsonSchema }>
  >();
  for (const variant of variants) {
    const required = new Set(variant.required ?? []);
    for (const [key, schema] of Object.entries(variant.properties ?? {})) {
      const entries = keys.get(key) ?? [];
      entries.push({ schema, required: required.has(key), variant });
      keys.set(key, entries);
    }
  }

  return Array.from(keys.entries()).map(([key, entries]) => {
    const types = Array.from(
      new Set(entries.map(({ schema }) => formatType(schema))),
    );
    const requiredEverywhere =
      entries.length === variants.length &&
      entries.every(({ required }) => required);
    const variantConditions = entries
      .filter(({ required }) => required)
      .map(({ variant }) => formatVariantCondition(variant))
      .filter((value): value is string => value !== null);
    const descriptions = Array.from(
      new Set(entries.map(({ schema }) => schema.description).filter(Boolean)),
    );
    const isDiscriminator = entries.every(
      ({ schema }) => schema.const !== undefined,
    );
    const description = isDiscriminator
      ? entries
          .filter(({ schema }) => schema.description)
          .map(
            ({ schema }) =>
              `${JSON.stringify(schema.const)}: ${schema.description}`,
          )
          .join(" ")
      : descriptions.length <= 1
        ? (descriptions[0] ?? "")
        : Array.from(
            new Set(
              entries.flatMap(({ schema, variant }) => {
                if (!schema.description) return [];
                const condition = formatVariantCondition(variant);
                return [
                  condition
                    ? `When ${condition}: ${schema.description}`
                    : schema.description,
                ];
              }),
            ),
          ).join(" ");

    return {
      name: `\`${prefix}.${key}\``,
      type: `\`${types.join(" \\| ")}\``,
      required: requiredEverywhere
        ? "Yes"
        : variantConditions.length > 0
          ? `When ${variantConditions.join(" or ")}`
          : "No",
      description,
    };
  });
}

function formatVariantCondition(variant: JsonSchema): string | null {
  for (const [key, schema] of Object.entries(variant.properties ?? {})) {
    if (schema.const !== undefined) {
      return `\`${key}=${JSON.stringify(schema.const)}\``;
    }
  }
  return null;
}

export function formatType(schema: JsonSchema): string {
  if (schema.const !== undefined) {
    return JSON.stringify(schema.const);
  }
  if (schema.enum) {
    return schema.enum.map((v) => `"${v}"`).join(" \\| ");
  }

  const variants = getUnionVariants(schema);
  if (variants) {
    if (variants.every((variant) => variant.type === "object")) {
      return "object";
    }
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

function getObjectUnionVariants(schema?: JsonSchema): JsonSchema[] | undefined {
  if (!schema) return undefined;
  const variants = getUnionVariants(schema)?.filter(
    (variant) => variant.type === "object" && variant.properties,
  );
  return variants && variants.length > 1 ? variants : undefined;
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

// A function, not a constant: this script runs while the module loads.
function perItemNoun(resource: Resource): string {
  switch (resource) {
    case "mcpGateway":
      return "MCP gateway";
    case "mcpRegistry":
      return "MCP registry entry";
    default:
      return resourceLabels[resource].toLowerCase().replace(/s$/, "");
  }
}

/**
 * Link every inline-code `resource:action` permission to its row on the
 * Permissions reference, as `.github/scripts/check-docs-permission-links.py`
 * requires of every docs page.
 */
function linkPermissionMentions(markdown: string): string {
  return markdown.replace(
    /(?<!\[)`([A-Za-z]+):([a-z-]+)`(?!\]\()/g,
    (mention, resource: string, action: string) =>
      (allAvailableActions as Record<string, readonly string[]>)[
        resource
      ]?.includes(action)
        ? `[${mention}](/docs/reference/permissions#${resource}:${action})`
        : mention,
  );
}
