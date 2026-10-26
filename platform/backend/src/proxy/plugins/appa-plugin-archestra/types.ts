import type { IncomingHttpHeaders } from "node:http";
import type { AppaPreparedRequest } from "@/openappa/request";
import type { AppaChatSource, OpenAppaSession } from "@/openappa/service";
import type { AppaSessionIdentity } from "@/openappa/wire";
import type { GatewayToolIdentity } from "@/routes/proxy/utils/gateway-tool-names";
import type { ApiError } from "@/types/api";
import type { CommonToolResult } from "@/types/common-llm-format";

export const APPA_PLUGIN_TRUSTED_CONTEXT: unique symbol = Symbol(
  "archestra.appa.trusted-context",
);

export const APPA_CHILD_TRAJECTORY_RECEIPT: unique symbol = Symbol(
  "archestra.appa.child-trajectory-receipt",
);

export type AppaChildTrajectoryReceiptOutput = {
  footer: string;
  inHistory: boolean;
};

export type AppaTrustedContext = {
  /** Established by the proxy after authentication and session-root validation. */
  session: OpenAppaSession;
  profileId: string;
  /** Which of the request's tools are this platform's gateway tools, and as what. */
  toolIdentity: Pick<
    GatewayToolIdentity,
    "canonicalize" | "attestationOf" | "looseRunToolDispatch"
  >;
  /** What the proxy prepared for this request before any adapter saw it. */
  request: AppaPreparedRequest;
  /** Server-recognized client maintenance, not a child completion. */
  compaction?: boolean;
  /** Stable teammate identity from this caller's allowed native spawn. */
  claudeTeammateNativeId?: string;
  /**
   * Raw X-Appa-* headers from the client before proxy derivation.
   * Child lineage checks compare against these claims.
   */
  claims?: { sessionId?: string; parentId?: string };
  /**
   * Persisted workspace session (`caller|workload`), including its stored
   * parent. Not a client header. Native child session ids do not equal it.
   */
  runtimeSessionId?: string;
  /** Current task from the authenticated runtime credential, not a request header. */
  runtimeTaskId?: string;
  /** Present only for the proxy's loopback Chat call path. */
  chatSource?: AppaChatSource;
  /**
   * Activation captured for this request. Later phases must not re-read the
   * switch, so a change between requests does not land mid-stream.
   */
  enforcement?: "active" | "inactive";
  /**
   * The provider-thread step of this request, when it carries one. A continue
   * is a delta: the thread already holds the system prompt, so guidance that
   * is fixed for the session is not repeated and per-turn guidance travels in
   * the new user turn.
   */
  thread?: "create" | "continue";
  /** Deferred until the adapter has authenticated the unchanged session lineage. */
  childReturnRefusal?: ApiError;
};

export type AppaMatchContext = {
  headers: Readonly<Record<string, string | string[] | undefined>>;
  requestBody: unknown;
  trustedContext?: AppaTrustedContext;
};

/**
 * Server-minted child identity. `sessionId` identifies the child.
 * `parentId` identifies the spawner trajectory: the root for a direct child,
 * or an intermediate child for a grandchild.
 */
export type AppaChildTrajectory = {
  sessionId: string;
  parentId: string;
  /** Where the lineage came from, and the native ids it was bound for. */
  lineage?: {
    source: "receipt" | "marker" | "native";
    nativeParentId: string;
    /** Actual client-native child ID, when the client reports one. */
    childNativeId?: string;
    /** Original conversation for a server-correlated split-pane teammate. */
    nativeConversationId?: string;
    /** Signed spawn correlation. Marker-only children use this without generating a fake native ID. */
    spawnCallId?: string;
    /** Digest of the opening prompt the verified delegation marker closes. */
    spawnPromptDigest?: string;
  };
};

/**
 * The argument of a spawn call that carries the child's opening prompt, and
 * how a delegation marker joins it: appended to the text, or pushed onto the
 * item list as a text item of its own.
 */
export type AppaSpawnPromptField = {
  field: string;
  kind: "text" | "items";
};

export type AppaSpawnResultDisposition = "pending" | "failed";

