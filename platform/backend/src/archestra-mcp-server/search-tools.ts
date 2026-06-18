import {
  isAlwaysExposedArchestraToolShortName,
  parseFullToolName,
  TOOL_RUN_TOOL_SHORT_NAME,
  TOOL_SEARCH_TOOLS_SHORT_NAME,
} from "@archestra/shared";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import safeRegex from "safe-regex2";
import { z } from "zod";
import logger from "@/logging";
import {
  ConversationEnabledToolModel,
  InternalMcpCatalogModel,
  ToolModel,
} from "@/models";
import { archestraMcpBranding } from "./branding";
import { isToolEnabledForConversation } from "./conversation-tool-filter";
import { getAgentTools } from "./delegation";
import { getUnassignedDiscoverableTools } from "./dynamic-tools";
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
        "Keywords describing the capability you need, e.g. 'send slack message' or 'search repositories'. Results are keyword-ranked across tool names, descriptions, and argument names/descriptions, so pass several relevant words and include the server name (e.g. 'github') to narrow results.",
      ),
    limit: z
      .number()
      .int()
      .positive()
      .max(20)
      .optional()
      .default(8)
      .describe("Maximum number of matching tools to return."),
    mode: z
      .enum(["keyword", "regex"])
      .optional()
      .default("keyword")
      .describe(
        "Search mode. 'keyword' (default) keyword-ranks the query across tool fields. 'regex' treats query as a case-insensitive regular expression matched against tool names, titles, and descriptions — use it when you know a naming pattern, e.g. '^github__' or 'search|find'.",
      ),
  })
  .strict();

const NestedParameterSchema = z.object({
  name: z.string().describe("Nested property name."),
  type: z.string().nullable().describe("JSON Schema type, if available."),
  required: z.boolean().describe("Whether the nested property is required."),
});

const InputParameterSchema = z.object({
  name: z.string().describe("Top-level input parameter name."),
  required: z.boolean().describe("Whether the parameter is required."),
  type: z
    .string()
    .nullable()
    .describe("JSON Schema type (e.g. 'string', 'number', 'object')."),
  enum: z
    .array(z.unknown())
    .nullable()
    .describe("Allowed values when the parameter is constrained by an enum."),
  description: z
    .string()
    .nullable()
    .describe("Parameter description, if available."),
  properties: z
    .array(NestedParameterSchema)
    .nullable()
    .describe(
      "One-level summary of nested properties for object (or array-of-object) parameters.",
    ),
});

type InputParameterSummary = z.infer<typeof InputParameterSchema>;
type NestedParameterSummary = z.infer<typeof NestedParameterSchema>;

// cap on enum values rendered inline in a parameter signature; the full list
// stays recoverable via run_tool validation feedback.
const PARAM_ENUM_VALUE_CAP = 20;

