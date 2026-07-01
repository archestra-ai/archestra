import {
  type ArchestraToolFullName,
  type ArchestraToolShortName,
  getArchestraToolFullName,
  type McpToolError,
} from "@archestra/shared";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ZodError, type ZodType, z } from "zod";
import logger from "@/logging";
import {
  AgentModel,
  AgentToolModel,
  InternalMcpCatalogModel,
  McpServerModel,
  ToolModel,
} from "@/models";
import { assignToolToAgent } from "@/services/agent-tool-assignment";
import type { ArchestraContext } from "./types";

export function isAbortLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error.name === "AbortError") {
    return true;
  }

  // Match "aborted" as a whole word to avoid false positives
  // (e.g., "aborting transaction due to constraint violation")
  return /\baborted?\b/i.test(error.message);
}

type SubAgentResult = { id: string; status: string };
export interface ToolAssignmentInput {
  /** Exact tool ID to assign to the target agent. */
  toolId: string;
  /**
   * Preferred late-bound mode for builder flows.
   * When true, credentials and execution target are resolved at tool call time.
   */
  resolveAtCallTime?: boolean;
  /** Static assignments pin the tool to one installed MCP server. */
  mcpServerId?: string | null;
}
type ToolAssignmentResult = {
  toolId: string;
  status: string;
  error?: string;
};
type ArchestraToolHandler<TSchema extends ZodType = ZodType> = (params: {
  args: z.infer<TSchema>;
  context: ArchestraContext;
  toolName: string;
}) => Promise<CallToolResult>;

type ArchestraToolDefinition<
  ShortName extends ArchestraToolShortName = ArchestraToolShortName,
  TSchema extends ZodType = ZodType,
> = {
  shortName: ShortName;
  title: string;
  description: string;
  schema: TSchema;
  outputSchema?: ZodType;
  handler: ArchestraToolHandler<TSchema>;
  invoke: ArchestraToolHandler;
};

export type ArchestraRuntimeToolEntry = {
  schema: ZodType;
  outputSchema?: ZodType | undefined;
  invoke: (params: {
    args: unknown;
    context: ArchestraContext;
    toolName: string;
  }) => Promise<CallToolResult>;
};

type ArchestraToolDefinitionInput<
  ShortName extends ArchestraToolShortName = ArchestraToolShortName,
  TSchema extends ZodType = ZodType,
> = Omit<ArchestraToolDefinition<ShortName, TSchema>, "invoke">;

export const EmptyToolArgsSchema = z.strictObject({});

