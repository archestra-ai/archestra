/**
 * Prepares an OpenAPPA request before provider dispatch:
 * 1. Restores denial notices in history back to original calls and rulings.
 * 2. Reads delegation markers, then hides them from the provider.
 * 3. Removes the proxy's transport arguments from history and declarations.
 * 4. Resolves session remedy tools and validates client declarations.
 */
import {
  type ArchestraToolShortName,
  PROXY_STAMPED_TOOL_ARGUMENTS,
  TOOL_ASK_USER_SHORT_NAME,
  TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
  TOOL_GET_REMEDY_PLANS_SHORT_NAME,
} from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import type { GatewayToolIdentity } from "@/routes/proxy/utils/gateway-tool-names";
import { ApiError } from "@/types";
import type { CollectedChildReturns } from "./child-return";
import type { AppaChildTrajectoryReceipt } from "./child-trajectory-receipt";
import {
  type AppaDelegationMarker,
  collectDelegationMarkers,
  stripDelegationMarkers,
} from "./delegation";
import type { OfferJws } from "./offer-claims";
import {
  type AppaSessionIdentity,
  type AppaWireFamily,
  appaTurnBoundaries,
  appaWireFamily,
  collectSignedOfferClaims,
  type DeclaredToolSpelling,
  declaredToolEntries,
  declaredToolNamespaces,
  isResultGovernedHostedTool,
  providerHostedTool,
  restoreAppaNotices,
  restoreAppaRemedyExecutions,
  stripAppaTools,
  stripChildTrajectoryReceiptsFromRequest,
  stripDeclaredParameters,
  stripProxyArguments,
} from "./wire";

export type AppaRequestTools = {
  /** The control tool's declaration, as the client spells it. */
  control: DeclaredToolSpelling;
  /** The denial notice tool's declaration, as the client spells it. */
  notice: DeclaredToolSpelling;
  /** The ask_user tool's declaration, when this session declares one. */
  askUser: DeclaredToolSpelling | undefined;
  /** Declared spellings that resolve to the platform's ask_user. */
  platformToolNames: ReadonlySet<string>;
  /** Tool name to declaration namespace mapping (Codex). */
  namespaces: ReadonlyMap<string, string>;
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
  /** Tool declarations retained so adapters can detect native local tools. */
  declaredTools: readonly DeclaredToolSpelling[];
  promptOperationId?: string;
  turnEndOperationId?: string;
  /** Signed offer routing collected from notices before restoration. */
  offerClaims?: OfferJws[];
  /** Original call IDs whose results are restored rulings, not executions. */
  restoredNoticeCallIds?: ReadonlySet<string>;
  /** Signed offers the proxy may stamp onto this turn's ask_user calls. */
  askUserOfferClaims?: OfferJws[];
  /**
   * Present on wire families where the proxy reads and removes delegation markers.
   * Only these families allow attaching delegation markers to spawn calls.
   */
  delegation?: {
    /** Unverified markers from user turns, in wire order. */
    markers: AppaDelegationMarker[];
  };
  /** Signed child-return carriers collected before provider dispatch. */
  childReturns?: CollectedChildReturns;
  /** Unverified self-contained trajectory proofs; child binding verifies them. */
  childTrajectoryReceipts?: AppaChildTrajectoryReceipt[];
};

/**
 * Restores denial notices in history and resolves APPA tools for this request.
 */