const SearchToolsOutputSchema = z.object({
  total: z.number().int().nonnegative().describe("Number of returned tools."),
  matchCount: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "Total tools matching the query before the limit was applied (>= total).",
    ),
  truncated: z
    .boolean()
    .describe(
      "True when matchCount exceeds the returned tools (results cut by limit).",
    ),
  hint: z
    .string()
    .nullable()
    .describe(
      "Actionable guidance when results were truncated, empty, or when some query terms matched no tool text.",
    ),
  tools: z.array(
    z.object({
      toolName: z
        .string()
        .describe(`Exact tool name to pass to ${TOOL_RUN_TOOL_SHORT_NAME}.`),
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
      params: z
        .string()
        .describe(
          "Compact one-line input signature. Parameters are joined by '; ', each rendered as " +
            "`name<!|?>:<type>` where `!` marks required and `?` optional. Object parameters are " +
            "expanded one level as `{child<!|?>:type, …}`, enums as `enum(<json-values>)`, and a " +
            "trailing ` — description` is added when available. Empty string when the tool takes " +
            `no input. Pass matching values inside tool_args when calling ${TOOL_RUN_TOOL_SHORT_NAME}.`,
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
  inputParameters: InputParameterSummary[];
  searchText: {
    name: string;
    title: string;
    description: string;
    argNames: string;
    argDescriptions: string;
  };
};

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_SEARCH_TOOLS_SHORT_NAME,
    title: "Search Tools",
    description: `Search the tools available to this agent and to you on demand. Returns exact tool names plus compact input summaries. To execute a returned tool, call ${TOOL_RUN_TOOL_SHORT_NAME} with tool_name set to the returned toolName and put target tool input parameters inside tool_args.`,
    schema: SearchToolsArgsSchema,
    outputSchema: SearchToolsOutputSchema,
    async handler({ args, context }) {
      if (!context.agentId) {
        return errorResult(
          `${TOOL_SEARCH_TOOLS_SHORT_NAME} requires agent context to inspect assigned tools`,
        );
      }

      const startedAt = Date.now();
      const searchableTools = await getSearchableTools({
        agentId: context.agentId,
        organizationId: context.organizationId,
        userId: context.userId,
        conversationId: context.conversationId,
      });

      let matches: SearchCandidate[];
      let unmatchedTerms: string[] = [];
      if (args.mode === "regex") {
        const result = rankCandidatesByRegex(searchableTools, args.query);
        if (!result.ok) {
          return errorResult(result.error);
        }
        matches = result.matches;
      } else {
        const preparedQuery = prepareSearchQuery(args.query);
        matches = rankCandidatesByKeyword(searchableTools, preparedQuery);
        unmatchedTerms = findUnmatchedQueryTerms(
          searchableTools,
          preparedQuery,
        );
      }

      const matchCount = matches.length;
      const tools = matches.slice(0, args.limit).map(toSearchResult);
      const truncated = matchCount > tools.length;
      const hint = buildSearchHint({
        matchCount,
        truncated,
        limit: args.limit,
        searchableTools,
        unmatchedTerms,
      });

      const structured = {
        total: tools.length,
        matchCount,
        truncated,
        hint,
        tools,
      };

      logger.info(
        {
          agentId: context.agentId,
          mode: args.mode,
          queryLength: args.query.length,
          matchCount,
          returned: tools.length,
          zeroResult: matchCount === 0,
          topResultName: tools[0]?.toolName ?? null,
          latencyMs: Date.now() - startedAt,
        },
        `${TOOL_SEARCH_TOOLS_SHORT_NAME} query`,
      );

      return structuredSuccessResult(
        structured,
        JSON.stringify(structured, null, 2),
      );
    },
  }),
] as const);

export const toolEntries = registry.toolEntries;
export const tools = registry.tools;

/** @public — exported for testability of the ranking logic in isolation */
export const __test = {
  prepareSearchQuery,
  rankCandidatesByKeyword,
  rankCandidatesByRegex,
  findUnmatchedQueryTerms,
  summarizeInputParameters,
  formatParamsSignature,
  makeRankingCandidate(input: {
    toolName: string;
    title?: string | null;
    description?: string | null;
    parameters?: Record<string, unknown>;
  }): SearchCandidate {
    return {
      toolName: input.toolName,
      title: input.title ?? null,
      description: input.description ?? null,
      source: "mcp",
      server: null,
      catalogName: null,
      inputParameters: [],
      searchText: buildSearchText({
        name: input.toolName,
        title: input.title ?? "",
        description: input.description ?? null,
        schema: input.parameters ?? {},
      }),
    };
  },
};

// === Internal helpers ===