export async function assignToolAssignments(
  agentId: string,
  assignments: ToolAssignmentInput[],
): Promise<ToolAssignmentResult[]> {
  const results: ToolAssignmentResult[] = [];
  const preFetchedData = await buildAgentToolAssignmentPrefetch({
    agentId,
    assignments,
  });

  for (const assignment of assignments) {
    try {
      const result = await assignToolToAgent({
        agentId,
        toolId: assignment.toolId,
        resolveAtCallTime: assignment.resolveAtCallTime,
        mcpServerId: assignment.mcpServerId,
        preFetchedData,
      });

      if (result === null || result === "updated") {
        results.push({ toolId: assignment.toolId, status: "success" });
        continue;
      }

      if (result === "duplicate") {
        results.push({ toolId: assignment.toolId, status: "duplicate" });
        continue;
      }

      results.push({
        toolId: assignment.toolId,
        status: "error",
        error: result.error.message,
      });
    } catch (error) {
      logger.error(
        { err: error, toolId: assignment.toolId },
        "Error assigning tool to agent",
      );
      results.push({
        toolId: assignment.toolId,
        status: "error",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  return results;
}

export async function assignSubAgentDelegations(
  agentId: string,
  subAgentIds: string[],
): Promise<SubAgentResult[]> {
  const results: SubAgentResult[] = [];
  for (const subAgentId of subAgentIds) {
    try {
      const targetAgent = await AgentModel.findById(subAgentId);
      if (!targetAgent) {
        results.push({ id: subAgentId, status: "not_found" });
        continue;
      }
      if (targetAgent.agentType !== "agent") {
        results.push({ id: subAgentId, status: "invalid_target" });
        continue;
      }
      if (subAgentId === agentId) {
        results.push({ id: subAgentId, status: "self_delegation_blocked" });
        continue;
      }
      await AgentToolModel.assignDelegation(agentId, subAgentId);
      results.push({ id: subAgentId, status: "success" });
    } catch (error) {
      logger.error(
        { err: error, subAgentId },
        "Error assigning sub-agent delegation",
      );
      results.push({ id: subAgentId, status: "error" });
    }
  }
  return results;
}

export function formatAssignmentSummary(
  lines: string[],
  subAgentResults: SubAgentResult[],
  toolAssignmentResults: ToolAssignmentResult[] = [],
): void {
  if (subAgentResults.length > 0) {
    lines.push(
      "",
      "Sub-Agent Delegations:",
      ...subAgentResults.map((r) => `  - ${r.id}: ${r.status}`),
    );
  }
  if (toolAssignmentResults.length > 0) {
    lines.push(
      "",
      "Tool Assignments:",
      ...toolAssignmentResults.map(
        (r) => `  - ${r.toolId}: ${r.status}${r.error ? ` - ${r.error}` : ""}`,
      ),
    );
  }
}

export function deduplicateLabels(
  rawLabels: Array<{ key: string; value: string }>,
): Array<{ key: string; value: string }> {
  return Array.from(new Map(rawLabels.map((l) => [l.key, l])).values());
}

export function successResult(text: string): CallToolResult {
  return {
    content: [{ type: "text" as const, text }],
    isError: false,
  };
}

export function structuredSuccessResult(
  structuredContent: Record<string, unknown>,
  text = JSON.stringify(structuredContent, null, 2),
): CallToolResult {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent,
    isError: false,
  };
}

export function structuredToolErrorResult(params: {
  error: McpToolError;
  text?: string;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}): CallToolResult {
  // Keep the structured error in both MCP-native fields and text content:
  // clients may see only streamed text, persisted output, or structured content.
  const structuredContent = {
    ...params.structuredContent,
    archestraError: params.error,
  };

  return {
    content: [
      {
        type: "text" as const,
        text: params.text ?? `Error: ${params.error.message}`,
      },
    ],
    structuredContent,
    _meta: {
      archestraError: params.error,
    },
    isError: params.isError ?? true,
  };
}

function createToolDefinition(params: {
  name: string;
  title: string;
  description: string;
  schema: ZodType;
  outputSchema?: ZodType;
}): Tool {
  return {
    name: params.name,
    title: params.title,
    description: params.description,
    inputSchema: z.toJSONSchema(params.schema, {
      io: "input",
    }) as Tool["inputSchema"],
    ...(params.outputSchema
      ? {
          outputSchema: z.toJSONSchema(params.outputSchema, {
            io: "output",
          }) as Tool["outputSchema"],
        }
      : {}),
    annotations: {},
    _meta: {},
  };
}

export function defineArchestraTool<
  const ShortName extends ArchestraToolShortName,
  const TSchema extends ZodType,
  const TOutputSchema extends ZodType | undefined = undefined,
>(definition: {
  shortName: ShortName;
  title: string;
  description: string;
  schema: TSchema;
  outputSchema?: TOutputSchema;
  handler: ArchestraToolHandler<TSchema>;
}): ArchestraToolDefinition<ShortName, TSchema> & {
  outputSchema?: TOutputSchema;
} {
  return {
    ...definition,
    invoke: definition.handler as unknown as ArchestraToolHandler,
  };
}

export function defineArchestraTools<
  const Definitions extends readonly ArchestraToolDefinitionInput[],
>(definitions: Definitions) {
  type ShortName = Definitions[number]["shortName"];
  type FullName<Name extends ArchestraToolShortName> =
    ArchestraToolFullName<Name>;

  const toolShortNames = definitions.map(
    (definition) => definition.shortName,
  ) as {
    [Index in keyof Definitions]: Definitions[Index]["shortName"];
  };

  const toolFullNames: Record<string, string> = {};
  const toolArgsSchemas: Record<string, ZodType> = {};
  const toolOutputSchemas: Record<string, ZodType> = {};
  const toolEntries: Record<string, ArchestraRuntimeToolEntry> = {};

  for (const definition of definitions) {
    const shortName = definition.shortName as ShortName;
    const fullName = getArchestraToolFullName(
      definition.shortName,
    ) as FullName<ShortName>;

    toolFullNames[shortName] = fullName;
    toolArgsSchemas[fullName] = definition.schema;
    if (definition.outputSchema) {
      toolOutputSchemas[fullName] = definition.outputSchema;
    }
    toolEntries[fullName] = {
      schema: definition.schema,
      outputSchema: definition.outputSchema,
      invoke:
        (definition as Partial<ArchestraToolDefinition>).invoke ??
        (definition.handler as unknown as ArchestraToolHandler),
    };
  }

  const tools = definitions.map((definition) =>
    createToolDefinition({
      name: toolFullNames[definition.shortName as ShortName],
      title: definition.title,
      description: definition.description,
      schema: definition.schema,
      outputSchema: definition.outputSchema,
    }),
  );

  return {
    toolShortNames,
    toolFullNames: toolFullNames as {
      [Definition in Definitions[number] as Definition["shortName"]]: FullName<
        Definition["shortName"]
      >;
    },
    toolArgsSchemas: toolArgsSchemas as {
      [Definition in Definitions[number] as FullName<
        Definition["shortName"]
      >]: Definition["schema"];
    },
    toolOutputSchemas: toolOutputSchemas as Partial<
      Record<FullName<ShortName>, ZodType>
    >,
    toolEntries: toolEntries as {
      [Definition in Definitions[number] as FullName<
        Definition["shortName"]
      >]: {
        schema: Definition["schema"];
        outputSchema: Definition["outputSchema"];
        invoke: ArchestraRuntimeToolEntry["invoke"];
      };
    },
    tools,
  };
}

export function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

export function catchError(error: unknown, action: string): CallToolResult {
  logger.error({ err: error }, `Error ${action}`);
  // Zod validation errors are safe to surface — they describe user input issues.
  if (error instanceof ZodError) {
    return errorResult(
      `Validation error while ${action}: ${formatZodError(error)}`,
    );
  }
  // Unique constraint violations are user-actionable (e.g., duplicate name).
  if (isUniqueConstraintError(error)) {
    return errorResult(
      `A record with the same value already exists (${action})`,
    );
  }
  // All other errors get a generic message to avoid leaking internal details.
  return errorResult(`An internal error occurred while ${action}`);
}

// === Internal helpers ===

async function buildAgentToolAssignmentPrefetch(params: {
  agentId: string;
  assignments: ToolAssignmentInput[];
}) {
  const { agentId, assignments } = params;
  const uniqueToolIds = [
    ...new Set(assignments.map((assignment) => assignment.toolId)),
  ];
  const tools = await ToolModel.getByIds(uniqueToolIds);
  const toolsMap = new Map(tools.map((tool) => [tool.id, tool]));

  const uniqueCatalogIds = [
    ...new Set(
      tools
        .map((tool) => tool.catalogId)
        .filter((catalogId): catalogId is string => catalogId != null),
    ),
  ];
  const catalogItemsMap =
    uniqueCatalogIds.length > 0
      ? await InternalMcpCatalogModel.getByIds(uniqueCatalogIds)
      : new Map();

  const uniqueMcpServerIds = [
    ...new Set(
      assignments
        .map((assignment) => assignment.mcpServerId)
        .filter((id): id is string => id != null),
    ),
  ];
  const mcpServersBasicMap = new Map();
  if (uniqueMcpServerIds.length > 0) {
    const servers = await McpServerModel.findByIdsBasic(uniqueMcpServerIds);
    for (const server of servers) {
      mcpServersBasicMap.set(server.id, server);
    }
  }

  return {
    existingAgentIds: new Set([agentId]),
    toolsMap,
    catalogItemsMap,
    mcpServersBasicMap,
  };
}

export function formatZodError(error: ZodError): string {
  return error.issues.map(formatZodIssue).join("; ");
}

/**
 * Like {@link formatZodError}, but uses the validating schema to enrich two
 * issue classes that otherwise leave a model no way to recover:
 *  - a missing/invalid discriminated-union discriminator renders as the opaque
 *    "type: Invalid input"; with the schema in hand we enumerate the allowed
 *    values, e.g. `source.type: set "type" to one of: "base64", "text"`;
 *  - an unrecognized key on a strict object renders as `Unrecognized key:
 *    "timeout"` without naming the keys that ARE accepted; we list them and
 *    suggest the closest match, e.g.
 *    `unrecognized key "timeout" — did you mean "timeoutSeconds"? ...`.
 * Best-effort: every introspection step is guarded, so any shape we cannot read
 * falls back to the plain message rather than throwing.
 */
export function formatZodErrorWithSchema(
  error: ZodError,
  schema: ZodType,
): string {
  return error.issues
    .map((issue) => {
      const enriched =
        enumerateDiscriminatorValues(issue, schema) ??
        enumerateUnknownKeys(issue, schema);
      if (!enriched) {
        return formatZodIssue(issue);
      }
      const path = formatIssuePath(issue.path);
      return path ? `${path}: ${enriched}` : enriched;
    })
    .join("; ");
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // PostgreSQL unique_violation code
  return "code" in error && (error as { code: string }).code === "23505";
}

function formatZodIssue(issue: z.core.$ZodIssue): string {
  const path = formatIssuePath(issue.path);
  return path ? `${path}: ${issue.message}` : issue.message;
}

// minimal view over the Zod v4 schema internals (`.def`) we read to enumerate a
// discriminated union's allowed discriminator values. accessed defensively — an
// absent field just ends the walk.
interface ZodDefView {
  innerType?: ZodType;
  element?: ZodType;
  shape?: Record<string, ZodType>;
  discriminator?: string;
  options?: ZodType[];
  values?: unknown[];
}

function defOf(schema: ZodType): ZodDefView | undefined {
  const def = (schema as { def?: unknown }).def;
  return def && typeof def === "object" ? (def as ZodDefView) : undefined;
}

/** Peel optional/nullable/default/readonly wrappers to the inner schema. */
function unwrapSchema(schema: ZodType): ZodType {
  let current = schema;
  // bounded to avoid spinning on an unexpected self-referential def.
  for (let depth = 0; depth < 16; depth++) {
    const inner = defOf(current)?.innerType;
    if (!inner) break;
    current = inner;
  }
  return current;
}

// Walk a schema down an issue path (object keys, array indices) or bail. Only
// object/array containers are traversed; a path that descends through a union's
// variants (a discriminated union nested inside another union's option) returns
// null and the caller falls back to the plain message. No such schema exists in
// the tool surface today, and the fallback is graceful (never throws).
function navigateSchema(root: ZodType, path: PropertyKey[]): ZodType | null {
  let current = unwrapSchema(root);
  for (const segment of path) {
    const def = defOf(current);
    if (!def) return null;
    if (typeof segment === "string" && def.shape?.[segment]) {
      current = unwrapSchema(def.shape[segment]);
    } else if (typeof segment === "number" && def.element) {
      current = unwrapSchema(def.element);
    } else {
      return null;
    }
  }
  return current;
}

/**
 * For a discriminated-union `invalid_union` issue, resolve the allowed
 * discriminator values from the schema and render a recovery hint, or null when
 * the issue is unrelated or the schema cannot be introspected.
 */
function enumerateDiscriminatorValues(
  issue: z.core.$ZodIssue,
  root: ZodType,
): string | null {
  if (issue.code !== "invalid_union") return null;
  const discriminator = (issue as { discriminator?: unknown }).discriminator;
  if (typeof discriminator !== "string") return null;

  const path = issue.path ?? [];
  // the issue points at the discriminator field inside the union; the union
  // itself is one level up.
  if (path[path.length - 1] !== discriminator) return null;
  const union = navigateSchema(root, path.slice(0, -1));
  const def = union ? defOf(union) : undefined;
  if (
    !def ||
    def.discriminator !== discriminator ||
    !Array.isArray(def.options)
  )
    return null;

  const values: string[] = [];
  for (const option of def.options) {
    const field = defOf(unwrapSchema(option))?.shape?.[discriminator];
    const literals = field ? defOf(unwrapSchema(field))?.values : undefined;
    // each option must declare its discriminator as a renderable literal; a
    // z.enum (which uses `entries`, not `values`) or anything exotic makes the
    // menu incomplete, so bail to the plain message rather than mislead.
    if (!Array.isArray(literals) || literals.length === 0) return null;
    for (const value of literals) {
      if (!isRenderableLiteral(value)) return null;
      values.push(typeof value === "string" ? `"${value}"` : String(value));
    }
  }
  if (values.length === 0) return null;
  return `set "${discriminator}" to one of: ${values.join(", ")}`;
}

function isRenderableLiteral(
  value: unknown,
): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/**
 * For an `unrecognized_keys` issue on a strict object, list the keys the object
 * DOES accept and suggest the closest match per rejected key, or null when the
 * issue is unrelated or the object schema cannot be introspected (e.g. the bad
 * key sits inside a discriminated-union variant {@link navigateSchema} declines
 * to traverse). The issue carries every rejected key in one `keys` array.
 */
function enumerateUnknownKeys(
  issue: z.core.$ZodIssue,
  root: ZodType,
): string | null {
  if (issue.code !== "unrecognized_keys") return null;
  const badKeys = (issue as { keys?: unknown }).keys;
  if (!Array.isArray(badKeys) || badKeys.length === 0) return null;

  const container = navigateSchema(root, issue.path ?? []);
  const shape = container ? defOf(container)?.shape : undefined;
  if (!shape) return null;
  const validKeys = Object.keys(shape);
  if (validKeys.length === 0) return null;

  const rendered = badKeys.map((key) => {
    const name = String(key);
    const suggestion = suggestClosestKey(name, validKeys);
    return suggestion
      ? `"${name}" (did you mean "${suggestion}"?)`
      : `"${name}"`;
  });
  const noun = rendered.length === 1 ? "key" : "keys";
  const allowed = validKeys.map((key) => `"${key}"`).join(", ");
  return `unrecognized ${noun} ${rendered.join(", ")} — valid keys are ${allowed}`;
}

/**
 * Closest accepted key for a rejected one, or null when nothing is close.
 * Substring containment is checked first so a truncated/extended name like
 * `timeout` → `timeoutSeconds` matches (their edit distance is large); a small
 * edit distance then catches ordinary typos. Edit-distance matching is gated on
 * a minimum length: on very short keys (`cwd`, `env`) a one-character distance
 * is mostly coincidence (`cmd` is as near `cwd` as `command`), so we skip it and
 * let the always-shown valid-keys list guide instead of a misleading guess.
 */
function suggestClosestKey(badKey: string, validKeys: string[]): string | null {
  const lower = badKey.toLowerCase();
  let best: { key: string; score: number } | null = null;
  for (const key of validKeys) {
    const candidate = key.toLowerCase();
    let score: number | null = null;
    if (candidate.includes(lower) || lower.includes(candidate)) {
      score = Math.abs(candidate.length - lower.length);
    } else if (Math.min(lower.length, candidate.length) >= 4) {
      const distance = levenshtein(lower, candidate);
      if (distance <= 2) score = 10 + distance;
    }
    if (score !== null && (!best || score < best.score)) {
      best = { key, score };
    }
  }
  return best?.key ?? null;
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
}

function formatIssuePath(path: PropertyKey[] | undefined): string {
  if (!path || path.length === 0) {
    return "";
  }

  return path
    .map((segment, index) => {
      if (typeof segment === "number") {
        return `[${segment}]`;
      }

      const key = String(segment);
      return index === 0 ? key : `.${key}`;
    })
    .join("");
}