export function prepareAppaRequest(params: {
  body: unknown;
  interactionType: string;
  /** This client's session identity, as `appaSessionIdentity` read it. */
  session?: AppaSessionIdentity;
  /** Internal Chat calls use platform tools without a client decoration. */
  trustBarePlatformTools?: boolean;
  /** Which declared tools are this platform's gateway tools, and as what. */
  identity: Pick<
    GatewayToolIdentity,
    | "mode"
    | "canonicalize"
    | "attestationOf"
    | "verified"
    | "unverifiedMarkerCount"
  >;
  /**
   * Markers the proxy already collected before it stripped them
   * unconditionally at request entry.
   */
  delegationMarkers?: AppaDelegationMarker[];
  childReturns?: CollectedChildReturns;
  childTrajectoryReceipts?: AppaChildTrajectoryReceipt[];
}): AppaPreparedRequest {
  // A wire family this proxy cannot restore notices on — Gemini, Bedrock,
  // Cohere, native Ollama — is governed in part rather than refused: calls
  // and results are still ruled on, but a notice stays in the history as the
  // notice call the client ran, and no turn accounting runs.
  const family = appaWireFamily(params.interactionType);
  const entries = declaredToolEntries(params.body);
  const declared = entries.map((entry) => entry.tool);
  if (params.interactionType === "azure:responses" && declared.length > 0) {
    throw new ApiError(
      400,
      "OpenAPPA cannot govern tool traffic over Azure Responses. Use Azure Chat Completions or disable OpenAPPA for this client.",
    );
  }
  let historicalControlToolName: string | undefined;
  let offerClaims: OfferJws[] | undefined;
  let restoredNoticeCallIds: ReadonlySet<string> | undefined;
  let askUserOfferClaims: OfferJws[] | undefined;
  let delegation: AppaPreparedRequest["delegation"];
  let childTrajectoryReceipts: AppaChildTrajectoryReceipt[] | undefined;
  const session = params.session ?? {
    provenance: "none" as const,
  };
  if (family) {
    const noticeMatch = {
      isNoticeTool: (name: string, namespace?: string) =>
        shortToolName(params.identity.canonicalize(name, namespace)) ===
        TOOL_GET_REMEDY_PLANS_SHORT_NAME,
      mayBeNoticeTool: (name: string) => NOTICE_TOOL_SPELLING.test(name),
    };
    const collected = collectSignedOfferClaims({
      family,
      body: params.body,
      ...noticeMatch,
    });
    if (collected.length > 0) offerClaims = collected;
    // Only notices minted since the last user message may still be stamped
    // onto this turn's ask_user calls; older ones belong to their turn.
    const thisTurn = collectSignedOfferClaims({
      family,
      body: params.body,
      ...noticeMatch,
      currentTurnOnly: true,
    });
    if (thisTurn.length > 0) askUserOfferClaims = thisTurn;
    historicalControlToolName = restoreAppaRemedyExecutions({
      family,
      body: params.body,
      allowHistoricalControl: declared.length === 0,
      // Current declarations bind live controls. Without declarations, only a
      // typed record bound to the same call and arguments can restore history.
      isControlTool: (name, namespace) =>
        shortToolName(params.identity.canonicalize(name, namespace)) ===
        TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
    });
    const restored = restoreAppaNotices({
      family,
      body: params.body,
      ...noticeMatch,
    });
    if (restored.size > 0) restoredNoticeCallIds = restored;
    // The control calls came back whole from their receipts above; ask_user
    // calls carry the offers the proxy stamped for the tool alone.
    stripProxyArguments({
      family,
      body: params.body,
      isStampedTool: (name, namespace) =>
        shortToolName(params.identity.canonicalize(name, namespace)) ===
        TOOL_ASK_USER_SHORT_NAME,
      names: ASK_USER_PROXY_ARGUMENTS,
    });
    // Read before the strip: every request of a child carries its opening
    // message, and with it the marker that binds it.
    delegation = {
      markers:
        params.delegationMarkers ??
        collectDelegationMarkers({ family, body: params.body }),
    };
    stripDelegationMarkers({ family, body: params.body });
    childTrajectoryReceipts = [
      ...(params.childTrajectoryReceipts ?? []),
      ...stripChildTrajectoryReceiptsFromRequest({
        family,
        body: params.body,
      }),
    ];
  }

  // A tool-free child can still return a value. Keep turn accounting available
  // without introducing tool governance for a tool-free root.
  if (declared.length === 0) {
    return {
      tools: undefined,
      ...(historicalControlToolName ? { historicalControlToolName } : {}),
      session,
      customTools: new Set(),
      declaredTools: [],
      ...(family ? appaTurnBoundaries({ family, body: params.body }) : {}),
      ...(offerClaims ? { offerClaims } : {}),
      ...(restoredNoticeCallIds ? { restoredNoticeCallIds } : {}),
      ...(askUserOfferClaims ? { askUserOfferClaims } : {}),
      ...(delegation ? { delegation } : {}),
      ...(params.childReturns ? { childReturns: params.childReturns } : {}),
      ...(childTrajectoryReceipts && childTrajectoryReceipts.length > 0
        ? { childTrajectoryReceipts }
        : {}),
    };
  }
  if (family) refuseCodexCodeMode({ family, declared, body: params.body });
  refuseProviderHostedTools({ family, declared });
  refuseDeferredTools(declared);

  const customTools = new Set<string>();
  const declaredTools: DeclaredToolSpelling[] = [];
  for (const entry of entries) {
    // The provider runs it, so the client never names or calls it: its calls
    // are ruled on from the response, not matched against a declared spelling.
    if (isResultGovernedHostedTool({ family, tool: entry.tool })) continue;
    if (entry.name === undefined) {
      // A tool this proxy cannot name is a tool it cannot gate or render.
      throw new ApiError(
        400,
        "OpenAPPA cannot govern a tool declared without a name; remove it or disable OpenAPPA for this client.",
      );
    }
    declaredTools.push({
      name: entry.name,
      ...(entry.namespace ? { namespace: entry.namespace } : {}),
    });
    if (asToolDeclaration(entry.tool)?.type === "custom")
      customTools.add(entry.name);
  }

  const askUserDeclarations = platformDeclarationsOf(
    TOOL_ASK_USER_SHORT_NAME,
    entries,
    params.identity,
    params.trustBarePlatformTools === true,
  );
  const platformToolNames = new Set(
    askUserDeclarations.map((each) => each.name),
  );

  const remedyTool = (shortName: ArchestraToolShortName) =>
    oneRemedyDeclaration({
      shortName,
      entries,
      identity: params.identity,
    });
  let control = remedyTool(TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME);
  let notice = remedyTool(TOOL_GET_REMEDY_PLANS_SHORT_NAME);
  if (params.identity.mode === "attested" && control && notice) {
    // Control and notice status come from one gateway: each declaration must
    // still hold its attestation after demotion, and both must name the same
    // gateway. A pair split across two gateways is not this session's pair.
    const controlGateway = attestedGateway(params.identity, control);
    const noticeGateway = attestedGateway(params.identity, notice);
    if (!controlGateway || controlGateway !== noticeGateway) {
      control = undefined;
      notice = undefined;
    }
  }
  if (!control || !notice) {
    // Markers that fail to verify, and none that do, most likely mean a tool
    // list the client fetched under a different key or before this deploy;
    // reconnecting fetches a fresh one. A demotion to compat mode is itself
    // the markers failing, so it refuses the same way.
    if (params.identity.unverifiedMarkerCount > 0) {
      throw new ApiError(
        400,
        `OpenAPPA cannot verify the ${archestraMcpBranding.serverName} tools this session declares. Reconnect the ${archestraMcpBranding.serverName} MCP server to this client, then start a new session.`,
      );
    }
    // Clients that limit tool listings (such as Claude Code at 50) may omit
    // the remedy tools; injection keeps denials returning as notices during
    // active sessions. Attested sessions cannot inject: a synthesized
    // declaration carries no attestation and could never be trusted.
    if (params.identity.mode !== "attested") {
      const prefix = appaDeclarationPrefix({ control, notice });
      if (!notice) {
        notice = { name: `${prefix}${TOOL_GET_REMEDY_PLANS_SHORT_NAME}` };
        appendDeclaredTool(params.body, family, notice.name);
      }
      if (!control) {
        control = { name: `${prefix}${TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME}` };
        appendDeclaredTool(params.body, family, control.name);
      }
    } else {
      const missing = [
        control ? undefined : TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
        notice ? undefined : TOOL_GET_REMEDY_PLANS_SHORT_NAME,
      ].filter((name): name is string => name !== undefined);
      throw new ApiError(
        400,
        `OpenAPPA is enabled but this session does not declare ${missing.join(" and ")}. Connect the ${archestraMcpBranding.serverName} MCP server to this client and allow both tools, then start a new session.`,
      );
    }
  }

  // The proxy, not the model, writes stamped arguments; the provider's schema
  // never offers them.
  for (const { tool, name, namespace } of entries) {
    const isAskUser = askUserDeclarations.some(
      (declaration) =>
        declaration.name === name && declaration.namespace === namespace,
    );
    const short =
      name === undefined
        ? null
        : control && name === control.name && namespace === control.namespace
          ? TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME
          : isAskUser
            ? TOOL_ASK_USER_SHORT_NAME
            : null;
    const proxyArguments =
      short !== null && short in PROXY_STAMPED_TOOL_ARGUMENTS
        ? PROXY_STAMPED_TOOL_ARGUMENTS[
            short as keyof typeof PROXY_STAMPED_TOOL_ARGUMENTS
          ]
        : undefined;
    if (proxyArguments)
      stripDeclaredParameters({ tool, names: new Set(proxyArguments) });
  }

  // Read before the strip: a denied call's notice records the namespace its
  // tool was declared in, so restoration can put the call back under it.
  const namespaces = declaredToolNamespaces(params.body);
  // Strip notice tool from provider request so the model cannot invoke it directly.
  stripAppaTools({ body: params.body, tools: [notice] });
  return {
    tools: {
      control,
      notice,
      askUser: askUserDeclarations[0],
      platformToolNames,
      namespaces,
    },
    session,
    customTools,
    declaredTools,
    ...(family ? appaTurnBoundaries({ family, body: params.body }) : {}),
    ...(offerClaims ? { offerClaims } : {}),
    ...(restoredNoticeCallIds ? { restoredNoticeCallIds } : {}),
    ...(askUserOfferClaims ? { askUserOfferClaims } : {}),
    ...(delegation ? { delegation } : {}),
    ...(params.childReturns ? { childReturns: params.childReturns } : {}),
    ...(childTrajectoryReceipts && childTrajectoryReceipts.length > 0
      ? { childTrajectoryReceipts }
      : {}),
  };
}

