import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  parseFullToolName,
  TOOL_RUN_TOOL_SHORT_NAME,
  TOOL_SEARCH_TOOLS_SHORT_NAME,
} from "@shared";
import { z } from "zod";
import { InternalMcpCatalogModel, ToolModel } from "@/models";
import { archestraMcpBranding } from "./branding";
import { getAgentTools } from "./delegation";
import {
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
  structuredSuccessResult,
} from "./helpers";
import { filterToolNamesByPermission } from "./rbac";

const SearchToolsArgsSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe(
        "Natural-language search query describing the capability you need. Searches tool names, descriptions, argument names, and argument descriptions.",
      ),
    limit: z
      .number()
      .int()
      .positive()
      .max(20)
      .optional()
      .default(8)
      .describe("Maximum number of matching tools to return."),
  })
  .strict();

const SearchToolsOutputSchema = z.object({
  total: z.number().int().nonnegative().describe("Number of returned tools."),
  tools: z.array(
    z.object({
      toolName: z
        .string()
        .describe(`Exact tool name to pass to ${TOOL_RUN_TOOL_SHORT_NAME}.`),
      title: z
        .string()
        .nullable()
        .describe("Human-friendly title when available."),
      description: z
        .string()
        .nullable()
        .describe("Short tool description, if available."),
      source: z
        .enum(["archestra", "mcp", "agent_delegation"])
        .describe("Where the tool comes from."),
      server: z
        .string()
        .nullable()
        .describe(
          "MCP server prefix for third-party MCP tools when available.",
        ),
      catalogName: z
        .string()
        .nullable()
        .describe("Catalog name for installed MCP tools when available."),
      inputParameters: z.array(
        z.object({
          name: z.string().describe("Top-level input parameter name."),
          required: z.boolean().describe("Whether the parameter is required."),
          description: z
            .string()
            .nullable()
            .describe("Parameter description, if available."),
        }),
      ),
    }),
  ),
});

type SearchCandidate = {
  toolName: string;
  title: string | null;
  description: string | null;
  source: "archestra" | "mcp" | "agent_delegation";
  server: string | null;
  catalogName: string | null;
  inputParameters: Array<{
    name: string;
    required: boolean;
    description: string | null;
  }>;
  searchText: {
    name: string;
    title: string;
    description: string;
    argNames: string;
    argDescriptions: string;
    combined: string;
  };
};

const EXCLUDED_SHORT_NAMES = new Set([
  TOOL_SEARCH_TOOLS_SHORT_NAME,
  TOOL_RUN_TOOL_SHORT_NAME,
]);

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_SEARCH_TOOLS_SHORT_NAME,
    title: "Search Tools",
    description: `Search the agent's available tools on demand. Returns exact tool names plus compact input summaries so you can choose the right tool and then call ${TOOL_RUN_TOOL_SHORT_NAME} with that exact name.`,
    schema: SearchToolsArgsSchema,
    outputSchema: SearchToolsOutputSchema,
    async handler({ args, context }) {
      if (!context.agentId) {
        return errorResult(
          `${TOOL_SEARCH_TOOLS_SHORT_NAME} requires agent context to inspect assigned tools`,
        );
      }

      const searchableTools = await getSearchableTools({
        agentId: context.agentId,
        organizationId: context.organizationId,
        userId: context.userId,
      });

      const preparedQuery = prepareSearchQuery(args.query);
      const rankedTools = searchableTools
        .map((tool) => ({
          tool,
          score: scoreCandidate(tool, preparedQuery),
        }))
        .filter(({ score }) => score > 0)
        .sort(
          (left, right) =>
            right.score - left.score ||
            left.tool.toolName.localeCompare(right.tool.toolName),
        )
        .slice(0, args.limit)
        .map(({ tool }) => ({
          toolName: tool.toolName,
          title: tool.title,
          description: tool.description,
          source: tool.source,
          server: tool.server,
          catalogName: tool.catalogName,
          inputParameters: tool.inputParameters,
        }));

      return structuredSuccessResult(
        {
          total: rankedTools.length,
          tools: rankedTools,
        },
        JSON.stringify(rankedTools, null, 2),
      );
    },
  }),
] as const);

