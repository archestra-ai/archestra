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

/**
 * Maps only MCP tools explicitly declared by the client to a canonical APPA
 * identity. The model call remains execution provenance; this is separate
 * policy targeting, never a global rewrite of model-provided strings.
 */
export function collectDeclaredMcpToolTargets(
  request: unknown,
): ReadonlyMap<string, string> {
  const candidates = new Map<string, Set<string>>();
  for (const container of toolContainers(request)) {
    for (const tool of container) {
      collectMcpToolTargets(tool, candidates);
    }
  }
  const targets = new Map<string, string>();
  for (const [wireName, identities] of candidates) {
    if (identities.size === 1) {
      const [identity] = identities;
      targets.set(wireName, identity);
    }
  }
  return targets;
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

function collectMcpToolTargets(
  tool: unknown,
  candidates: Map<string, Set<string>>,
): void {
  if (!isRecord(tool)) return;
  addMcpTarget(tool.name, candidates);
  if (isRecord(tool.function)) addMcpTarget(tool.function.name, candidates);
  if (isRecord(tool.custom)) addMcpTarget(tool.custom.name, candidates);
  if (isRecord(tool.toolSpec)) addMcpTarget(tool.toolSpec.name, candidates);

  if (
    tool.type === "mcp" &&
    typeof tool.server_label === "string" &&
    Array.isArray(tool.allowed_tools)
  ) {
    for (const name of tool.allowed_tools) {
      if (typeof name !== "string") continue;
      addCandidate(
        candidates,
        `mcp__${tool.server_label}__${name}`,
        toMcpIdentity(tool.server_label, name),
      );
    }
  }

  // Responses/Codex places MCP members below a namespace declaration.
  if (tool.type === "namespace" && Array.isArray(tool.tools)) {
    const namespace = parseMcpWireName(tool.name);
    if (!namespace || namespace.tool !== undefined) return;
    for (const member of tool.tools) {
      if (!isRecord(member) || typeof member.name !== "string") continue;
      addCandidate(
        candidates,
        `mcp__${namespace.server}__${member.name}`,
        toMcpIdentity(namespace.server, member.name),
      );
    }
  }
}

function addMcpTarget(
  value: unknown,
  candidates: Map<string, Set<string>>,
): void {
  const parsed = parseMcpWireName(value);
  if (!parsed?.tool) return;
  addCandidate(
    candidates,
    value as string,
    toMcpIdentity(parsed.server, parsed.tool),
  );
}

function addCandidate(
  candidates: Map<string, Set<string>>,
  wireName: string,
  target: string | undefined,
): void {
  if (!target) return;
  const identities = candidates.get(wireName) ?? new Set<string>();
  identities.add(target);
  candidates.set(wireName, identities);
}

function parseMcpWireName(
  value: unknown,
): { server: string; tool?: string } | undefined {
  if (typeof value !== "string" || !value.startsWith("mcp__")) return;
  const rest = value.slice("mcp__".length);
  const separator = rest.indexOf("__");
  if (separator === -1) {
    return isMcpServerSegment(rest) ? { server: rest } : undefined;
  }
  const server = rest.slice(0, separator);
  const tool = rest.slice(separator + "__".length);
  return toMcpIdentity(server, tool) ? { server, tool } : undefined;
}

function toMcpIdentity(server: string, tool: string): string | undefined {
  return isMcpServerSegment(server) && isMcpToolSegment(tool)
    ? `mcp/${server}/${tool}`
    : undefined;
}

function isMcpServerSegment(value: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(value) && !value.includes("__");
}

function isMcpToolSegment(value: string): boolean {
  return /^[A-Za-z0-9_.-]+(?:__[A-Za-z0-9_.-]+)*$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