/**
 * Resolves an OpenCode tool spelling where the gateway label is joined to the
 * tool name with an underscore (`my_gateway_archestra__run_tool`).
 * Only resolves when the label matches one of the organization's gateways.
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? (value as unknown[]) : null;
}

// === Internal helpers ===

/** The offers the proxy stamps onto the model's ask_user calls. */
const ASK_USER_PROXY_ARGUMENTS: ReadonlySet<string> = new Set(
  PROXY_STAMPED_TOOL_ARGUMENTS[TOOL_ASK_USER_SHORT_NAME],
);

/** A name that ends in the notice tool's short name, under any client label. */
const NOTICE_TOOL_SPELLING = new RegExp(
  `(^|[^a-z0-9])${TOOL_GET_REMEDY_PLANS_SHORT_NAME}$`,
);

function shortToolName(name: string): ArchestraToolShortName | null {
  return archestraMcpBranding.getToolShortName(name);
}

/**
 * Every declaration that resolves to a platform tool, by the identity's own
 * resolution: attested declarations count only while their attestation holds;
 * without attestations, canonical resolution decides, and internal Chat calls
 * may name platform tools bare.
 */
function platformDeclarationsOf(
  shortName: ArchestraToolShortName,
  entries: ReturnType<typeof declaredToolEntries>,
  identity: Pick<
    GatewayToolIdentity,
    "mode" | "canonicalize" | "verified" | "attestationOf"
  >,
  trustBarePlatformTools: boolean,
): DeclaredToolSpelling[] {
  if (identity.mode === "attested") {
    return identity.verified
      .filter(
        (declaration) =>
          declaration.kind === "b" &&
          shortToolName(declaration.advertisedName) === shortName,
      )
      .map((declaration) => ({
        name: declaration.name,
        ...(declaration.namespace ? { namespace: declaration.namespace } : {}),
      }));
  }
  const found: DeclaredToolSpelling[] = [];
  for (const { name, namespace } of entries) {
    if (name === undefined) continue;
    if (
      shortToolName(identity.canonicalize(name, namespace)) === shortName ||
      (trustBarePlatformTools && shortToolName(name) === shortName)
    ) {
      found.push({ name, ...(namespace ? { namespace } : {}) });
    }
  }
  return found;
}

