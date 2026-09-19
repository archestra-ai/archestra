/**
 * Prepares an OpenAPPA request before provider dispatch:
 * 1. Restores denial notices in history back to original calls and rulings.
 * 2. Resolves session remedy tools and validates client declarations.
 */
import {
  type ArchestraToolShortName,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
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
  isResultGovernedHostedTool,
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
  /** The gateway namespace the control tool is declared in (Codex). */
  controlNamespace?: string;
  /** The gateway namespace the notice tool is declared in, which Codex needs to dispatch a notice. */
  noticeNamespace?: string;
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
  const toolDeclarations = declared.map(({ tool }) => tool);
  if (family)
    refuseCodexCodeMode({
      family,
      declared: toolDeclarations,
      body: params.body,
    });
  refuseProviderHostedTools({ family, declared: toolDeclarations });
  refuseDeferredTools(toolDeclarations);

  const found = new Map<string, AppaToolDeclaration>();
  const spellings = new Map<string, string>();
  const customTools = new Set<string>();
  for (const { tool, namespace } of declared) {
    // The provider runs it, so the client never names or calls it: its calls
    // are ruled on from the response, not matched against a declared spelling.
    if (isResultGovernedHostedTool({ family, tool })) continue;
    const name = declaredToolName(tool);
    if (name === undefined) {
      // A tool this proxy cannot name is a tool it cannot gate or render.
      throw new ApiError(
        400,
        "OpenAPPA cannot govern a tool declared without a name; remove it or disable OpenAPPA for this client",
      );
    }
    if (asToolDeclaration(tool)?.type === "custom") customTools.add(name);
    // A Codex namespace member is read the way its calls are: joined with
    // the `mcp__<server>` namespace that declares it, so the label anchored
    // is the server's, not whatever its member is called.
    const anchored = namespacedToolName(name, namespace);
    const canonical = params.canonicalizeToolName(anchored);
    spellings.set(canonical, name);
    // Built-in status comes from the strict anchor alone: a decorated name
    // counts only under a label the canonicalizer ties to one of this
    // organization's gateways. A lookalike under any other label stays a
    // foreign tool, which is what keeps a hostile MCP server from naming a
    // tool of its own into the control tool, or into the notice tool that
    // would carry it every denied call.
    const short =
      shortToolName(canonical) ??
      anchoredLabelShort(anchored, params.canonicalizeToolName);
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
      // One declaration each. A second spelling of the same tool, or the
      // same one in a second gateway's namespace, leaves the session
      // ambiguous about where to deliver a notice and which call to trust.
      const first = found.get(short);
      if (
        first !== undefined &&
        (first.name !== name || first.namespace !== namespace)
      ) {
        throw new ApiError(
          400,
          `OpenAPPA needs exactly one declaration of ${short}; this request declares both ${declarationLabel(first)} and ${declarationLabel({ name, namespace })}. Connect this client to one gateway of this platform at a time.`,
        );
      }
      found.set(short, { name, ...(namespace ? { namespace } : {}) });
    }
  }

  let control = found.get(TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME);
  let notice = found.get(TOOL_GET_REMEDY_PLANS_SHORT_NAME);
  if (!control || !notice) {
    // OpenAPPA is on for this request: every agent gets notice and control
    // without an admin assigning them or the client listing them. Learn the
    // client's MCP prefix from a tool it did declare, otherwise use the
    // platform names. Clients that cap tools/list (Claude Code at 50) often
    // drop get_remedy_plans; injecting it here is what keeps denials as
    // notices on an already-running session. A pair only an unanchored
    // namespace declares is missing too: that server is not the gateway.
    const prefix = appaDeclarationPrefix(found);
    if (!notice) {
      notice = { name: `${prefix}${TOOL_GET_REMEDY_PLANS_SHORT_NAME}` };
      appendDeclaredTool(params.body, family, notice.name);
      found.set(TOOL_GET_REMEDY_PLANS_SHORT_NAME, notice);
      spellings.set(
        archestraMcpBranding.getToolName(TOOL_GET_REMEDY_PLANS_SHORT_NAME),
        notice.name,
      );
    }
    if (!control) {
      control = { name: `${prefix}${TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME}` };
      appendDeclaredTool(params.body, family, control.name);
      found.set(TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME, control);
      spellings.set(
        archestraMcpBranding.getToolName(TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME),
        control.name,
      );
    }
  }

  // Read before the strip: a denied call's notice records the namespace its
  // tool was declared in, so restoration can put the call back under it.
  const namespaces = declaredToolNamespaces(params.body);
  // Strip notice tool from provider request so the model cannot invoke it directly.
  stripAppaTools({ body: params.body, names: new Set([notice.name]) });
  return {
    tools: {
      controlToolName: control.name,
      noticeToolName: notice.name,
      ...(control.namespace ? { controlNamespace: control.namespace } : {}),
      ...(notice.namespace ? { noticeNamespace: notice.namespace } : {}),
    },
    session,
    spellings,
    customTools,
    namespaces,
    ...(family ? appaTurnBoundaries({ family, body: params.body }) : {}),
    ...(offerClaims ? { offerClaims } : {}),
  };
}