export type AppaClientAdapter = {
  readonly id: string;
  /** Prefix for this client's native spawn/child namespace. */
  readonly trajectoryPrefix: string;
  /** Client signals select tool syntax, not authority; they may be spoofed. */
  matches(context: AppaMatchContext): boolean;
  /** `namespace` is the tool group the request declared the name under, if any. */
  classifyToolName(name: string, namespace?: string): "gateway" | "local";
  normalizeLocalToolName(name: string): string;
  /**
   * The client's own question tool. Its results need the same decision
   * guidance as ask_user. Clients without MCP forms may also provide an
   * argument converter to receive ask_user calls through their native tool.
   */
  nativeQuestion?: {
    toolName: string;
    isAvailable?(headers: IncomingHttpHeaders): boolean;
    supportsMultiple?: boolean;
    fromAskUser?(args: AskUserArguments): Record<string, unknown>;
    /**
     * Approve or Deny from the tool's result. `asked` is the question the
     * platform wrote for the review; the ruling is read against it, never
     * found by a search of the result text.
     */
    rulingFromResult?(
      result: NativeQuestionResult,
      asked: AskUserArguments,
    ): NativeQuestionReading;
    /**
     * The client also shows the gateway's MCP form (elicitation), which
     * returns the choice as data. An answer in a wording the proxy does not
     * know is then asked once more there. A known no-answer is not asked again.
     */
    formFallback?: boolean;
  };
  /**
   * The client's own tool that waits for MCP servers which are still
   * connecting. The client declares it when it sends requests before its tool
   * list is complete. The call takes no arguments and changes nothing, so it
   * can carry a denial while the gateway notice tool is not declared yet.
   */
  readonly pendingServersTool?: string;
  /**
   * On the Anthropic Messages wire, the client answers a call to a tool it
   * never declared with an error result and goes on with its turn. A denial
   * then reaches the model through an undeclared notice call, which the next
   * request restores, while no notice tool is declared.
   */
  readonly answersUndeclaredCalls?: true;
  /**
   * What the person does when this client sends a request without the
   * gateway's tools: where to see the gateway's state in the client, how to
   * sign in to it, and whether to resend or start a new session. Shown with a
   * denial the proxy cannot turn into a remedy. `serverName` is the gateway
   * as the client lists it.
   */
  gatewayToolsHint?(serverName: string): string;
  /**
   * Reads the trajectory identity the client itself puts on the wire: the id
   * it keeps stable across a resumed or compacted conversation, so a resume
   * reopens the same OpenAPPA root. A fork or an out-of-band summarizer gets a
   * new id, but the history it replays carries the parent's trajectory stamps,
   * which continue the parent's root instead (`openappa/trajectory-stamp.ts`).
   * Runs before the generic wire-family fallbacks; returning
   * `undefined` defers to them. A request whose native signals contradict
   * each other is refused rather than bound to a trajectory chosen by
   * precedence.
   *
   * Client forks stay on this identity. Delegated children are rebound
   * separately by `bindChildTrajectory` and must not reuse this path.
   */
  extractSessionIdentity?(
    context: AppaMatchContext,
  ): AppaSessionIdentity | undefined;
  /** Native parent named by a spawn-prepared child request, if any. */
  nativeSpawnParentId?(
    context: AppaMatchContext,
    sessionId: string,
  ): string | undefined;
  /** True when this local tool starts a delegated child run. */
  isSpawnTool(name: string, namespace?: string): boolean;
  /**
   * Classifies a native spawn launch result. A successful launch stays
   * pending until the child binds the prepared fork. A failed launch closes
   * the fork so the parent can retry.
   */
  classifySpawnResult?(
    result: CommonToolResult,
  ): AppaSpawnResultDisposition | undefined;
  /** True when this local tool returns completed child output to the parent. */
  isChildCompletionResult?(result: CommonToolResult): boolean;
  /** Returns bounded launch metadata and strips arbitrary acknowledgment text. */
  normalizeChildLaunchResult?(result: CommonToolResult): string | undefined;
  /**
   * Reads a native message between agents of one session, such as a
   * teammate writing to its lead. `to` is the recipient as the client names
   * it; `value` is the message text the runtime checks and retains.
   */
  relayMessage?(call: {
    name: string;
    arguments: unknown;
  }): AppaRelayMessage | undefined;
  /** True for the local tool that sends messages between agents. */
  isRelayTool?(name: string): boolean;
  /** True when a message call's result is only the client's delivery receipt. */
  isRelayReceipt?(content: unknown): boolean;
  /**
   * Admits the report a message call returned from an agent it resumed,
   * against the values this session's children are on record for returning.
   */
  admitRelayReport?(
    content: unknown,
    records: readonly string[],
  ): { content: unknown; withheld: boolean };
  /** Rewrites a native message call so the recipient gets `value` instead. */
  rewriteRelayMessage?(args: unknown, value: string): string;
  /**
   * The messages that arrived in this request's history from other agents,
   * each with a setter that replaces the message text the model reads.
   */
  relayArrivals?(requestBody: unknown): AppaRelayArrival[];
  /** The teammates the history's launch receipts name, by name. */
  teammateLaunches?(requestBody: unknown): Map<string, AppaTeammateLaunch>;
  /**
   * The teammate a durable launch receipt names. Used when compaction has
   * dropped the receipt from the request but the runtime still retained it.
   */
  launchIdentity?(
    text: string,
  ): { name: string; childNativeId: string } | undefined;
  /** The name a spawn call gives the teammate it starts, if it names one. */
  teammateName?(call: { name: string; arguments: unknown }): string | undefined;
  /**
   * True for a child that reports to its parent in messages rather than in
   * the result of the call that started it: a teammate.
   */
  isTeammate?(childNativeId: string): boolean;
  /** True when this local tool is the child's return to its parent. */
  isChildHandbackTool?(name: string): boolean;
  /** Payload carried by a native child handback call. */
  childHandbackValue?(args: unknown): string | undefined;
  /** Rewrites a native handback so the parent receives admitted bytes and a marker. */
  rewriteChildHandback?(
    args: unknown,
    admitted: string,
  ): string | Record<string, unknown>;
  /**
   * Identifies the prompt argument in a spawn tool call.
   * Returns undefined if the tool executes within the parent trajectory.
   */
  spawnPromptField(
    name: string,
    args: Record<string, unknown>,
  ): AppaSpawnPromptField | undefined;
  /**
   * Argument names the current native spawn declaration rejects.
   * Absent when this client has no closed schema for the call.
   */
  unsupportedSpawnFields?(params: {
    requestBody: unknown;
    name: string;
    namespace?: string;
    arguments: unknown;
  }): string[] | undefined;
  /** Native conversation ID that child subagents report as their parent. */
  nativeConversationId(context: AppaMatchContext): string | undefined;
  /**
   * Identifies child trajectories named in tool arguments.
   * Uses the same namespace that bindChildTrajectory generates.
   */
  namesChildren(params: { rootId: string; arguments: unknown }): string[];
  /** File paths that contain raw child transcript or output data. */
  childTranscriptPaths?: ReadonlyArray<{ prefix: string; suffix: string }>;
  /**
   * Binds a child request to a server-minted trajectory.
   * Returns undefined for root requests. Resolves lineage from a verified
   * trajectory receipt, a delegation marker, or the native parent ID.
   * Throws when correlation headers are missing, reused, or contradictory.
   *
   * Never sets `fork_of`. Client forks stay on `extractSessionIdentity`.
   */
  bindChildTrajectory(
    context: AppaMatchContext,
  ): AppaChildTrajectory | undefined;
  /** Remove native child-carrier fields from a provider request body. */
  stripCarrierMetadata(request: unknown): void;
};