/**
 * The one declaration of a remedy tool this session makes, if any.
 *
 * With attestations, only a declaration the gateway attested as that built-in
 * counts, whatever its spelling, and a lookalike under any label stays a
 * foreign tool; that is what keeps a hostile MCP server from naming a tool of
 * its own into the control or notice tool. The count is taken before
 * demotion, so a replayed marker or a second gateway reads as the conflict it
 * is. Without attestations the identity's own resolution decides.
 *
 * A second declaration of the same tool leaves the session ambiguous about
 * which name to render and which call to trust, so it is refused with the way
 * out, as is a declaration that takes free-form input.
 */
function oneRemedyDeclaration(params: {
  shortName: ArchestraToolShortName;
  entries: ReturnType<typeof declaredToolEntries>;
  identity: Pick<GatewayToolIdentity, "mode" | "canonicalize" | "verified">;
}): DeclaredToolSpelling | undefined {
  const { shortName, entries, identity } = params;
  const found =
    identity.mode === "attested"
      ? identity.verified.filter(
          (declaration) =>
            declaration.kind === "b" &&
            shortToolName(declaration.advertisedName) === shortName,
        )
      : entries.flatMap(({ name, namespace }) =>
          name !== undefined &&
          shortToolName(identity.canonicalize(name, namespace)) === shortName
            ? [{ name, namespace }]
            : [],
        );
  const candidates = new Map<string, DeclaredToolSpelling>();
  for (const { name, namespace } of found) {
    candidates.set(`${namespace ?? ""}\u0000${name}`, {
      name,
      ...(namespace ? { namespace } : {}),
    });
  }
  const [first, second] = candidates.values();
  if (second) {
    throw new ApiError(
      400,
      `OpenAPPA needs exactly one declaration of ${shortName}. This request declares both ${spellingLabel(first)} and ${spellingLabel(second)}. Connect this client to one gateway of this platform at a time.`,
    );
  }
  if (!first) return undefined;
  const custom = entries.some(
    (entry) =>
      entry.name === first.name &&
      entry.namespace === first.namespace &&
      asToolDeclaration(entry.tool)?.type === "custom",
  );
  if (custom) {
    throw new ApiError(
      400,
      "OpenAPPA control tools require structured function arguments, not free-form custom input",
    );
  }
  return first;
}