async function getSearchableTools(params: {
  agentId: string;
  organizationId?: string;
  userId?: string;
  conversationId?: string;
}): Promise<SearchCandidate[]> {
  const { agentId, conversationId, organizationId, userId } = params;
  const assignedTools = await ToolModel.getMcpToolsByAgent(agentId);
  const assignedNames = new Set(assignedTools.map((tool) => tool.name));
  // Dynamic tool access: when the agent's "access all tools" setting is on,
  // discovery also spans third-party tools from every catalog the user can
  // access, the sandbox built-ins when the feature is on, and
  // query_knowledge_sources when the user can access a knowledge connector.
  // run_tool executes such a tool directly without assigning it; the MCP
  // server's connection policy decides which credential the call uses.
  const discoverableTools = await getUnassignedDiscoverableTools({
    assignedToolNames: assignedNames,
    agentId,
    userId,
    organizationId,
  });
  const searchSpace = [...assignedTools, ...discoverableTools];
  const permittedNames = await filterToolNamesByPermission(
    searchSpace.map((tool) => tool.name),
    userId,
    organizationId,
  );
  const filteredTools = searchSpace.filter(
    (tool) =>
      permittedNames.has(tool.name) &&
      !isExcludedFromSearchResults(tool.name, assignedNames) &&
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

  const catalogNamesById = await getCatalogNamesById(filteredTools);
  const candidates = new Map<string, SearchCandidate>();
  // First occurrence wins on duplicate names: assigned tools come before the
  // discoverable ones, and the discoverable set is ordered newest-first — the
  // same row resolveDynamicTool picks, so the description shown by search
  // matches the row a later run_tool call executes.
  for (const tool of filteredTools) {
    if (candidates.has(tool.name)) {
      continue;
    }
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

  // Per-conversation enabled-tool gate: in a chat with a custom tool selection,
  // a tool the user disabled must not be discoverable here either (mirrors the
  // visible tool list and the run_tool gate). Archestra built-ins always pass.
  const enabledNames =
    conversationId != null
      ? await ConversationEnabledToolModel.getEnabledToolNameSet(conversationId)
      : null;

  return Array.from(candidates.values()).filter((candidate) =>
    isToolEnabledForConversation(candidate.toolName, enabledNames),
  );
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
  };
}

function summarizeInputParameters(
  schema: Record<string, unknown>,
): InputParameterSummary[] {
  const properties = asRecord(schema.properties);
  const required = new Set(asStringArray(schema.required));

  return Object.entries(properties)
    .map(([name, value]) => {
      const paramSchema = asRecord(value);
      return {
        name,
        required: required.has(name),
        type: extractSchemaType(paramSchema),
        enum: Array.isArray(paramSchema.enum) ? paramSchema.enum : null,
        description:
          typeof paramSchema.description === "string"
            ? paramSchema.description
            : null,
        properties: summarizeNestedProperties(paramSchema),
      };
    })
    .sort(
      (left, right) =>
        Number(right.required) - Number(left.required) ||
        left.name.localeCompare(right.name),
    );
}

// JSON Schema `type` is a string ("object") or, for unions, an array
// (["string", "null"]). Collapse arrays to "a|b" so the model sees the options.
function extractSchemaType(
  paramSchema: Record<string, unknown>,
): string | null {
  const type = paramSchema.type;
  if (typeof type === "string") {
    return type;
  }
  if (Array.isArray(type)) {
    const parts = type.filter(
      (part): part is string => typeof part === "string",
    );
    return parts.length > 0 ? parts.join("|") : null;
  }
  return null;
}

// One-level nested summary for object (or array-of-object) parameters, so the
// model can call run_tool without guessing the nested shape. Intentionally does
// not recurse further — deeper structure is left to the actual call's
// validation feedback to keep results bounded.
function summarizeNestedProperties(
  paramSchema: Record<string, unknown>,
): InputParameterSummary["properties"] {
  const objectSchema = nestedObjectSchema(paramSchema);
  if (!objectSchema) {
    return null;
  }
  const properties = asRecord(objectSchema.properties);
  const required = new Set(asStringArray(objectSchema.required));

  return Object.entries(properties)
    .map(([name, value]) => {
      const nestedSchema = asRecord(value);
      return {
        name,
        type: extractSchemaType(nestedSchema),
        required: required.has(name),
      };
    })
    .sort(
      (left, right) =>
        Number(right.required) - Number(left.required) ||
        left.name.localeCompare(right.name),
    );
}

function nestedObjectSchema(
  paramSchema: Record<string, unknown>,
): Record<string, unknown> | null {
  if (Object.keys(asRecord(paramSchema.properties)).length > 0) {
    return paramSchema;
  }
  const items = asRecord(paramSchema.items);
  if (Object.keys(asRecord(items.properties)).length > 0) {
    return items;
  }
  return null;
}

type PreparedSearchQuery = {
  normalizedQuery: string;
  // unique query terms — deduped so a repeated query word does not multiply its
  // own contribution (field-side tokens keep duplicates for term frequency).
  tokens: string[];
};

function prepareSearchQuery(query: string): PreparedSearchQuery {
  const normalizedQuery = normalizeText(query);
  return {
    normalizedQuery,
    tokens: Array.from(new Set(tokenize(normalizedQuery))),
  };
}

function toSearchResult(candidate: SearchCandidate) {
  return {
    toolName: candidate.toolName,
    description: candidate.description,
    source: candidate.source,
    server: candidate.server,
    params: formatParamsSignature(candidate.inputParameters),
  };
}

// Render the structured per-tool parameter summaries as a single compact line so
// repeated search_tools calls do not accumulate verbose nested JSON in context.
// Intentionally bounded (see PARAM_ENUM_VALUE_CAP) — the full schema stays
// recoverable through run_tool's validation feedback, matching the existing
// "deeper structure is left to the actual call" design above.
function formatParamsSignature(params: InputParameterSummary[]): string {
  return params.map(formatParamSignature).join("; ");
}

function formatParamSignature(param: InputParameterSummary): string {
  const requiredMark = param.required ? "!" : "?";
  const typePart = formatParamType(param);
  const typeSuffix = typePart ? `:${typePart}` : "";
  // collapse whitespace so a multiline schema description cannot break the
  // one-line signature contract.
  const description = param.description
    ? param.description.replace(/\s+/g, " ").trim()
    : "";
  const descriptionSuffix = description ? ` — ${description}` : "";
  return `${param.name}${requiredMark}${typeSuffix}${descriptionSuffix}`;
}

// Additive: a parameter can carry a scalar type, a one-level object shape, and an
// enum constraint at once, so each present part is appended rather than replacing
// the others (e.g. `sort?:string enum("asc"|"desc")`).
function formatParamType(param: InputParameterSummary): string {
  let type = param.type ?? "";
  if (param.properties && param.properties.length > 0) {
    type += formatNestedProperties(param.properties);
  }
  if (param.enum && param.enum.length > 0) {
    const enumClause = formatEnumValues(param.enum);
    type = type ? `${type} ${enumClause}` : enumClause;
  }
  return type;
}

function formatNestedProperties(properties: NestedParameterSummary[]): string {
  const inner = properties
    .map((property) => {
      const requiredMark = property.required ? "!" : "?";
      const typeSuffix = property.type ? `:${property.type}` : "";
      return `${property.name}${requiredMark}${typeSuffix}`;
    })
    .join(", ");
  return `{${inner}}`;
}

// enum values are arbitrary JSON (number/boolean/null/object, or strings that may
// contain "|"), so JSON-encode each to keep the signature unambiguous.
function formatEnumValues(values: unknown[]): string {
  const shown = values
    .slice(0, PARAM_ENUM_VALUE_CAP)
    .map((value) => JSON.stringify(value));
  const overflow = values.length - PARAM_ENUM_VALUE_CAP;
  const suffix = overflow > 0 ? `|…(+${overflow} more)` : "";
  return `enum(${shown.join("|")}${suffix})`;
}

type RegexRankResult =
  | { ok: true; matches: SearchCandidate[] }
  | { ok: false; error: string };

// Regex search mode. Mirrors the ReDoS guard used elsewhere in the codebase
// (knowledge-base/connectors/web-crawler): compile first, then reject patterns
// safe-regex2 flags as catastrophic-backtracking risks. Matches name/title/
// description and ranks by the strongest field hit.
function rankCandidatesByRegex(
  candidates: SearchCandidate[],
  pattern: string,
): RegexRankResult {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "i");
    if (!safeRegex(regex)) {
      return {
        ok: false,
        error:
          "The regex query is too complex (possible catastrophic backtracking). Simplify the pattern or use keyword mode.",
      };
    }
  } catch {
    return {
      ok: false,
      error: `Invalid regular expression: ${pattern}. Fix the pattern or use keyword mode.`,
    };
  }

  return {
    ok: true,
    matches: candidates
      .map((candidate) => ({
        candidate,
        rank: regexMatchRank(candidate, regex),
      }))
      .filter(({ rank }) => rank > 0)
      .sort(
        (left, right) =>
          right.rank - left.rank ||
          left.candidate.toolName.localeCompare(right.candidate.toolName),
      )
      .map(({ candidate }) => candidate),
  };
}

