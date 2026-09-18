/**
 * Prepares an OpenAPPA request before provider dispatch:
 * 1. Restores denial notices in history back to original calls and rulings.
 * 2. Resolves session remedy tools and validates client declarations.
 */
import {
  type ArchestraToolShortName,
  TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
  TOOL_GET_REMEDY_PLANS_SHORT_NAME,
} from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { ApiError } from "@/types";
import type { OfferJws } from "./offer-claims";
import {
  type AppaSessionIdentity,
  type AppaWireFamily,
  appaTurnBoundaries,
  appaWireFamily,
  collectSignedOfferClaims,
  declaredToolName,
  declaredToolNamespaces,
  declaredTools,
  providerHostedTool,
  restoreAppaNotices,
  restoreAppaRemedyExecutions,
  stripAppaTools,
} from "./wire";

export type AppaRequestTools = {
  /** Client-declared spelling of the control tool. */
  controlToolName: string;
  /** Client-declared spelling of the denial notice tool. */
  noticeToolName: string;
};

export type AppaPreparedRequest = {
  /** Absent when the request declares no tools. */
  tools: AppaRequestTools | undefined;
  /** Presentation name of historical control tool from previous turns. */
  historicalControlToolName?: string;
  /** Session identity resolved from client request. */
  session: AppaSessionIdentity;
  /** Tools declared as free-form custom tools. */
  customTools: ReadonlySet<string>;
  /** Tool name to declaration namespace mapping (Codex). */
  namespaces: ReadonlyMap<string, string>;
  /** Canonical tool name to declared spelling mapping. */
  spellings: ReadonlyMap<string, string>;
  promptOperationId?: string;
  turnEndOperationId?: string;
  /** Signed offer routing collected from notices before restoration. */
  offerClaims?: OfferJws[];
};

/**
 * Restores denial notices in history and resolves APPA tools for this request.
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
  let offerClaims: OfferJws[] | undefined;
  const session = params.session ?? {
    provenance: "none" as const,
  };
  if (family) {
    const noticeMatch = {
      isNoticeTool: (name: string) =>
        shortToolName(params.canonicalizeToolName(name)) ===
        TOOL_GET_REMEDY_PLANS_SHORT_NAME,
      mayBeNoticeTool: (name: string) => NOTICE_TOOL_SPELLING.test(name),
    };
    const collected = collectSignedOfferClaims({
      family,
      body: params.body,
      ...noticeMatch,
    });
    if (collected.length > 0) offerClaims = collected;
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
      ...noticeMatch,
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
      ...(offerClaims ? { offerClaims } : {}),
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

  // Strip notice tool from provider request so the model cannot invoke it directly.
  stripAppaTools({ body: params.body, names: new Set([noticeToolName]) });
  return {
    tools: { controlToolName, noticeToolName },
    session,
    spellings,
    customTools,
    namespaces: declaredToolNamespaces(params.body),
    ...(family ? appaTurnBoundaries({ family, body: params.body }) : {}),
    ...(offerClaims ? { offerClaims } : {}),
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

/** Resolves OpenCode tool names formatted as <label>_<branded_name>. */
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

/** Refuses sessions where tools are deferred to a provider tool search. */
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

/** Refuses sessions declaring provider-hosted tools that bypass proxy gating. */
function refuseProviderHostedTools(declared: readonly unknown[]): void {
  for (const tool of declared) {
    const hosted = providerHostedTool(tool);
    if (!hosted) continue;
    throw new ApiError(
      400,
      `OpenAPPA cannot govern the provider-hosted tool \`${hosted}\`, which runs inside the provider. Remove it from this session or disable OpenAPPA for this client.`,
    );
  }
}

/** Refuses Codex code mode where tool calls are wrapped inside an exec program. */
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
