/**
 * Prepares an OpenAPPA request before provider dispatch:
 * 1. Restores denial notices in conversation history back to original calls.
 * 2. Resolves session APPA tools and validates safety guardrails (failing closed).
 */
import {
  type ArchestraToolShortName,
  TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
  TOOL_GET_REMEDY_PLANS_SHORT_NAME,
} from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { ApiError } from "@/types";
import {
  type AppaSessionIdentity,
  type AppaWireFamily,
  appaTurnBoundaries,
  appaWireFamily,
  declaredToolName,
  declaredToolNamespaces,
  declaredTools,
  providerHostedTool,
  restoreAppaNotices,
  restoreAppaRemedyExecutions,
  stripAppaTools,
} from "./wire";

export type AppaRequestTools = {
  /** This session's spelling of the control tool. */
  controlToolName: string;
  /** This session's spelling of the denial notice tool. */
  noticeToolName: string;
};

export type AppaPreparedRequest = {
  /** Absent when the request declares no tools, which opens no root. */
  tools: AppaRequestTools | undefined;
  /** Presentation only, not proof that the current request can call a tool. */
  historicalControlToolName?: string;
  /** This client's own session identity, read off its request. */
  session: AppaSessionIdentity;
  /** Tools this client declared as free-form custom tools. */
  customTools: ReadonlySet<string>;
  /** Tool name → the namespace this client declared it in (Codex). */
  namespaces: ReadonlyMap<string, string>;
  /** Canonical tool name → the spelling this client declared for it. */
  spellings: ReadonlyMap<string, string>;
  promptOperationId?: string;
  turnEndOperationId?: string;
};

/**
 * Restores this request's denial notices and resolves its APPA tools.
 *
 * Restoration runs even for a request that declares no tools — OpenCode's title
 * generation, a summarizer — because those still carry the conversation's
 * history and must show the provider what really happened.
 */