function regexMatchRank(candidate: SearchCandidate, regex: RegExp): number {
  const { name, title, description } = candidate.searchText;
  if (regex.test(name)) {
    return 3;
  }
  if (title && regex.test(title)) {
    return 2;
  }
  if (description && regex.test(description)) {
    return 1;
  }
  return 0;
}

// Actionable next-step guidance (Anthropic recovery-error practice). Null when
// results are complete, non-empty, and every query term hit some tool text.
// Clauses compose: a vocabulary-mismatch note can ride alongside the empty- or
// truncated-result note so the model learns both what happened and which terms
// to drop or replace.
function buildSearchHint(params: {
  matchCount: number;
  truncated: boolean;
  limit: number;
  searchableTools: SearchCandidate[];
  unmatchedTerms: string[];
}): string | null {
  const { limit, matchCount, searchableTools, truncated, unmatchedTerms } =
    params;
  const parts: string[] = [];

  if (matchCount === 0) {
    const servers = availableServerNames(searchableTools);
    const serverHint =
      servers.length > 0 ? ` Available servers: ${servers.join(", ")}.` : "";
    parts.push(
      `No tools matched. Try broader or different keywords, or switch mode.${serverHint}`,
    );
  } else if (truncated) {
    parts.push(
      `Showing the top ${limit} of ${matchCount} matches. Narrow the query or raise limit (max 20).`,
    );
  }

  if (unmatchedTerms.length > 0) {
    parts.push(
      `No tool text matches these query terms: ${unmatchedTerms.join(", ")}.`,
    );
  }

  return parts.length > 0 ? parts.join(" ") : null;
}

