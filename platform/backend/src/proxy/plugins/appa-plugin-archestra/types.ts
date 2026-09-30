import type { IncomingHttpHeaders } from "node:http";
import type { AppaPreparedRequest } from "@/openappa/request";
import type { AppaChatSource, OpenAppaSession } from "@/openappa/service";
import type { AppaSessionIdentity } from "@/openappa/wire";
import type { GatewayToolIdentity } from "@/routes/proxy/utils/gateway-tool-names";
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
  /**
   * Raw X-Appa-* headers from the client before proxy derivation.
   * Child lineage checks compare against these claims.
   */
  claims?: { sessionId?: string; parentId?: string };
  /** Present only for the proxy's loopback Chat call path. */
  chatSource?: AppaChatSource;
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
    rulingFromResult?(result: NativeQuestionResult): NativeQuestionRuling;
  };
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
export type AppaRelayArrival = {
  kind: "teammate" | "agent" | "coordinator" | "session";
  /** The sender as the client names it. */
  from: string;
  /** The message as its envelope carries it. */
  body: string;
  /** The model has replied since this message arrived. */
  answered: boolean;
  /**
   * Keeps the text the records show its sender sent here. Records are the
   * retained values. The rest is withheld in the request the model reads,
   * unless `unchecked` is "keep": a message the model already read while
   * OpenAPPA was not checking stays as read, with a note saying so.
   */
  admit(
    records: readonly string[],
    unchecked?: "withhold" | "keep",
  ): { withheld: boolean };
};

/** The arguments of the platform's ask_user tool. */
export type AskUserArguments = {
  question: string;
  /** Short tab label; unvalidated here, as the model wrote it. */
  header?: unknown;
  options: Array<{ label: string; description?: string }>;
  allowMultiple?: boolean;
  remedy_offer_ids?: string[];
};

export type NativeQuestionResult = {
  content: string;
  isError?: boolean;
};

export type NativeQuestionRuling = "approve" | "deny" | "none";
