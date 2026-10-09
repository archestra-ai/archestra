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

  // Claude Code 2.1.292 falls back to round(JSON.stringify(tools).length / 2)
  // when /context cannot count through the provider. Its MCP category removes
  // the fixed tool overhead. Model counting and client overrides can differ.
  let characters = 2; // The complete array's opening and closing brackets.
  let previousTokens = 0;
  return tools.map((tool, index) => {
    const definition = {
      name: `mcp__${sanitizeName(serverName)}__${sanitizeName(tool.name)}`,
      description: claudeDescription(tool.description ?? ""),
      input_schema: tool.inputSchema,
    };
    characters += JSON.stringify(definition).length + (index > 0 ? 1 : 0);
    const cumulativeTokens = Math.round(characters / 2);
    const tokens = cumulativeTokens - previousTokens;
    previousTokens = cumulativeTokens;
    return tokens;
  });
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