/** A message one agent sends another through the client. */
export type AppaRelayMessage = {
  /** The recipient: the lead, a teammate's name, or another session. */
  to: AppaRelayRecipient;
  value: string;
  /** A protocol message (such as a shutdown request) rather than free text. */
  structured: boolean;
};

export type AppaRelayRecipient =
  | { kind: "lead" }
  | { kind: "teammate"; name: string }
  | { kind: "session"; id: string }
  | { kind: "broadcast" };

/** A teammate a launch receipt names: its child id, and the call that launched it. */
export type AppaTeammateLaunch = { childNativeId: string; spawnCallId: string };

/**
 * A message the client delivered into a conversation from another agent: a
 * teammate's or the lead's message, a subagent's message or hand-back, the
 * main conversation's word to a background agent, or another session's.
 */
/** A free-text peer trailer. Malformed trailers must not use historic matching. */
export type AppaPeerTrailer =
  | { messageId: string; value: string }
  | "malformed";

export type AppaRelayArrival = {
  kind: "teammate" | "agent" | "coordinator" | "session";
  /** The sender as the client names it. */
  from: string;
  /** The message as its envelope carries it. */
  body: string;
  /**
   * A peer-message trailer at the end of the body. Present only for new
   * sends. Historic matching must not run when this is set.
   */
  peer?: AppaPeerTrailer;
  /** A shutdown or plan body. It has no safe id slot and must stay byte-stable. */
  structured: boolean;
  /** Harness fields only, with no agent text. The proxy leaves this body unchanged. */
  harnessOnly?: boolean;
  /** Exact retained receipt. A field that merely equals an older string does not count. */
  recorded?(records: readonly string[]): boolean;
  /**
   * Keeps the text the records show its sender sent here, and withholds the
   * rest in the request the model reads. Records are the retained values.
   */
  admit(records: readonly string[]): { withheld: boolean };
  /** Replaces the text the model reads. Does not decide whether it crossed. */
  replace(text: string): void;
};

/** The arguments of the platform's ask_user tool. */
export type AskUserArguments = {
  question: string;
  /**
   * For a server-held review only: the one-line question for hosts with
   * option previews (Claude Code), and the preview of the call each option
   * shows. Together they carry what `question` spells out.
   */
  shortQuestion?: string;
  callPreview?: string;
  /** Short tab label; unvalidated here, as the model wrote it. */
  header?: unknown;
  /** A server-held review's option `preview` replaces its `callPreview`. */
  options: Array<{ label: string; description?: string; preview?: string }>;
  allowMultiple?: boolean;
  remedy_offer_ids?: string[];
};

export type NativeQuestionResult = {
  content: string;
  isError?: boolean;
};

export type NativeQuestionRuling = "approve" | "deny" | "none";

/** A known terminal no-answer. It is not a human ruling and is not asked again. */
export type NativeQuestionNoAnswer =
  | "declined"
  | "cancelled"
  | "unanswered"
  | "unavailable";

/**
 * A ruling, a known no-answer, or "unrecognized" for a wording the adapter
 * does not know. An unrecognized answer is never read as a choice. Only that
 * unrecognized wording may fall back to a form; a known no-answer may not.
 */
export type NativeQuestionReading =
  | NativeQuestionRuling
  | NativeQuestionNoAnswer
  | "unrecognized";
