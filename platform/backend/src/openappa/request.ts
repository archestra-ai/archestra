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
import { tools as openappaMcpTools } from "@/archestra-mcp-server/openappa";
import config from "@/config";
import type { GatewayToolIdentity } from "@/routes/proxy/utils/gateway-tool-names";
import { ApiError } from "@/types";
import {
  type CollectedChildReturns,
  collectAndStripChildReturns,
} from "./child-return";
import type { AppaChildTrajectoryReceipt } from "./child-trajectory-receipt";
import { unwrapCompactionCarriersFromRequest } from "./compaction-carrier";
import {
  type AppaDelegationMarker,
  collectDelegationMarkers,
  stripDelegationMarkers,
} from "./delegation";
import { readNotice, readRemedyExecution } from "./notice";
import { type OfferJws, verifyOfferClaims } from "./offer-claims";
import { copyOwnRecord } from "./provenance";
import { mayHoldTrajectoryStamp } from "./trajectory-stamp";
import {
  type AppaSessionIdentity,
  type AppaWireFamily,
  appaTurnBoundaries,
  appaWireFamily,
  collectSignedOfferClaims,
  type DeclaredToolSpelling,
  declaredToolEntries,
  declaredToolNamespaces,
  isClientRunToolType,
  type ProviderToolCall,
  type ProviderWire,
  providerHostedTool,
  providerToolCalls,
  providerWire,
  restoreAppaNotices,
  restoreAppaRemedyExecutions,
  restoreTrajectoryStamps,
  restoreTrajectoryStampsInText,
  stripAppaTools,
  stripChildTrajectoryReceiptsFromRequest,
  stripDeclaredParameters,
  stripProxyArguments,
  stripSessionReceiptsFromRequest,
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
  /** Absent when the client has no usable gateway remedy tools. */
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
  /** Child-return completions collected before provider dispatch. */
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
    | "gatewayConnected"
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
  refuseDeferredTools(declared);
  refuseUnsupportedToolTypes(declared);
  // Provider-run tools never return a client call to gate. Responses web search
  // remains governed by the response adapter, not by its declaration.
  const clientEntries = entries.filter((entry) => {
    if (providerHostedTool(entry.tool)) return false;
    if (
      params.interactionType === "gemini:generateContent" &&
      !entry.grouped &&
      entry.name === undefined
    ) {
      // Only known Gemini server tools may be unnamed. Future tool types
      // cannot silently bypass the client-call gate.
      const tool = asRecord(entry.tool);
      return (
        !tool ||
        Object.keys(tool).length === 0 ||
        Object.keys(tool).some((key) => !GEMINI_HOSTED_TOOL_KEYS.has(key))
      );
    }
    return true;
  });
  const hostedNames = new Set(
    entries
      .filter((entry) => !clientEntries.includes(entry) && entry.name)
      .map((entry) =>
        params.identity.canonicalize(entry.name as string, entry.namespace),
      ),
  );
  const clientNames = new Set(
    clientEntries
      .filter((entry) => entry.name)
      .map((entry) =>
        params.identity.canonicalize(entry.name as string, entry.namespace),
      ),
  );
  if ([...hostedNames].some((name) => clientNames.has(name))) {
    throw new ApiError(
      400,
      "A provider-hosted tool conflicts with a client tool; rename or remove that declaration.",
    );
  }
  if (
    params.interactionType === "azure:responses" &&
    declared.some((tool) =>
      ["web_search", "web_search_preview"].includes(
        asToolDeclaration(tool)?.type ?? "",
      ),
    )
  ) {
    throw new ApiError(
      400,
      "OpenAPPA cannot govern hosted web-search results on Azure Responses. Use OpenAI Responses or remove web search from this session.",
    );
  }
  if (
    params.interactionType === "azure:responses" &&
    clientEntries.length > 0
  ) {
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
    const ours = platformToolMatchers(params.identity);
    const noticeMatch = {
      isNoticeTool: ours.notice,
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
    // Offers are read above, before restoration takes the notices apart.
    const restored = restoreHistory({
      family,
      body: params.body,
      ours,
      declaredCount: declared.length,
    });
    historicalControlToolName = restored.historicalControlToolName;
    if (restored.noticeCallIds.size > 0)
      restoredNoticeCallIds = restored.noticeCallIds;
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

  // A tool-free child can still return a value. Proxy-only clients still need
  // turn accounting and declared-tool checks, but cannot receive remedy calls.
  const withoutRemedies = (
    customTools: ReadonlySet<string>,
    declaredTools: readonly DeclaredToolSpelling[],
  ): AppaPreparedRequest => ({
    tools: undefined,
    ...(historicalControlToolName ? { historicalControlToolName } : {}),
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
  });
  if (declared.length === 0 || (clientEntries.length === 0 && !family)) {
    return withoutRemedies(new Set(), []);
  }
  if (family) refuseCodexCodeMode({ family, declared, body: params.body });
  const customTools = new Set<string>();
  const declaredTools: DeclaredToolSpelling[] = [];
  for (const entry of clientEntries) {
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
    clientEntries,
    params.identity,
    params.trustBarePlatformTools === true,
  );
  const platformToolNames = new Set(
    askUserDeclarations.map((each) => each.name),
  );

  const remedyTool = (shortName: ArchestraToolShortName) =>
    oneRemedyDeclaration({
      shortName,
      entries: clientEntries,
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
    if (
      !params.identity.gatewayConnected &&
      params.identity.mode === "compat"
    ) {
      // Without an anchored built-in, no remedy tool could be resolved here;
      // keep the client's own tools for policy checks but never invent ours.
      return withoutRemedies(customTools, declaredTools);
    }
    // Clients that limit tool listings (such as Claude Code at 50) may omit
    // the remedy tools; injection keeps denials returning as notices during
    // active sessions. Attested sessions cannot inject: a synthesized
    // declaration carries no attestation and could never be trusted.
    if (params.identity.mode !== "attested") {
      const prefix = appaDeclarationPrefix({ control, notice });
      if (
        (!notice &&
          hostedNames.has(
            params.identity.canonicalize(
              `${prefix}${TOOL_GET_REMEDY_PLANS_SHORT_NAME}`,
            ),
          )) ||
        (!control &&
          hostedNames.has(
            params.identity.canonicalize(
              `${prefix}${TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME}`,
            ),
          ))
      ) {
        throw new ApiError(
          400,
          "A provider-hosted tool conflicts with the OpenAPPA remedy tools; rename or remove that declaration.",
        );
      }
      if (!notice) {
        notice = { name: `${prefix}${TOOL_GET_REMEDY_PLANS_SHORT_NAME}` };
        appendDeclaredTool(
          params.body,
          family,
          notice.name,
          params.interactionType,
        );
      }
      if (!control) {
        control = { name: `${prefix}${TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME}` };
        appendDeclaredTool(
          params.body,
          family,
          control.name,
          params.interactionType,
          providerVisibleControlDeclaration(),
        );
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
  for (const { tool, name, namespace } of clientEntries) {
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
  if (control) {
    applyCanonicalControlDeclaration({
      body: params.body,
      control,
      interactionType: params.interactionType,
    });
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
 * Takes OpenAPPA's transport members out of a request on its way to the
 * provider, whatever restoration did and whether or not the request has an
 * OpenAPPA session (deployment switch off, a bypassed client, a delegated
 * run, a wire notices do not restore on).
 *
 * 1. On the three restoring families, puts history back exactly as
 *    {@link prepareAppaRequest} does.
 * 2. On every wire, drops what restoration left: a notice's record and signed
 *    offers, a control call's receipt and JWS members, ask_user's offers.
 * 3. Drops those members from the declarations of this platform's remedy and
 *    ask_user tools, for clients still holding a tool list that has them.
 * 4. Puts the provider's call id back where a client copied a trajectory stamp
 *    into message or tool-result text.
 *
 * Never changes a call id, so tool-result updates keyed by id still land.
 * Returns how many calls, declarations and texts it rewrote.
 */
export function sanitizeProviderBoundRequest(params: {
  body: unknown;
  interactionType: string;
  /** Absent where no gateway identity was resolved: catch-all routes. */
  identity?: Pick<GatewayToolIdentity, "canonicalize">;
}): number {
  const wire = providerWire(params.interactionType);
  if (!wire) return 0;
  const ours = platformToolMatchers(params.identity);
  const family = appaWireFamily(params.interactionType);
  const restored = family
    ? restoreHistory({
        family,
        body: params.body,
        ours,
        declaredCount: declaredToolEntries(params.body).length,
      }).changed
    : 0;
  return (
    restored +
    scrubProxyMembers({
      wire,
      body: params.body,
      ours,
      secret: config.openappa.offerSigningSecret,
    }) +
    (params.identity
      ? stripDeclaredProxyParameters({ body: params.body, ours })
      : 0) +
    restoreTrajectoryStampsInText({ wire, body: params.body })
  );
}

/** Whether a raw JSON body could hold anything {@link sanitizeForwardedRequest} removes. */
export function mayHoldOpenAppaPayload(raw: Buffer): boolean {
  return (
    mayHoldTrajectoryStamp(raw) ||
    OPENAPPA_TOOL_TOKENS.some((token) => raw.includes(token)) ||
    PROXY_MARK_TOKENS.some((token) => raw.includes(token))
  );
}

/**
 * {@link sanitizeProviderBoundRequest} for a body a catch-all proxy forwards
 * without the LLM proxy pipeline: Anthropic's `/v1/messages/count_tokens`,
 * OpenAI's `/responses/input_tokens`, Gemini's `:countTokens`. The wire is
 * read from the body's shape. As at the pipeline's entry, the proxy's receipts
 * and markers go first, then call ids come back from their stamps and native
 * question ids. With no gateway identity, only a member the proxy provably
 * wrote goes. Returns whether the body changed.
 */
export function sanitizeForwardedRequest(body: object): boolean {
  // Gemini's countTokens may wrap a whole generateContent request.
  const target = asRecord(asRecord(body)?.generateContentRequest) ?? body;
  const interactionType = forwardedWire(target);
  if (!interactionType) return false;
  const family = appaWireFamily(interactionType);
  const marks = family ? stripProxyMarks({ family, body: target }) : false;
  const stamps = restoreTrajectoryStamps({
    interactionType,
    body: target,
  }).length;
  return (
    marks ||
    stamps + sanitizeProviderBoundRequest({ body: target, interactionType }) > 0
  );
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

type PlatformToolMatchers = Record<
  "notice" | "control" | "askUser",
  (name: string, namespace?: string) => boolean
>;

/**
 * Which calls this request's gateway identity resolves to the platform's
 * remedy and ask_user tools: attested declarations in attested mode, the
 * gateway's own labels in compat mode, bare names for Chat. Without an
 * identity (catch-all routes) nothing is ours by name.
 */
function platformToolMatchers(
  identity: Pick<GatewayToolIdentity, "canonicalize"> | undefined,
): PlatformToolMatchers {
  const resolvesTo =
    (short: ArchestraToolShortName) => (name: string, namespace?: string) =>
      identity !== undefined &&
      shortToolName(identity.canonicalize(name, namespace)) === short;
  return {
    notice: resolvesTo(TOOL_GET_REMEDY_PLANS_SHORT_NAME),
    control: resolvesTo(TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME),
    askUser: resolvesTo(TOOL_ASK_USER_SHORT_NAME),
  };
}

/**
 * Puts provider history back the way the model wrote it: control calls from
 * their receipts, notices to the denied calls and their rulings, ask_user
 * calls without the offers the proxy stamped. Shared by the session path and
 * the provider-bound sanitizer, so both show the provider the same bytes.
 */
function restoreHistory(params: {
  family: AppaWireFamily;
  body: unknown;
  ours: PlatformToolMatchers;
  /** Declarations the request made, before any was stripped. */
  declaredCount: number;
}): {
  historicalControlToolName?: string;
  noticeCallIds: ReadonlySet<string>;
  changed: number;
} {
  const historicalControlToolName = restoreAppaRemedyExecutions({
    family: params.family,
    body: params.body,
    // Current declarations bind live controls. Without declarations, only a
    // typed record bound to the same call and arguments can restore history.
    allowHistoricalControl: params.declaredCount === 0,
    isControlTool: params.ours.control,
  });
  const noticeCallIds = restoreAppaNotices({
    family: params.family,
    body: params.body,
    isNoticeTool: params.ours.notice,
    mayBeNoticeTool: (name) => NOTICE_TOOL_SPELLING.test(name),
  });
  // The control calls came back whole from their receipts above; ask_user
  // calls carry the offers the proxy stamped for the tool alone.
  const askUsers = stripProxyArguments({
    family: params.family,
    body: params.body,
    isStampedTool: params.ours.askUser,
    names: ASK_USER_PROXY_ARGUMENTS,
  });
  return {
    ...(historicalControlToolName ? { historicalControlToolName } : {}),
    noticeCallIds,
    changed:
      (historicalControlToolName ? 1 : 0) + noticeCallIds.size + askUsers,
  };
}

/** What only the proxy writes on a notice: its record and the signed offers. */
const NOTICE_PROXY_MEMBERS: ReadonlySet<string> = new Set(["notice", "offers"]);
const OFFERS_MEMBER: ReadonlySet<string> = new Set(["offers"]);
/** The receipt and JWS members the proxy stamps onto a control call. */
const CONTROL_PROXY_MEMBERS: ReadonlySet<string> = new Set(
  PROXY_STAMPED_TOOL_ARGUMENTS[TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME],
);
/** Names that end in the control and ask_user short names, under any client label. */
const CONTROL_TOOL_SPELLING = new RegExp(
  `(^|[^a-z0-9])${TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME}$`,
);
const ASK_USER_TOOL_SPELLING = new RegExp(
  `(^|[^a-z0-9])${TOOL_ASK_USER_SHORT_NAME}$`,
);
/** What a body must mention before the catch-all parses it. */
const OPENAPPA_TOOL_TOKENS = [
  TOOL_GET_REMEDY_PLANS_SHORT_NAME,
  TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
  "remedy_offers",
];
/**
 * The fixed text of the receipts and markers the proxy writes into history:
 * session receipts, child returns, child-trajectory receipts, delegation
 * markers and Responses compaction carriers.
 */
const PROXY_MARK_TOKENS = [
  "protected session ",
  "finished subagent ",
  "appact2-",
  "[appa] delegated trajectory ",
  "appac1-",
];

/**
 * Drops the receipts and markers handleLLMProxy strips at its entry, for a
 * body that skips the pipeline. Only a session resolves them into lineage
 * evidence, so they are dropped here, not collected. Returns whether the body
 * changed.
 */
function stripProxyMarks(params: {
  family: AppaWireFamily;
  body: object;
}): boolean {
  const before = JSON.stringify(params.body);
  if (!PROXY_MARK_TOKENS.some((token) => before.includes(token))) return false;
  stripSessionReceiptsFromRequest(params);
  if (params.family === "openai:responses")
    unwrapCompactionCarriersFromRequest(params.body);
  stripChildTrajectoryReceiptsFromRequest(params);
  stripDelegationMarkers(params);
  collectAndStripChildReturns(params.body);
  return JSON.stringify(params.body) !== before;
}

/**
 * What restoration leaves behind still never reaches the provider, on every
 * wire. A call is ours by name, as this request's identity resolves it, or by
 * a member only the proxy could have written: a notice record naming its own
 * call, or an offer this deployment signed. Spelling alone never is, so a
 * foreign tool that takes a `payload` or a `signature` keeps them.
 */
function scrubProxyMembers(params: {
  wire: ProviderWire;
  body: unknown;
  ours: PlatformToolMatchers;
  secret: string;
}): number {
  const signed = (value: unknown) =>
    params.secret.length > 0 &&
    verifyOfferClaims(value, params.secret) !== null;
  const allSigned = (value: unknown) =>
    Array.isArray(value) && value.length > 0 && value.every(signed);
  let scrubbed = 0;
  const keep = (
    call: ProviderToolCall,
    args: Record<string, unknown>,
    next: Record<string, unknown> | string,
  ) => {
    if (next === args) return;
    call.writeArguments(next);
    scrubbed++;
  };
  for (const call of providerToolCalls(params)) {
    if (call.kind !== "function") continue;
    const { id, name, namespace } = call;
    if (
      params.ours.notice(name, namespace) ||
      NOTICE_TOOL_SPELLING.test(name)
    ) {
      const args = call.readArguments();
      if (!args) continue;
      // Our notice tool, or a record that names its own call: the call keeps
      // what it showed, the tool, its arguments and the ruling.
      if (
        params.ours.notice(name, namespace) ||
        (id !== undefined &&
          readNotice({ callId: id, arguments: args }) !== null)
      )
        keep(call, args, withoutMembers(args, NOTICE_PROXY_MEMBERS));
      else if (allSigned(args.offers))
        keep(call, args, withoutMembers(args, OFFERS_MEMBER));
      continue;
    }
    if (
      params.ours.control(name, namespace) ||
      CONTROL_TOOL_SPELLING.test(name)
    ) {
      const args = call.readArguments();
      if (!args) continue;
      // A lookalike's own payload or signature is its business; the JWS
      // members this deployment signed are ours wherever they sit.
      if (
        !params.ours.control(name, namespace) &&
        !signed({
          protected: args.protected,
          payload: args.payload,
          signature: args.signature,
        })
      )
        continue;
      const receipt =
        id === undefined
          ? null
          : readRemedyExecution({
              callId: id,
              toolName: name,
              namespace,
              arguments: args,
            });
      keep(
        call,
        args,
        receipt
          ? receipt.original_arguments
          : withoutMembers(args, CONTROL_PROXY_MEMBERS),
      );
      continue;
    }
    if (
      params.ours.askUser(name, namespace) ||
      ASK_USER_TOOL_SPELLING.test(name)
    ) {
      const args = call.readArguments();
      if (!args) continue;
      if (
        !params.ours.askUser(name, namespace) &&
        !allSigned(args.remedy_offers)
      )
        continue;
      keep(call, args, withoutMembers(args, ASK_USER_PROXY_ARGUMENTS));
    }
  }
  return scrubbed;
}

/**
 * Drops the proxy-only parameters from this platform's remedy and ask_user
 * declarations, as prepareAppaRequest does on the session path, for clients
 * holding a tool list fetched before the gateway stopped publishing them. The
 * notice keeps its record, which the gateway still advertises; only its signed
 * offers go. Only declarations the identity resolves count.
 */
function stripDeclaredProxyParameters(params: {
  body: unknown;
  ours: PlatformToolMatchers;
}): number {
  let stripped = 0;
  for (const { tool, name, namespace } of declaredToolEntries(params.body)) {
    if (name === undefined) continue;
    const members = params.ours.control(name, namespace)
      ? CONTROL_PROXY_MEMBERS
      : params.ours.askUser(name, namespace)
        ? ASK_USER_PROXY_ARGUMENTS
        : params.ours.notice(name, namespace)
          ? OFFERS_MEMBER
          : undefined;
    if (members && stripDeclaredParameters({ tool, names: members }))
      stripped++;
  }
  return stripped;
}

/** The arguments without `members`; the same object when it holds none of them. */
function withoutMembers(
  args: Record<string, unknown>,
  members: ReadonlySet<string>,
): Record<string, unknown> {
  const kept = Object.entries(args).filter(([key]) => !members.has(key));
  if (kept.length === Object.keys(args).length) return args;
  return copyOwnRecord(args, kept);
}

/** The wire a forwarded body is shaped as, read from the body alone. */
function forwardedWire(body: unknown): ProviderWire | undefined {
  const record = asRecord(body);
  if (!record) return undefined;
  if (Array.isArray(record.contents)) return "gemini:generateContent";
  if (record.input !== undefined) return "openai:responses";
  const messages = asArray(record.messages);
  if (!messages) return undefined;
  for (const message of messages) {
    const entry = asRecord(message);
    if (Array.isArray(entry?.tool_calls) || entry?.role === "tool")
      return "openai:chatCompletions";
    for (const part of asArray(entry?.content) ?? []) {
      const block = asRecord(part);
      if (block?.type === "tool_use" || block?.type === "tool_result")
        return "anthropic:messages";
      if (block && ("toolUse" in block || "toolResult" in block))
        return "bedrock:converse";
    }
  }
  // No tool traffic: the Anthropic and Chat Completions shapes read text alike.
  return "anthropic:messages";
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
  interactionType: string,
  declaration?: ProviderVisibleControlDeclaration,
): void {
  const holder = asRecord(body);
  if (!holder) return;
  const view = controlSchemaView(interactionType);
  const schema = declaration
    ? structuredClone(declaration.inputSchema)
    : { type: "object", properties: {} };
  const described = declaration ? { description: declaration.description } : {};
  if (view === "gemini") {
    appendGeminiDeclaration(holder, { name, ...described, parameters: schema });
    return;
  }
  if (view === "bedrock") {
    appendBedrockDeclaration(holder, {
      toolSpec: {
        name,
        ...described,
        inputSchema: { json: schema },
      },
    });
    return;
  }
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
        ...described,
        parameters: schema,
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
        ...described,
        parameters: schema,
      },
    ];
    return;
  }
  if (family === "openai:chatCompletions") {
    holder.tools = [
      ...declared,
      {
        type: "function",
        function: { name, ...described, parameters: schema },
      },
    ];
    return;
  }
  holder.tools = [...declared, { name, ...described, input_schema: schema }];
}

type ProviderVisibleControlDeclaration = {
  description: string;
  inputSchema: Record<string, unknown>;
};

let cachedControlDeclaration: ProviderVisibleControlDeclaration | undefined;

/** The MCP control tool the provider sees, without proxy-stamped parameters. */
function providerVisibleControlDeclaration(): ProviderVisibleControlDeclaration {
  if (cachedControlDeclaration) return cachedControlDeclaration;
  const tool = openappaMcpTools.find((entry) =>
    entry.name.endsWith(TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME),
  );
  const inputSchema = tool?.inputSchema;
  if (
    !tool?.description ||
    !inputSchema ||
    typeof inputSchema !== "object" ||
    Array.isArray(inputSchema)
  ) {
    throw new ApiError(
      500,
      "OpenAPPA cannot declare execute_remedy_plan without its canonical schema.",
    );
  }
  const schema = structuredClone(inputSchema) as Record<string, unknown>;
  const stamped = new Set<string>(
    PROXY_STAMPED_TOOL_ARGUMENTS[TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME],
  );
  const properties = asRecord(schema.properties);
  if (properties) {
    schema.properties = copyOwnRecord(
      properties,
      Object.entries(properties).filter(([name]) => !stamped.has(name)),
    );
  }
  if (Array.isArray(schema.required)) {
    schema.required = schema.required.filter(
      (name) => typeof name !== "string" || !stamped.has(name),
    );
  }
  cachedControlDeclaration = {
    description: tool.description,
    inputSchema: schema,
  };
  return cachedControlDeclaration;
}

function applyCanonicalControlDeclaration(params: {
  body: unknown;
  control: DeclaredToolSpelling;
  interactionType: string;
}): void {
  const canonical = providerVisibleControlDeclaration();
  const view = controlSchemaView(params.interactionType);
  for (const entry of declaredToolEntries(params.body)) {
    if (entry.name !== params.control.name) continue;
    if (entry.namespace !== params.control.namespace) continue;
    const tool = asRecord(entry.tool);
    if (!tool) continue;
    const nested =
      asRecord(tool.function) ??
      asRecord(tool.custom) ??
      asRecord(tool.toolSpec);
    if (nested && typeof nested.name === "string") {
      nested.description = canonical.description;
    } else if (entry.holder) {
      entry.holder.description = canonical.description;
    } else {
      tool.description = canonical.description;
    }
    writeCanonicalControlSchema(tool, canonical.inputSchema, view);
  }
}

type ControlSchemaView =
  | "anthropic"
  | "responses"
  | "chat"
  | "gemini"
  | "bedrock";

function controlSchemaView(interactionType: string): ControlSchemaView {
  if (interactionType === "gemini:generateContent") return "gemini";
  if (interactionType === "bedrock:converse") return "bedrock";
  const family = appaWireFamily(interactionType);
  if (family === "openai:responses") return "responses";
  if (family === "openai:chatCompletions") return "chat";
  return "anthropic";
}

function appendGeminiDeclaration(
  holder: Record<string, unknown>,
  declaration: Record<string, unknown>,
): void {
  const tools = holder.tools;
  const list = Array.isArray(tools)
    ? tools
    : asRecord(tools)
      ? [tools]
      : undefined;
  if (!list) return;
  const group = list.find((tool) =>
    Array.isArray(asRecord(tool)?.functionDeclarations),
  );
  const record = asRecord(group);
  if (record && Array.isArray(record.functionDeclarations)) {
    record.functionDeclarations = [...record.functionDeclarations, declaration];
    return;
  }
  const created = { functionDeclarations: [declaration] };
  holder.tools = Array.isArray(tools) ? [...list, created] : created;
}

function appendBedrockDeclaration(
  holder: Record<string, unknown>,
  declaration: Record<string, unknown>,
): void {
  const toolConfig = asRecord(holder.toolConfig) ?? {};
  const tools = Array.isArray(toolConfig.tools) ? toolConfig.tools : [];
  toolConfig.tools = [...tools, declaration];
  holder.toolConfig = toolConfig;
}

function writeCanonicalControlSchema(
  tool: Record<string, unknown>,
  schema: Record<string, unknown>,
  view: ControlSchemaView,
): void {
  const assign = (parent: Record<string, unknown>, key: string) => {
    parent[key] = structuredClone(schema);
  };
  if (view === "gemini") delete tool.input_schema;
  let wrote = false;
  if ("input_schema" in tool) {
    assign(tool, "input_schema");
    wrote = true;
  }
  if ("parameters" in tool) {
    assign(tool, "parameters");
    wrote = true;
  }
  if ("parametersJsonSchema" in tool) {
    assign(tool, "parametersJsonSchema");
    wrote = true;
  }
  const fn = asRecord(tool.function);
  if (fn && "parameters" in fn) {
    assign(fn, "parameters");
    wrote = true;
  }
  const spec = asRecord(tool.toolSpec);
  const input = asRecord(spec?.inputSchema);
  if (input && "json" in input) {
    assign(input, "json");
    wrote = true;
  }
  if (wrote) return;
  if (fn) {
    assign(fn, "parameters");
    return;
  }
  if (spec) {
    const created = asRecord(spec.inputSchema) ?? {};
    spec.inputSchema = created;
    assign(created, "json");
    return;
  }
  if (tool.type === "function" || view === "responses") {
    assign(tool, "parameters");
    return;
  }
  if (view === "gemini") {
    assign(tool, "parameters");
    return;
  }
  if (view === "bedrock") {
    const created = {};
    tool.toolSpec = { name: tool.name, inputSchema: created };
    assign(created, "json");
    return;
  }
  assign(tool, "input_schema");
}

/** Refuses sessions where tools are deferred to a provider tool search. */
function refuseDeferredTools(declared: readonly unknown[]): void {
  const deferred = declared.some((tool) => {
    const declaration = asToolDeclaration(tool);
    return (
      declaration?.type === "tool_search" ||
      declaration?.type?.startsWith("tool_search_tool_") === true ||
      declaration?.defer_loading === true
    );
  });
  if (deferred) {
    throw new ApiError(
      400,
      "OpenAPPA cannot govern a session that defers its tools to a tool search; the tools it may call are not on the wire. Configure the client to declare its tools inline, or disable OpenAPPA for this client.",
    );
  }
}

function refuseUnsupportedToolTypes(declared: readonly unknown[]): void {
  for (const tool of declared) {
    const type = asToolDeclaration(tool)?.type;
    if (typeof type !== "string") continue;
    if (
      ["local_shell", "computer_use_preview", "computer_use"].includes(type)
    ) {
      throw new ApiError(
        400,
        `OpenAPPA cannot govern client-executed tool type \`${type}\` on this wire; its calls are not intercepted by the proxy.`,
      );
    }
    if (!providerHostedTool(tool) && !isClientRunToolType(type)) {
      throw new ApiError(
        400,
        `OpenAPPA cannot classify tool type \`${type}\` as provider-hosted or client-executed; declare a supported tool type before retrying.`,
      );
    }
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
  defer_loading?: boolean;
  name?: string;
  format?: unknown;
  additional_tools?: unknown;
  input?: unknown;
  tools?: unknown;
};

const GEMINI_HOSTED_TOOL_KEYS = new Set([
  "googleSearchRetrieval",
  "googleSearch",
  "codeExecution",
  "urlContext",
  "googleMaps",
  "enterpriseWebSearch",
  "fileSearch",
]);

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