export const toolEntries = registry.toolEntries;
export const tools = registry.tools;

// === Internal helpers ===

async function getSearchableTools(params: {
  agentId: string;
  organizationId?: string;
  userId?: string;
}): Promise<SearchCandidate[]> {
  const { agentId, organizationId, userId } = params;
  const assignedTools = await ToolModel.getMcpToolsByAgent(agentId);
  const permittedNames = await filterToolNamesByPermission(
    assignedTools.map((tool) => tool.name),
    userId,
    organizationId,
  );
  const filteredAssignedTools = assignedTools.filter(
    (tool) =>
      permittedNames.has(tool.name) &&
      !isExcludedArchestraMetaTool(tool.name) &&
      !tool.name.startsWith("agent__"),
  );

  const delegationTools =
    organizationId != null
      ? await getAgentTools({
          agentId,
          organizationId,
          userId,
          skipAccessCheck: userId === "system",
        })
      : [];

  const catalogNamesById = await getCatalogNamesById(filteredAssignedTools);
  const candidates = new Map<string, SearchCandidate>();
  for (const tool of filteredAssignedTools) {
    candidates.set(
      tool.name,
      toAssignedToolCandidate({
        tool,
        catalogName:
          tool.catalogId != null
            ? (catalogNamesById.get(tool.catalogId) ?? null)
            : null,
      }),
    );
  }

  for (const tool of delegationTools) {
    candidates.set(tool.name, toDelegationToolCandidate(tool));
  }

  return Array.from(candidates.values());
}

function toAssignedToolCandidate(params: {
  tool: {
    name: string;
    description: string | null;
    parameters?: Record<string, unknown>;
    catalogId: string | null;
  };
  catalogName: string | null;
}): SearchCandidate {
  const { catalogName, tool } = params;
  const source = archestraMcpBranding.isToolName(tool.name)
    ? "archestra"
    : "mcp";
  const parsedToolName =
    source === "mcp" ? parseFullToolName(tool.name) : { serverName: null };
  const parameters = tool.parameters ?? {};
  const inputParameters = summarizeInputParameters(parameters);
  const title =
    source === "archestra" ? formatArchestraToolTitle(tool.name) : null;

  return {
    toolName: tool.name,
    title,
    description: tool.description,
    source,
    server: parsedToolName.serverName ?? null,
    catalogName: source === "mcp" ? catalogName : null,
    inputParameters,
    searchText: buildSearchText({
      name: tool.name,
      title: title ?? "",
      description: tool.description,
      schema: parameters,
    }),
  };
}

function toDelegationToolCandidate(tool: Tool): SearchCandidate {
  const inputParameters = summarizeInputParameters(
    tool.inputSchema as Record<string, unknown>,
  );

  return {
    toolName: tool.name,
    title: tool.title ?? null,
    description: tool.description ?? null,
    source: "agent_delegation",
    server: null,
    catalogName: null,
    inputParameters,
    searchText: buildSearchText({
      name: tool.name,
      title: tool.title ?? "",
      description: tool.description ?? null,
      schema: tool.inputSchema as Record<string, unknown>,
    }),
  };
}

async function getCatalogNamesById(
  tools: Array<{ catalogId: string | null }>,
): Promise<Map<string, string>> {
  const catalogIds = Array.from(
    new Set(
      tools
        .map((tool) => tool.catalogId)
        .filter((catalogId): catalogId is string => catalogId != null),
    ),
  );
  const catalogs = await InternalMcpCatalogModel.getByIds(catalogIds);
  return new Map(
    Array.from(catalogs.values()).map((catalog) => [catalog.id, catalog.name]),
  );
}

function buildSearchText(params: {
  name: string;
  title: string;
  description: string | null;
  schema: Record<string, unknown>;
}) {
  const flattenedSchema = flattenSchemaText(params.schema);
  const name = normalizeText(params.name);
  const title = normalizeText(params.title);
  const description = normalizeText(params.description ?? "");
  const argNames = normalizeText(flattenedSchema.names.join(" "));
  const argDescriptions = normalizeText(flattenedSchema.descriptions.join(" "));

  return {
    name,
    title,
    description,
    argNames,
    argDescriptions,
    combined: [name, title, description, argNames, argDescriptions]
      .filter(Boolean)
      .join(" "),
  };
}