// Query terms the ranker cannot match against any tool. The ranker has exactly
// two match surfaces: BM25 over indexed tokens across every field, and the
// whole-query substring boost over name/title. So a term is unmatched only when
// it is neither an indexed token (any field) nor a substring of any name/title.
// Both checks are necessary: the token set alone would falsely report "repo"
// (which matches github__search_repositories via the name substring boost), and
// the name/title substring check alone would miss a description-only term.
// One-sided by design — never names a term that contributed to a result; it may
// stay silent on a term that only appears inside a name/title as a substring.
function findUnmatchedQueryTerms(
  candidates: SearchCandidate[],
  query: PreparedSearchQuery,
): string[] {
  if (query.tokens.length === 0) {
    return [];
  }
  const corpusTokens = new Set<string>();
  let nameTitleText = "";
  for (const candidate of candidates) {
    const { name, title, description, argNames, argDescriptions } =
      candidate.searchText;
    for (const token of tokenize(
      `${name} ${title} ${description} ${argNames} ${argDescriptions}`,
    )) {
      corpusTokens.add(token);
    }
    nameTitleText += ` ${name} ${title}`;
  }
  return query.tokens.filter(
    (token) => !corpusTokens.has(token) && !nameTitleText.includes(token),
  );
}

const MAX_HINT_SERVERS = 10;