/**
 * A platform tool as OpenCode spells it: its gateway label joined to the
 * branded name by one `_` (`my_gateway_archestra__run_tool`). Resolved only
 * when the label anchors on one of this organization's gateways, through the
 * same `mcp__<label>__<name>` check Claude Code's names pass; under any other
 * label the name stays foreign.
 */
export function underscoreLabeledPlatformToolName(
  name: string,
  canonicalize: (name: string) => string,
): string | null {
  for (let at = name.indexOf("_"); at > 0; at = name.indexOf("_", at + 1)) {
    const rest = name.slice(at + 1);
    if (rest.startsWith("_") || !archestraMcpBranding.isToolName(rest))
      continue;
    const canonical = canonicalize(`mcp__${name.slice(0, at)}__${rest}`);
    if (archestraMcpBranding.isToolName(canonical)) return canonical;
  }
  return null;
}

/**
 * Codex declares an MCP server's tools as members of an `mcp__<server>`
 * namespace and calls a member by its bare name. Joined with the namespace,
 * they spell what Claude Code sends for the same tool, so the gateway
 * canonicalizer anchors it on the organization's real gateway label and a
 * same-named member of any other server keeps a foreign name.
 */
export function namespacedToolName(
  name: string,
  namespace: string | undefined,
): string {
  return namespace?.startsWith(`mcp${MCP_SERVER_TOOL_NAME_SEPARATOR}`)
    ? `${namespace}${MCP_SERVER_TOOL_NAME_SEPARATOR}${name}`
    : name;
}

// === Internal helpers ===

/** Where a request declares one of the APPA tools. */
type AppaToolDeclaration = {
  name: string;
  /** The Codex namespace that declares it; absent for a flat declaration. */
  namespace?: string;
};

function declarationLabel(declaration: AppaToolDeclaration): string {
  return declaration.namespace
    ? `${declaration.name} (namespace ${declaration.namespace})`
    : declaration.name;
}

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
  const resolved = underscoreLabeledPlatformToolName(name, canonicalize);
  const short = resolved ? shortToolName(resolved) : null;
  return short === TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME ||
    short === TOOL_GET_REMEDY_PLANS_SHORT_NAME
    ? short
    : null;
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

/**
 * The MCP prefix a client's own APPA declarations use, so an injected pair
 * keeps the same spelling the client already knows.
 */
function appaDeclarationPrefix(
  found: ReadonlyMap<string, AppaToolDeclaration>,
): string {
  for (const [short, { name }] of found) {
    if (name.endsWith(short)) return name.slice(0, name.length - short.length);
  }
  const branded = archestraMcpBranding.getToolName(
    TOOL_GET_REMEDY_PLANS_SHORT_NAME,
  );
  return branded.slice(
    0,
    branded.length - TOOL_GET_REMEDY_PLANS_SHORT_NAME.length,
  );
}

function appendDeclaredTool(
  body: unknown,
  family: AppaWireFamily | undefined,
  name: string,
): void {
  const holder = asToolDeclaration(body);
  if (!holder || !Array.isArray(holder.tools)) return;
  if (family === "openai:responses") {
    // Responses declares function tools flat; the nested Chat Completions
    // shape is rejected by the provider for a missing `name`.
    holder.tools.push({
      type: "function",
      name,
      parameters: { type: "object", properties: {} },
    });
    return;
  }
  if (family === "openai:chatCompletions") {
    holder.tools.push({
      type: "function",
      function: {
        name,
        parameters: { type: "object", properties: {} },
      },
    });
    return;
  }
  holder.tools.push({
    name,
    input_schema: { type: "object", properties: {} },
  });
}

/**
 * Refuses sessions declaring provider-hosted tools that bypass proxy gating.
 * A hosted tool whose result this wire can withhold is governed instead.
 */
function refuseProviderHostedTools(params: {
  family: AppaWireFamily | undefined;
  declared: readonly unknown[];
}): void {
  for (const tool of params.declared) {
    const hosted = providerHostedTool(tool);
    if (!hosted) continue;
    if (isResultGovernedHostedTool({ family: params.family, tool })) continue;
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