/** The gateway that attested this exact declaration, after demotion. */
function attestedGateway(
  identity: Pick<GatewayToolIdentity, "attestationOf">,
  spelling: DeclaredToolSpelling,
): string | undefined {
  const attestation = identity.attestationOf(spelling.name, spelling.namespace);
  return attestation?.kind === "b" ? attestation.gatewayId : undefined;
}

function spellingLabel(spelling: DeclaredToolSpelling): string {
  return spelling.namespace
    ? `${spelling.namespace}/${spelling.name}`
    : spelling.name;
}

/** The prefix an injected declaration uses, from any declaration present. */
function appaDeclarationPrefix(found: {
  control?: DeclaredToolSpelling;
  notice?: DeclaredToolSpelling;
}): string {
  for (const declaration of [found.control, found.notice]) {
    if (!declaration) continue;
    const { name } = declaration;
    for (const short of [
      TOOL_GET_REMEDY_PLANS_SHORT_NAME,
      TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
    ]) {
      if (name.endsWith(short))
        return name.slice(0, name.length - short.length);
    }
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
  const holder = asRecord(body);
  if (!holder) return;
  const declared = asArray(holder.tools);
  if (!declared) {
    // Codex can declare its existing tools only in additional_tools input
    // items; anything else has nowhere to append.
    if (family !== "openai:responses") return;
    const input = asArray(holder.input);
    const additional = input?.find(
      (item) => asRecord(item)?.type === "additional_tools",
    );
    const record = asRecord(additional);
    if (!record) return;
    const tools = asArray(record.tools) ?? [];
    record.tools = [
      ...tools,
      {
        type: "function",
        name,
        parameters: { type: "object", properties: {} },
      },
    ];
    return;
  }
  if (family === "openai:responses") {
    // Responses declares function tools flat; the nested Chat Completions
    // shape is rejected by the provider for a missing `name`.
    holder.tools = [
      ...declared,
      {
        type: "function",
        name,
        parameters: { type: "object", properties: {} },
      },
    ];
    return;
  }
  if (family === "openai:chatCompletions") {
    holder.tools = [
      ...declared,
      {
        type: "function",
        function: { name, parameters: { type: "object", properties: {} } },
      },
    ];
    return;
  }
  holder.tools = [
    ...declared,
    { name, input_schema: { type: "object", properties: {} } },
  ];
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