export function prepareAppaRequest(params: {
  body: unknown;
  interactionType: string;
  /** This client's session identity, as `appaSessionIdentity` read it. */
  session?: AppaSessionIdentity;
  canonicalizeToolName: (name: string) => string;
}): AppaPreparedRequest {
  // A wire family this proxy cannot restore notices on — Gemini, Bedrock,
  // Cohere, native Ollama — is governed in part rather than refused: calls
  // and results are still ruled on, but a notice stays in the history as the
  // notice call the client ran, and no turn accounting runs.
  const family = appaWireFamily(params.interactionType);
  const declared = declaredTools(params.body);
  if (params.interactionType === "azure:responses" && declared.length > 0) {
    throw new ApiError(
      400,
      "OpenAPPA cannot govern tool traffic over Azure Responses. Use Azure Chat Completions or disable OpenAPPA for this client.",
    );
  }
  let historicalControlToolName: string | undefined;
  const session = params.session ?? {
    provenance: "none" as const,
  };
  if (family) {
    historicalControlToolName = restoreAppaRemedyExecutions({
      family,
      body: params.body,
      allowHistoricalControl: declared.length === 0,
      // Current declarations bind live controls. Without declarations, only a
      // typed record bound to the same call and arguments can restore history.
      isControlTool: (name) =>
        shortToolName(params.canonicalizeToolName(name)) ===
        TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
    });
    restoreAppaNotices({
      family,
      body: params.body,
      isNoticeTool: (name) =>
        shortToolName(params.canonicalizeToolName(name)) ===
        TOOL_GET_REMEDY_PLANS_SHORT_NAME,
      // A client decorates the gateway's tools with a label of its own, and a
      // request that declares no tools gives the canonicalizer nothing to learn
      // that label from. Spelling alone is enough to *try* a call, because a
      // notice proves itself by its own record; one that does not is left alone.
      mayBeNoticeTool: (name) => NOTICE_TOOL_SPELLING.test(name),
    });
  }

  // No declared tools, no root: nothing can be proposed, so nothing is gated.
  if (declared.length === 0) {
    return {
      tools: undefined,
      ...(historicalControlToolName ? { historicalControlToolName } : {}),
      session,
      spellings: new Map(),
      customTools: new Set(),
      namespaces: new Map(),
    };
  }
  if (family) refuseCodexCodeMode({ family, declared, body: params.body });
  refuseProviderHostedTools(declared);
  refuseDeferredTools(declared);

  const found = new Map<string, string>();
  const spellings = new Map<string, string>();
  const customTools = new Set<string>();
  for (const tool of declared) {
    const name = declaredToolName(tool);
    if (name === undefined) {
      // A tool this proxy cannot name is a tool it cannot gate or render.
      throw new ApiError(
        400,
        "OpenAPPA cannot govern a tool declared without a name; remove it or disable OpenAPPA for this client",
      );
    }
    if (asToolDeclaration(tool)?.type === "custom") customTools.add(name);
    const canonical = params.canonicalizeToolName(name);
    spellings.set(canonical, name);
    // Built-in status comes from the strict anchor alone: a decorated name
    // counts only under a label the canonicalizer ties to one of this
    // organization's gateways. A lookalike under any other label stays a
    // foreign tool, which is what keeps a hostile MCP server from naming a
    // tool of its own into the control tool.
    const short =
      shortToolName(canonical) ??
      anchoredLabelShort(name, params.canonicalizeToolName);
    if (short) spellings.set(archestraMcpBranding.getToolName(short), name);
    if (
      short === TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME ||
      short === TOOL_GET_REMEDY_PLANS_SHORT_NAME
    ) {
      if (customTools.has(name)) {
        throw new ApiError(
          400,
          "OpenAPPA control tools require structured function arguments, not free-form custom input",
        );
      }
      // One declaration each. A second spelling of the same tool leaves the
      // session ambiguous about which name to render and which call to trust.
      const first = found.get(short);
      if (first !== undefined && first !== name) {
        throw new ApiError(
          400,
          `OpenAPPA needs exactly one declaration of ${short}; this request declares both ${first} and ${name}. Connect this client to one gateway of this platform at a time.`,
        );
      }
      found.set(short, name);
    }
  }

  const controlToolName = found.get(TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME);
  const noticeToolName = found.get(TOOL_GET_REMEDY_PLANS_SHORT_NAME);
  if (!controlToolName || !noticeToolName) {
    const missing = [
      controlToolName ? undefined : TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
      noticeToolName ? undefined : TOOL_GET_REMEDY_PLANS_SHORT_NAME,
    ].filter((name): name is string => name !== undefined);
    throw new ApiError(
      400,
      `OpenAPPA is enabled but this session does not declare ${missing.join(" and ")}. Connect the ${archestraMcpBranding.serverName} MCP server to this client and allow both tools, then start a new session.`,
    );
  }

  // The model must never see the notice tool: it is the proxy's own projection,
  // and a model that knows the name could call it or write one into history.
  // The client keeps it, because the client is what executes it.
  stripAppaTools({ body: params.body, names: new Set([noticeToolName]) });
  return {
    tools: { controlToolName, noticeToolName },
    session,
    spellings,
    customTools,
    namespaces: declaredToolNamespaces(params.body),
    ...(family ? appaTurnBoundaries({ family, body: params.body }) : {}),
  };
}

// === Internal helpers ===

/** A name that ends in the notice tool's short name, under any client label. */
const NOTICE_TOOL_SPELLING = new RegExp(
  `(^|[^a-z0-9])${TOOL_GET_REMEDY_PLANS_SHORT_NAME}$`,
);

function shortToolName(name: string): ArchestraToolShortName | null {
  return archestraMcpBranding.getToolShortName(name);
}

/**
 * OpenCode spells a gateway's tool `<label>_<branded name>`, a form the
 * canonicalizer does not read. The label still has to be one of this
 * organization's gateways: it counts only when the canonicalizer anchors the
 * same label in the `mcp__<label>__` form it does read.
 */
