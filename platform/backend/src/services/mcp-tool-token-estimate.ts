import { getTokenizer } from "@/tokenizers";

type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

/** Estimates the definitions a connected client receives, including gateway markers. */
export function estimateMcpToolTokens(params: {
  tools: McpToolDefinition[];
  client: "claude-code" | "generic";
  serverName: string;
}): number[] {
  const { tools, client, serverName } = params;
  if (tools.length === 0) return [];

  if (client === "generic") {
    const tokenizer = getTokenizer("openai");
    return tools.map((tool) =>
      tokenizer.countTokens({
        role: "user",
        content: JSON.stringify({
          name: tool.name,
          description: tool.description ?? "",
          input_schema: tool.inputSchema,
        }),
      }),
    );
  }

  // Claude Code 2.1.295 falls back to round(JSON.stringify(tools).length / 2)
  // when /context cannot count through the provider. Its MCP category removes
  // the fixed tool overhead. Model counting and client overrides can differ.
  let characters = 2; // The complete array's opening and closing brackets.
  let previousTokens = 0;
  return buildClaudeMcpToolDefinitions({ tools, serverName }).map(
    (definition, index) => {
      characters += JSON.stringify(definition).length + (index > 0 ? 1 : 0);
      const cumulativeTokens = Math.round(characters / 2);
      const tokens = cumulativeTokens - previousTokens;
      previousTokens = cumulativeTokens;
      return tokens;
    },
  );
}

/** The complete default Claude representation, before proxy marker cleanup. */
export function buildClaudeMcpToolDefinitions(params: {
  tools: McpToolDefinition[];
  serverName: string;
}) {
  return params.tools.map((tool) => ({
    name: `mcp__${sanitizeName(params.serverName)}__${sanitizeName(normalizeClaudeString(tool.name))}`,
    description: claudeDescription(
      normalizeClaudeString(tool.description ?? ""),
    ),
    input_schema: claudeInputSchema(tool.inputSchema),
  }));
}

function claudeInputSchema(inputSchema: Record<string, unknown>) {
  // Claude 2.1.295's MCP parser emits these root fields before passthrough keys.
  // Nested schema order remains significant to the exact provider fingerprint.
  const { $schema, type, ...rest } = inputSchema;
  return normalizeClaudeObject({
    ...(Object.hasOwn(inputSchema, "$schema") ? { $schema } : {}),
    ...(Object.hasOwn(inputSchema, "type") ? { type } : {}),
    ...rest,
  });
}

function normalizeClaudeObject(value: Record<string, unknown>) {
  const entries: [string, unknown][] = [];
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = normalizeClaudeString(key);
    if (normalizedKey !== "__proto__")
      entries.push([normalizedKey, normalizeClaudeValue(item)]);
  }
  return Object.fromEntries(entries);
}

function normalizeClaudeValue(value: unknown): unknown {
  if (typeof value === "string") return normalizeClaudeString(value);
  if (Array.isArray(value)) return value.map(normalizeClaudeValue);
  if (typeof value === "object" && value !== null)
    return normalizeClaudeObject(value as Record<string, unknown>);
  return value;
}

function normalizeClaudeString(value: string): string {
  if (!/[\u0080-\uFFFF]/.test(value)) return value;
  // Match Claude's MCP intake before description clipping, including stabilization
  // when removing an invisible character makes adjacent characters composable.
  for (let iteration = 0; iteration < 10; iteration++) {
    const normalized = value
      .normalize("NFKC")
      .replace(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
        "",
      )
      .replace(/[\p{Cf}\p{Co}\p{Cn}]/gu, "");
    if (normalized === value) return value;
    value = normalized;
  }
  return value;
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function claudeDescription(description: string): string {
  // Claude's default; CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH can override it.
  const limit = 2048;
  if (description.length <= limit) return description;
  const lastCodeUnit = description.charCodeAt(limit - 1);
  const end =
    lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff ? limit - 1 : limit;
  return `${description.slice(0, end)}… [truncated]`;
}
