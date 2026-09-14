/**
 * Every tool name a caller declared, read from the request body itself rather
 * than from an adapter's parsed view of it.
 *
 * The proxy decides which of the model's tool calls count as available from
 * the names the caller declared. Sourcing that from
 * `LLMRequestAdapter.getTools()` is lossy by design: that method exists to feed
 * persistence, so every adapter keeps only the schema-carrying function tools
 * it can describe and drops the rest — Anthropic's `bash`/`text_editor`
 * built-ins, OpenAI chat `custom` tools, every non-function tool on the
 * Responses surface. The caller executes those itself, so dropping them refuses
 * calls it explicitly asked for, and the refusal tells the model to stop
 * trying.
 *
 * Reading the body keeps that correct for every provider at once, including
 * ones added later: there is no per-adapter method to forget to implement, so a
 * new adapter cannot silently reintroduce the refusal. Only the container and
 * item shapes differ between providers, and they are enumerated below.
 *
 * This is deliberately permissive about *which* names it counts. A name here
 * only ever makes a tool reachable, and everything it admits is something the
 * caller put in its own request — the tools the guardrail exists to refuse are
 * the ones absent from that request, and they stay absent.
 */
export function collectDeclaredToolNames(request: unknown): string[] {
  const names: string[] = [];
  for (const container of toolContainers(request)) {
    for (const tool of container) {
      collectToolNames(tool, names);
    }
  }
  return names;
}

// === Internal helpers ===

/**
 * The arrays a request keeps its tool declarations in: `tools` for nearly
 * everyone, plus Bedrock Converse's `toolConfig.tools`.
 */
function toolContainers(request: unknown): unknown[][] {
  if (!isRecord(request)) {
    return [];
  }

  const containers: unknown[][] = [];
  const add = (value: unknown) => {
    if (Array.isArray(value)) {
      containers.push(value);
    } else if (isRecord(value)) {
      // Gemini accepts a lone tool object anywhere it accepts an array.
      containers.push([value]);
    }
  };

  add(request.tools);
  if (isRecord(request.toolConfig)) {
    add(request.toolConfig.tools);
  }
  return containers;
}

function collectToolNames(tool: unknown, names: string[]): void {
  if (!isRecord(tool)) {
    return;
  }

  // Anthropic (custom tools and built-ins alike), OpenAI Responses.
  addName(tool.name, names);
  // OpenAI chat completions and every OpenAI-compatible provider.
  addNestedName(tool.function, names);
  // OpenAI chat completions freeform custom tools.
  addNestedName(tool.custom, names);
  // Bedrock Converse.
  addNestedName(tool.toolSpec, names);

  // Gemini groups its declarations under a single tool entry.
  if (Array.isArray(tool.functionDeclarations)) {
    for (const declaration of tool.functionDeclarations) {
      if (isRecord(declaration)) {
        addName(declaration.name, names);
      }
    }
  }
}

function addNestedName(value: unknown, names: string[]): void {
  if (isRecord(value)) {
    addName(value.name, names);
  }
}

/**
 * An entry with no usable name must not land in the set: nothing a model can
 * call would match it, and it would make an otherwise-empty set look populated
 * — which turns the check on and refuses everything else the caller declared.
 */
function addName(name: unknown, names: string[]): void {
  if (typeof name === "string" && name !== "") {
    names.push(name);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
