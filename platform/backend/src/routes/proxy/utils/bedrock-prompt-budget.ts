import { getTokenizer } from "@/tokenizers";

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

function addText(parts: string[], value: unknown): void {
  if (typeof value === "string") parts.push(value);
}

/** Count text and structured tool payloads; binary media have no safe local estimate. */
export function estimateBedrockPromptTokens(
  request: unknown,
  modelId: string,
): number {
  const body = record(request);
  if (!body) return 0;
  const parts: string[] = [];

  for (const block of Array.isArray(body.system) ? body.system : []) {
    addText(parts, record(block)?.text);
  }
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    const content = record(message)?.content;
    for (const block of Array.isArray(content) ? content : []) {
      const item = record(block);
      if (!item) continue;
      addText(parts, item.text);
      const toolUse = record(item.toolUse);
      if (toolUse) {
        addText(parts, toolUse.name);
        if (toolUse.input !== undefined)
          parts.push(JSON.stringify(toolUse.input));
      }
      const toolResultContent = record(item.toolResult)?.content;
      for (const result of Array.isArray(toolResultContent)
        ? toolResultContent
        : []) {
        const value = record(result);
        addText(parts, value?.text);
        if (value?.json !== undefined) parts.push(JSON.stringify(value.json));
      }
    }
  }
  const tools = record(body.toolConfig)?.tools;
  for (const tool of Array.isArray(tools) ? tools : []) {
    const spec = record(record(tool)?.toolSpec);
    addText(parts, spec?.name);
    addText(parts, spec?.description);
    const schema = record(spec?.inputSchema)?.json;
    if (schema !== undefined) parts.push(JSON.stringify(schema));
  }

  const tokenizer = getTokenizer("bedrock", modelId);
  return parts.reduce(
    (sum, content) => sum + tokenizer.countTokens({ role: "user", content }),
    0,
  );
}

/** Leave room for tokenizer variance, wire overhead, and the model's output. */
export function isBedrockPromptOverBudget(
  request: unknown,
  modelId: string,
  contextLength: number | null | undefined,
): boolean {
  if (!contextLength || contextLength <= 0) return false;
  return (
    estimateBedrockPromptTokens(request, modelId) >
    Math.floor(contextLength * 0.85)
  );
}