function summarizeInputParameters(schema: Record<string, unknown>) {
  const properties = asRecord(schema.properties);
  const required = new Set(asStringArray(schema.required));

  return Object.entries(properties)
    .map(([name, value]) => {
      const paramSchema = asRecord(value);
      return {
        name,
        required: required.has(name),
        description:
          typeof paramSchema.description === "string"
            ? paramSchema.description
            : null,
      };
    })
    .sort(
      (left, right) =>
        Number(right.required) - Number(left.required) ||
        left.name.localeCompare(right.name),
    );
}

type PreparedSearchQuery = {
  normalizedQuery: string;
  tokens: string[];
};

function prepareSearchQuery(query: string): PreparedSearchQuery {
  const normalizedQuery = normalizeText(query);
  return {
    normalizedQuery,
    tokens: normalizedQuery ? tokenize(normalizedQuery) : [],
  };
}

function scoreCandidate(
  candidate: SearchCandidate,
  query: PreparedSearchQuery,
): number {
  const { normalizedQuery, tokens } = query;
  if (!normalizedQuery) {
    return 0;
  }

  const { name, title, description, argNames, argDescriptions, combined } =
    candidate.searchText;

  let score = 0;
  if (name === normalizedQuery) score += 200;
  if (title === normalizedQuery) score += 140;
  if (name.includes(normalizedQuery)) score += 100;
  if (title.includes(normalizedQuery)) score += 80;
  if (description.includes(normalizedQuery)) score += 50;
  if (argNames.includes(normalizedQuery)) score += 40;
  if (argDescriptions.includes(normalizedQuery)) score += 20;

  for (const token of tokens) {
    if (name.includes(token)) score += 24;
    if (title.includes(token)) score += 18;
    if (description.includes(token)) score += 10;
    if (argNames.includes(token)) score += 8;
    if (argDescriptions.includes(token)) score += 4;
  }

  if (tokens.every((token) => combined.includes(token))) {
    score += 12;
  }

  return score;
}

function flattenSchemaText(schema: Record<string, unknown>): {
  names: string[];
  descriptions: string[];
} {
  const names: string[] = [];
  const descriptions: string[] = [];

  visitSchema(schema, { names, descriptions });

  return { names, descriptions };
}

function visitSchema(
  schema: Record<string, unknown>,
  state: { names: string[]; descriptions: string[] },
): void {
  if (typeof schema.description === "string") {
    state.descriptions.push(schema.description);
  }

  const properties = asRecord(schema.properties);
  for (const [name, value] of Object.entries(properties)) {
    state.names.push(name);
    visitSchema(asRecord(value), state);
  }

  if (Array.isArray(schema.anyOf)) {
    for (const entry of schema.anyOf) {
      visitSchema(asRecord(entry), state);
    }
  }

  if (Array.isArray(schema.oneOf)) {
    for (const entry of schema.oneOf) {
      visitSchema(asRecord(entry), state);
    }
  }

  if (Array.isArray(schema.allOf)) {
    for (const entry of schema.allOf) {
      visitSchema(asRecord(entry), state);
    }
  }

  const items = asRecord(schema.items);
  if (Object.keys(items).length > 0) {
    visitSchema(items, state);
  }
}

function isExcludedArchestraMetaTool(toolName: string): boolean {
  const shortName = archestraMcpBranding.getToolShortName(toolName);
  return shortName != null && EXCLUDED_SHORT_NAMES.has(shortName);
}

function formatArchestraToolTitle(toolName: string): string | null {
  const shortName = archestraMcpBranding.getToolShortName(toolName);
  if (!shortName) {
    return null;
  }

  return shortName
    .split("_")
    .filter(Boolean)
    .map((segment) => `${segment[0]?.toUpperCase() ?? ""}${segment.slice(1)}`)
    .join(" ");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function tokenize(value: string): string[] {
  return Array.from(
    new Set(value.split(/[^a-z0-9_-]+/).filter((token) => token.length > 0)),
  );
}