function anchoredLabelShort(
  name: string,
  canonicalize: (name: string) => string,
): ArchestraToolShortName | null {
  for (const short of [
    TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
    TOOL_GET_REMEDY_PLANS_SHORT_NAME,
  ] as const) {
    const branded = archestraMcpBranding.getToolName(short);
    if (!name.endsWith(`_${branded}`) || name.endsWith(`__${branded}`))
      continue;
    const label = name.slice(0, name.length - branded.length - 1);
    if (
      label.length > 0 &&
      shortToolName(canonicalize(`mcp__${label}__${branded}`)) === short
    )
      return short;
  }
  return null;
}

/**
 * A client that declares a `tool_search` tool defers the rest of its tools to
 * a search the model runs later — Codex does this for MCP tools on models
 * that support it. Those tools are not on the wire, the remedy tools among
 * them cannot be seen, and no call to them can be gated.
 */
function refuseDeferredTools(declared: readonly unknown[]): void {
  const deferred = declared.some(
    (tool) => asToolDeclaration(tool)?.type === "tool_search",
  );
  if (deferred) {
    throw new ApiError(
      400,
      "OpenAPPA cannot govern a session that defers its tools to a tool search; the tools it may call are not on the wire. Configure the client to declare its tools inline, or disable OpenAPPA for this client.",
    );
  }
}

function refuseProviderHostedTools(declared: readonly unknown[]): void {
  for (const tool of declared) {
    const hosted = providerHostedTool(tool);
    if (!hosted) continue;
    // The provider runs these itself and reports them as results, so no call
    // reaches this proxy to gate. Governing the rest of the session would claim
    // a coverage it does not have.
    throw new ApiError(
      400,
      `OpenAPPA cannot govern the provider-hosted tool \`${hosted}\`, which runs inside the provider. Remove it from this session or disable OpenAPPA for this client.`,
    );
  }
}

/**
 * Codex code mode wraps tool calls inside an `exec` custom tool whose arguments
 * are a shell program, so the calls this proxy would gate never appear on the
 * wire as calls. Direct tool mode is the supported configuration; code mode is
 * refused before a root opens or the provider is called, even when it exposes
 * the APPA tools directly, because everything else still runs inside `exec`.
 */
function refuseCodexCodeMode(params: {
  family: AppaWireFamily;
  declared: readonly unknown[];
  body: unknown;
}): void {
  if (params.family !== "openai:responses") return;
  // The Responses wire has no authoritative origin field for `exec`. A grammar
  // custom declaration, or a historic custom call to it, is the protocol shape
  // Codex uses for wrapped code-mode calls. Treat it conservatively until the
  // provider exposes a trustworthy origin discriminator.
  const grammarExec = params.declared.some(isGrammarExecDeclaration);
  const historicExec = responsesInputItems(params.body).some(
    (item) => item.type === "custom_tool_call" && item.name === "exec",
  );
  if (!grammarExec && !historicExec) return;
  throw new ApiError(
    400,
    "OpenAPPA supports Codex in direct tool mode only; this session runs in code mode, where tool calls are wrapped in `exec` and cannot be governed. Use a direct-tool-mode model (for example gpt-5.5, gpt-5.4 or gpt-5.2) and start a new session.",
  );
}

type ToolDeclaration = {
  type?: string;
  name?: string;
  format?: unknown;
  additional_tools?: unknown;
  input?: unknown;
  tools?: unknown;
};

function asToolDeclaration(value: unknown): ToolDeclaration | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as ToolDeclaration)
    : undefined;
}

function isGrammarExecDeclaration(tool: unknown): boolean {
  const declaration = asToolDeclaration(tool);
  const format = asToolDeclaration(declaration?.format);
  return (
    declaration?.type === "custom" &&
    declaration.name === "exec" &&
    format?.type === "grammar"
  );
}

type ResponsesInputItem = {
  type?: string;
  name?: string;
};

function responsesInputItems(body: unknown): ResponsesInputItem[] {
  const request = asToolDeclaration(body);
  return Array.isArray(request?.input)
    ? request.input.flatMap((item) => {
        const input = asToolDeclaration(item);
        return input ? [input] : [];
      })
    : [];
}