function availableServerNames(candidates: SearchCandidate[]): string[] {
  const names = new Set<string>();
  for (const candidate of candidates) {
    const name = candidate.catalogName ?? candidate.server;
    if (name) {
      names.add(name);
    }
  }
  const sorted = Array.from(names).sort();
  if (sorted.length <= MAX_HINT_SERVERS) {
    return sorted;
  }
  // signal truncation rather than implying the list is exhaustive
  return [...sorted.slice(0, MAX_HINT_SERVERS), "…"];
}

// BM25F keyword ranking over the per-field corpus. Field weights make a name
// hit count for more than a description hit; length normalization is disabled
// (b=0) for the short name/title fields and kept mild for the free-text fields.
// IDF uses the log(1 + …) variant so it stays strictly positive — the textbook
// BM25 IDF can go negative when a term appears in most documents, a real hazard
// on the tiny per-agent corpora this runs over. Literal whole-query name/title
// matches get a large additive boost on top so an exact tool name always wins.
const BM25F_FIELDS = [
  "name",
  "title",
  "description",
  "argNames",
  "argDescriptions",
] as const;
type Bm25Field = (typeof BM25F_FIELDS)[number];

const BM25F_FIELD_CONFIG: Record<Bm25Field, { weight: number; b: number }> = {
  name: { weight: 10, b: 0 },
  title: { weight: 6, b: 0 },
  description: { weight: 3, b: 0.75 },
  argNames: { weight: 2, b: 0.5 },
  argDescriptions: { weight: 1, b: 0.75 },
};
const BM25F_K1 = 1.5;
const EXACT_NAME_BOOST = 1000;
const NAME_SUBSTRING_BOOST = 100;
const EXACT_TITLE_BOOST = 600;
const TITLE_SUBSTRING_BOOST = 60;

type IndexedCandidate = {
  candidate: SearchCandidate;
  fieldTokens: Record<Bm25Field, string[]>;
};

type CorpusStats = {
  avgFieldLength: Record<Bm25Field, number>;
  docFrequency: Map<string, number>;
  docCount: number;
};

function rankCandidatesByKeyword(
  candidates: SearchCandidate[],
  query: PreparedSearchQuery,
): SearchCandidate[] {
  if (!query.normalizedQuery) {
    return [];
  }

  const indexed: IndexedCandidate[] = candidates.map((candidate) => ({
    candidate,
    fieldTokens: {
      name: tokenize(candidate.searchText.name),
      title: tokenize(candidate.searchText.title),
      description: tokenize(candidate.searchText.description),
      argNames: tokenize(candidate.searchText.argNames),
      argDescriptions: tokenize(candidate.searchText.argDescriptions),
    },
  }));

  const corpus: CorpusStats = {
    avgFieldLength: computeAvgFieldLength(indexed),
    docFrequency: computeDocFrequency(indexed),
    docCount: indexed.length,
  };

  return indexed
    .map((entry) => ({
      candidate: entry.candidate,
      score: scoreCandidate(entry, query, corpus),
    }))
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.candidate.toolName.localeCompare(right.candidate.toolName),
    )
    .map(({ candidate }) => candidate);
}

function computeAvgFieldLength(
  indexed: IndexedCandidate[],
): Record<Bm25Field, number> {
  const totals: Record<Bm25Field, number> = {
    name: 0,
    title: 0,
    description: 0,
    argNames: 0,
    argDescriptions: 0,
  };
  for (const entry of indexed) {
    for (const field of BM25F_FIELDS) {
      totals[field] += entry.fieldTokens[field].length;
    }
  }
  const count = indexed.length || 1;
  const averages = {} as Record<Bm25Field, number>;
  for (const field of BM25F_FIELDS) {
    averages[field] = totals[field] / count;
  }
  return averages;
}

function computeDocFrequency(indexed: IndexedCandidate[]): Map<string, number> {
  const docFrequency = new Map<string, number>();
  for (const entry of indexed) {
    const seen = new Set<string>();
    for (const field of BM25F_FIELDS) {
      for (const token of entry.fieldTokens[field]) {
        seen.add(token);
      }
    }
    for (const token of seen) {
      docFrequency.set(token, (docFrequency.get(token) ?? 0) + 1);
    }
  }
  return docFrequency;
}

function scoreCandidate(
  entry: IndexedCandidate,
  query: PreparedSearchQuery,
  corpus: CorpusStats,
): number {
  let score = bm25fScore(entry, query.tokens, corpus);

  const { name, title } = entry.candidate.searchText;
  const { normalizedQuery } = query;
  if (name === normalizedQuery) {
    score += EXACT_NAME_BOOST;
  } else if (name.includes(normalizedQuery)) {
    score += NAME_SUBSTRING_BOOST;
  }
  if (title === normalizedQuery) {
    score += EXACT_TITLE_BOOST;
  } else if (title?.includes(normalizedQuery)) {
    score += TITLE_SUBSTRING_BOOST;
  }
  return score;
}

function bm25fScore(
  entry: IndexedCandidate,
  queryTokens: string[],
  corpus: CorpusStats,
): number {
  let score = 0;
  for (const term of queryTokens) {
    const docsWithTerm = corpus.docFrequency.get(term);
    if (!docsWithTerm) {
      continue;
    }
    const idf = Math.log(
      1 + (corpus.docCount - docsWithTerm + 0.5) / (docsWithTerm + 0.5),
    );

    let weightedTf = 0;
    for (const field of BM25F_FIELDS) {
      const fieldTokens = entry.fieldTokens[field];
      const tf = countOccurrences(fieldTokens, term);
      if (tf === 0) {
        continue;
      }
      const { weight, b } = BM25F_FIELD_CONFIG[field];
      const avgLength = corpus.avgFieldLength[field] || 1;
      const normalization = 1 - b + (b * fieldTokens.length) / avgLength;
      weightedTf += (weight * tf) / normalization;
    }

    if (weightedTf > 0) {
      score += (idf * weightedTf) / (BM25F_K1 + weightedTf);
    }
  }
  return score;
}

function countOccurrences(tokens: string[], term: string): number {
  let count = 0;
  for (const token of tokens) {
    if (token === term) {
      count += 1;
    }
  }
  return count;
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

// search_tools only runs in search_and_run_only mode, where the meta tools and
// the always-exposed runtime tools (skills + sandbox + apps) are already
// top-level — returning them as results would be redundant noise. But "always-exposed" only
// holds once a tool is assigned: an unassigned sandbox tool the user can reach
// via sandbox:execute is NOT top-level, so surface it here so the model can
// discover and run it. Meta tools are never useful as results.
function isExcludedFromSearchResults(
  toolName: string,
  assignedNames: Set<string>,
): boolean {
  const shortName = archestraMcpBranding.getToolShortName(toolName);
  if (shortName == null) {
    return false;
  }
  if (
    shortName === TOOL_SEARCH_TOOLS_SHORT_NAME ||
    shortName === TOOL_RUN_TOOL_SHORT_NAME
  ) {
    return true;
  }
  if (isAlwaysExposedArchestraToolShortName(shortName)) {
    return assignedNames.has(toolName);
  }
  return false;
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

// splits identifiers into word subtokens: `github__search_repositories` ->
// ["github", "search", "repositories"]. `_`/`-` are separators (unlike the
// stored names) so snake/kebab-case tool names rank under their parts. Keeps
// duplicates — BM25 term frequency depends on them.
function tokenize(value: string): string[] {
  return value.split(/[^a-z0-9]+/).filter((token) => token.length > 0);
}
