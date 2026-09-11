import { createHash, createHmac, randomUUID } from "node:crypto";
import { AppaRuntimeClient, AppaRuntimeError } from "@/clients/appa-runtime";
import logger from "@/logging";
import {
  AppaApprovalModel,
  AppaProxySessionModel,
  AppaProxySessionProtocolError,
} from "@/models";
import {
  normalizeNativeCodexWriteStdinArguments,
  persistNativeCodexProcessRoute,
  routeNativeCodexWriteStdinResult,
} from "@/services/appa-codex-process-routing";
import type { AppaHistoryProtocol } from "@/services/appa-history-codec";
import { AppaProxyLedger } from "@/services/appa-proxy/ledger";
import { AppaProxyPhaseTrace } from "@/services/appa-proxy-phase-trace";
import { AppaResponseFrame } from "@/services/appa-response-frame";
import { inspectCodexShellOutput } from "./appa-codex-shell";

const MAX_HOOK_RESPONSE_BYTES = 64 * 1024;
const MAX_SPAWN_BINDINGS = 16;
const MAX_SPAWN_BINDING_BYTES = 256;
const MAX_SPAWN_BINDINGS_HEADER_BYTES = 4096;

export type AppaProxyHookConfig = {
  url: string;
  timeoutMs: number;
  sessionHmacSecret: string;
  /** Presence opts the runtime into the authenticated v1 envelope protocol. */
  runtimeToken?: string;
  approvalSigningSecret?: string;
  autoAcceptRestrictions?: boolean;
  maxCallsPerSession?: number;
  maxSessionsPerOwner?: number;
  /** Enables the experimental native Codex bridge. Disabled unless explicitly set. */
  nativeCodexEnabled?: boolean;
};

export type AppaInboundToolResult = {
  id: string;
  content: unknown;
  isError?: boolean;
  status?: "success" | "failure" | "indeterminate";
  message?: string;
  claimedCall?: {
    name: string;
    rawArguments: string;
  };
};

export type AppaOutboundToolCall = {
  id: string;
  emittedName: string;
  emittedArguments: string;
  emittedArgumentsCanonical: string;
  targetName: string;
  targetArguments: Record<string, unknown>;
  spawn?: boolean;
};

type AppaOffer = {
  offer_id: string;
  kind:
    | "acceptance"
    | "human_approval"
    | "authority"
    | "sanitizer"
    | "unsupported";
  root_id: string;
  tool: string;
  arguments_sha256: string;
};

export class AppaProxyHookError extends Error {
  constructor(
    readonly kind: "denied" | "unavailable",
    readonly stage: "input" | "outbound" | "turn_end",
  ) {
    super(
      kind === "denied"
        ? "OpenAPPA hook denied the request"
        : "OpenAPPA hook outcome is unknown",
    );
    this.name = "AppaProxyHookError";
  }
}

/**
 * A durable APPA turn. The database is the authority for the root and every
 * client-emitted call id; a remote outcome that cannot be proven quarantines
 * the session rather than replaying an event against a non-idempotent runtime.
 */
export class AppaProxyHookSession {
  readonly rootId: string;

  private closed = false;
  private activeCall: AppaOutboundToolCall | undefined;
  private pendingApprovalId: string | undefined;
  private authorizedSpawnBindings = new Map<string, string>();
  private undeliveredAuthorizedCalls = false;
  private v1CapabilitiesChecked = false;
  private capabilities = {
    restrictions: false,
    humanApprovals: false,
    sanitizedResults: false,
    childWorkflows: false,
  };
  private approvalExpiresAt: number | undefined;
  private readonly modelResultUpdates = new Map<string, string>();
  private readonly phaseTrace: AppaProxyPhaseTrace | undefined;
  private lastValidatedRuntimeReceipt:
    | { id: string; sha256: string }
    | undefined;
  private authorizedCallIdsAwaitingWrite: string[] = [];
  private admittedCallIdsAwaitingContinuationWrite: string[] = [];
  private continuationResponseReady = false;
  private readonly config: AppaProxyHookConfig;
  private readonly turn: Awaited<
    ReturnType<typeof AppaProxySessionModel.enterTurn>
  >;
  private readonly organizationId: string | undefined;
  private readonly requestSignal: AbortSignal | undefined;
  /**
   * Codex-only receipts bind rewritten `call_appa_*` identifiers. Other native
   * clients retain their own issued IDs and must submit their result to APPA.
   */
  private readonly nativeCodexExecution: boolean;

  private constructor(params: {
    config: AppaProxyHookConfig;
    turn: Awaited<ReturnType<typeof AppaProxySessionModel.enterTurn>>;
    organizationId?: string;
    nativeCodexExecution?: boolean;
    signal?: AbortSignal;
    traceId?: string;
  }) {
    this.config = params.config;
    this.turn = params.turn;
    this.organizationId = params.organizationId;
    this.nativeCodexExecution =
      params.nativeCodexExecution ?? params.config.nativeCodexEnabled === true;
    this.requestSignal = params.signal;
    this.rootId = params.turn.session.rootId;
    this.phaseTrace = params.config.runtimeToken
      ? new AppaProxyPhaseTrace({
          traceId: params.traceId,
          ownerScopeHash: params.turn.session.ownerScopeHash,
          provider: params.turn.session.provider ?? "direct",
          protocol: params.turn.session.protocol ?? "direct",
          sessionId: params.turn.session.clientSessionId,
        })
      : undefined;
  }

  static async open(params: {
    config: AppaProxyHookConfig;
    profileId: string;
    organizationId?: string;
    ownerScopeHash: string;
    clientSessionId: string;
    parentClientSessionId?: string;
    spawnBinding?: string;
    modelInput: unknown;
    provider?: string;
    protocol?: AppaHistoryProtocol;
    model?: string;
    /** Enables Codex-issued durable gateway receipt substitution for this turn. */
    nativeCodexExecution?: boolean;
    toolResults: AppaInboundToolResult[];
    prepareInboundResults?: (
      results: readonly AppaInboundToolResult[],
      session: AppaProxyHookSession,
    ) => Promise<AppaInboundToolResult[]>;
    signal?: AbortSignal;
    /** W3C trace id from the proxied request, retained only as a SHA-256 log field. */
    traceId?: string;
  }): Promise<AppaProxyHookSession> {
    const session = await AppaProxyHookSession.acquire(params);
    try {
      await session.sendPrompt(params.modelInput);
      return session;
    } catch (error) {
      await session.closeAfterKnownFailure(error);
      throw error;
    }
  }

  static async acquire(params: {
    config: AppaProxyHookConfig;
    profileId: string;
    organizationId?: string;
    ownerScopeHash: string;
    clientSessionId: string;
    parentClientSessionId?: string;
    spawnBinding?: string;
    toolResults: AppaInboundToolResult[];
    provider?: string;
    protocol?: AppaHistoryProtocol;
    model?: string;
    /**
     * Trusted protocol adapters can validate and restore client wire aliases
     * before APPA hashes or admits the result. It must never classify content.
     */
    prepareInboundResults?: (
      results: readonly AppaInboundToolResult[],
      session: AppaProxyHookSession,
    ) => Promise<AppaInboundToolResult[]>;
    /** A verified prior response checkpoint for a newly-attached client root. */
    forkCheckpointId?: string;
    /** The target root is generated locally before the authenticated fork call. */
    rootId?: string;
    /** Enables Codex-issued durable gateway receipt substitution for this turn. */
    nativeCodexExecution?: boolean;
    signal?: AbortSignal;
    traceId?: string;
  }): Promise<AppaProxyHookSession> {
    const turn = await AppaProxySessionModel.enterTurn({
      profileId: params.profileId,
      ownerScopeHash: params.ownerScopeHash,
      clientSessionId: params.clientSessionId,
      parentClientSessionId: params.parentClientSessionId,
      spawnBinding: params.spawnBinding,
      rootId: params.rootId ?? `archestra-proxy:${randomUUID()}`,
      turnId: randomUUID(),
      maxSessionsPerOwner: params.config.maxSessionsPerOwner ?? 100,
      binding: {
        provider: params.provider ?? "direct",
        protocol: params.protocol ?? "direct",
        model: params.model ?? "direct",
      },
    });
    const session = new AppaProxyHookSession({
      config: params.config,
      turn,
      organizationId: params.organizationId,
      nativeCodexExecution: params.nativeCodexExecution,
      signal: params.signal,
      traceId: params.traceId,
    });

    try {
      if (params.forkCheckpointId && turn.created) {
        await session.attachCheckpointFork(params.forkCheckpointId);
      }
      const inboundResults = params.prepareInboundResults
        ? await params.prepareInboundResults(params.toolResults, session)
        : params.toolResults;
      const preparedResults =
        await session.prepareInboundResults(inboundResults);
      if (preparedResults.length > 0 && !turn.session.rootInitializedAt) {
        throw new AppaProxySessionProtocolError(
          "tool result has no initialized APPA root",
        );
      }
      // Admission happens before content classifiers. It hashes and sends the
      // unmodified client result once; later Archestra transforms only affect
      // the prompt delivered to the model.
      await session.admitInboundResults(preparedResults);
      return session;
    } catch (error) {
      await session.closeAfterKnownFailure(error);
      throw error;
    }
  }

  /**
   * Restores only an already-authenticated, already-held turn for the remedy
   * loop. Callers must derive this scope from server-owned wire metadata, never
   * from a model-supplied user or thread header.
   */
  static async claimHeldContinuation(params: {
    config: AppaProxyHookConfig;
    sessionId: string;
    ownerScopeHash: string;
    turnId: string;
    organizationId?: string;
    signal?: AbortSignal;
    traceId?: string;
  }): Promise<AppaProxyHookSession> {
    const turn = await AppaProxySessionModel.claimHeldTurn(params);
    return new AppaProxyHookSession({
      config: params.config,
      turn,
      organizationId: params.organizationId,
      signal: params.signal,
      traceId: params.traceId,
    });
  }

  async sendPrompt(modelInput: unknown): Promise<void> {
    if (this.closed) {
      throw new AppaProxySessionProtocolError("APPA turn is already closed");
    }
    try {
      await this.ensureV1Capabilities();
      if (this.turn.session.parentSessionId) {
        if (!this.turn.session.childStartedAt) {
          if (!this.capabilities.childWorkflows) {
            throw new AppaProxyHookError("unavailable", "input");
          }
          const spawnBinding = await AppaProxySessionModel.getChildSpawnBinding(
            this.turn,
          );
          if (!spawnBinding) {
            throw new AppaProxySessionProtocolError(
              "child thread has no authorized spawn binding",
            );
          }
          await this.post(
            {
              event: "child_start",
              root_id: this.rootId,
              child_id: this.turn.session.clientSessionId,
              spawn_binding: spawnBinding,
            },
            "ack",
            "input",
          );
          await AppaProxySessionModel.markChildStarted(this.turn);
          this.turn.session.childStartedAt = new Date();
        }
      } else if (!this.turn.session.rootInitializedAt) {
        await this.post(
          { event: "session_start", root_id: this.rootId },
          "ack",
          "input",
        );
        await AppaProxySessionModel.markRootInitialized(this.turn);
        this.turn.session.rootInitializedAt = new Date();
      }
      await this.post(
        {
          event: "prompt",
          root_id: this.rootId,
          text: JSON.stringify(modelInput),
        },
        "ack",
        "input",
      );
    } catch (error) {
      await this.closeAfterKnownFailure(error);
      throw error;
    }
  }

  async authorizeOutboundToolCalls(
    toolCalls: AppaOutboundToolCall[],
    options?: {
      prepareSpawn?: (
        call: AppaOutboundToolCall,
      ) => Promise<AppaOutboundToolCall>;
    },
  ): Promise<AppaOutboundToolCall[]> {
    if (toolCalls.length === 0) return toolCalls;
    if (
      toolCalls.filter((toolCall) => toolCall.spawn).length > MAX_SPAWN_BINDINGS
    ) {
      throw new AppaProxySessionProtocolError(
        "too many spawned child workflows in one APPA batch",
      );
    }
    if (
      !this.config.runtimeToken &&
      toolCalls.some((toolCall) => toolCall.spawn)
    ) {
      throw new AppaProxyHookError("denied", "outbound");
    }
    if (
      toolCalls.some(
        (toolCall) =>
          Buffer.byteLength(toolCall.emittedArguments, "utf8") > 64 * 1024,
      )
    ) {
      throw new AppaProxySessionProtocolError(
        "tool call arguments exceed the 64 KiB APPA session limit",
      );
    }
    await AppaProxySessionModel.createOutboundIntent({
      turn: this.turn,
      calls: toolCalls.map((toolCall) => ({
        callId: toolCall.id,
        emittedName: toolCall.emittedName,
        emittedArguments: toolCall.emittedArguments,
        emittedArgumentsCanonical: toolCall.emittedArgumentsCanonical,
        appaTargetName: toolCall.targetName,
        appaTargetArguments: toolCall.targetArguments,
      })),
      maxCallsPerSession: this.config.maxCallsPerSession ?? 1000,
    });

    // The original client proposal is now immutable durable evidence. A native
    // spawn carrier may be prepared only from that intent, before the runtime
    // sees or authorizes the client-visible execution arguments.
    const effectiveToolCalls: AppaOutboundToolCall[] = [];
    for (const call of toolCalls) {
      effectiveToolCalls.push(
        call.spawn && options?.prepareSpawn
          ? await options.prepareSpawn(call)
          : call,
      );
    }

    try {
      if (this.config.runtimeToken) {
        const authorizedCalls = await this.authorizeV1Batch(effectiveToolCalls);
        if (
          this.requestSignal?.aborted ||
          (this.approvalExpiresAt !== undefined &&
            Date.now() >= this.approvalExpiresAt)
        ) {
          throw new AppaProxyHookError("denied", "outbound");
        }
        await AppaProxySessionModel.approveOutboundCallBatch({
          turn: this.turn,
          calls: authorizedCalls.map((authorizedCall, index) => ({
            ...authorizedCall,
            effectiveCall: toOutboundCall(effectiveToolCalls[index]),
          })),
        });
        for (const authorizedCall of authorizedCalls) {
          if (authorizedCall.spawnBinding) {
            this.authorizedSpawnBindings.set(
              authorizedCall.callId,
              authorizedCall.spawnBinding,
            );
          }
        }
        const receipt = this.lastValidatedRuntimeReceipt;
        if (!receipt) {
          throw new AppaProxyHookError("unavailable", "outbound");
        }
        this.phaseTrace?.authorizationReceipt({
          callIds: authorizedCalls.map((call) => call.callId),
          receipt,
        });
        this.authorizedCallIdsAwaitingWrite.push(
          ...authorizedCalls.map((call) => call.callId),
        );
        this.undeliveredAuthorizedCalls = true;
        return effectiveToolCalls;
      }
      // The legacy unauthenticated hook has no atomic batch operation. Never
      // open only a prefix of a client-visible batch against that transport.
      if (toolCalls.length > 1) {
        throw new AppaProxyHookError("denied", "outbound");
      }
      for (const toolCall of effectiveToolCalls) {
        this.activeCall = toolCall;
        await this.post(
          {
            event: "tool_call",
            root_id: this.rootId,
            tool: toolCall.targetName,
            arguments: toolCall.targetArguments,
            spawn: toolCall.spawn === true,
          },
          "allow_call",
          "outbound",
        );
        this.activeCall = undefined;
      }
      if (
        this.requestSignal?.aborted ||
        (this.approvalExpiresAt !== undefined &&
          Date.now() >= this.approvalExpiresAt)
      ) {
        throw new AppaProxyHookError("denied", "outbound");
      }
      await AppaProxySessionModel.approveOutboundCalls(
        this.turn,
        effectiveToolCalls.map((toolCall) => toolCall.id),
      );
      this.undeliveredAuthorizedCalls = true;
      return effectiveToolCalls;
    } catch (error) {
      if (error instanceof AppaProxyHookError && error.kind === "denied") {
        await AppaProxySessionModel.denyOutboundCalls(
          this.turn,
          toolCalls.map((toolCall) => toolCall.id),
        );
      } else {
        await this.closeAfterKnownFailure(
          error instanceof AppaProxyHookError
            ? error
            : new AppaProxyHookError("unavailable", "outbound"),
        );
      }
      throw error;
    }
  }

  async finish(params?: {
    childReturn?: string;
    /**
     * Trusted persistence runs after APPA has accepted the turn boundary, but
     * before another request can acquire this local turn.
     */
    beforeRelease?: () => Promise<void>;
  }): Promise<void> {
    if (this.closed) return;
    const hasOutstandingCall = (
      await AppaProxySessionModel.listCalls(this.turn.session.id)
    ).some((call) => call.state === "open");
    if (hasOutstandingCall) {
      // Do not call turn_end while the client executes the emitted tool. The
      // next request posts the matched result against this still-open turn.
      try {
        await this.runBeforeRelease(params?.beforeRelease);
        await AppaProxySessionModel.releaseTurn(this.turn);
        this.closed = true;
      } catch (error) {
        const uncertain =
          error instanceof AppaProxyHookError
            ? error
            : new AppaProxyHookError("unavailable", "turn_end");
        await this.closeAfterKnownFailure(uncertain);
        throw uncertain;
      }
      return;
    }
    try {
      if (this.turn.session.parentSessionId) {
        if (!this.turn.session.childStartedAt) {
          throw new AppaProxySessionProtocolError(
            "child thread ended before APPA child lifecycle started",
          );
        }
        await this.post(
          {
            event: "child_end",
            root_id: this.rootId,
            child_id: this.turn.session.clientSessionId,
            ...(params?.childReturn !== undefined
              ? { value: params.childReturn }
              : {}),
          },
          "ack",
          "turn_end",
        );
        await this.runBeforeRelease(params?.beforeRelease);
        await AppaProxySessionModel.releaseTurn(this.turn);
        this.closed = true;
        return;
      }
      await this.post(
        { event: "turn_end", root_id: this.rootId },
        "ack",
        "turn_end",
      );
      await this.runBeforeRelease(params?.beforeRelease);
      await AppaProxySessionModel.releaseTurn(this.turn);
      this.closed = true;
    } catch (error) {
      const uncertain =
        error instanceof AppaProxyHookError
          ? error
          : new AppaProxyHookError("unavailable", "turn_end");
      await this.closeAfterKnownFailure(uncertain);
      throw uncertain;
    }
  }

  async abort(): Promise<void> {
    if (this.closed) return;
    if (this.undeliveredAuthorizedCalls) {
      await this.quarantineUndeliveredCalls();
      return;
    }
    await this.finish();
  }

  /**
   * A caller can still prove that no authorized calls reached its client before
   * it begins response delivery. Keep those runtime grants out of automatic
   * reuse until an operator resolves the interrupted turn.
   */
  async quarantineUndeliveredCalls(): Promise<void> {
    if (!this.undeliveredAuthorizedCalls) return;
    await AppaProxySessionModel.quarantineUndeliveredCalls(this.turn);
    this.closed = true;
  }

  markOutboundCallsDelivered(): void {
    this.undeliveredAuthorizedCalls = false;
    this.phaseTrace?.proposalSocketWriteFinish(
      this.authorizedCallIdsAwaitingWrite,
    );
    this.authorizedCallIdsAwaitingWrite = [];
    if (this.continuationResponseReady) {
      this.phaseTrace?.continuationSocketWriteFinish(
        this.admittedCallIdsAwaitingContinuationWrite,
      );
      this.admittedCallIdsAwaitingContinuationWrite = [];
    }
  }

  /** Marks this successful response as the continuation that follows admitted results. */
  markContinuationResponseReady(): void {
    this.continuationResponseReady = true;
  }

  getModelResultUpdates(): ReadonlyMap<string, string> {
    return this.modelResultUpdates;
  }

  getSpawnBindingsHeaderValue(): string | undefined {
    if (this.authorizedSpawnBindings.size === 0) return undefined;
    const value = JSON.stringify(
      Object.fromEntries(this.authorizedSpawnBindings),
    );
    if (Buffer.byteLength(value, "utf8") > MAX_SPAWN_BINDINGS_HEADER_BYTES) {
      throw new AppaProxySessionProtocolError(
        "authorized spawn bindings exceed the response header limit",
      );
    }
    return value;
  }

  getNativeWireScope(): {
    sessionId: string;
    ownerScopeHash: string;
    turnId: string;
  } {
    return {
      sessionId: this.turn.session.id,
      ownerScopeHash: this.turn.session.ownerScopeHash,
      turnId: this.turn.turnId,
    };
  }

  /**
   * Seals the exact provider exchange and binds its runtime checkpoint while the
   * turn remains exclusively held. Any uncertain checkpoint side effect causes
   * `finish` to quarantine the turn rather than releasing a retryable root.
   */
  async checkpointCompletedResponse(params: {
    profileId: string;
    provider: string;
    protocol: AppaHistoryProtocol;
    model: string;
    request: unknown;
    response: unknown;
  }): Promise<void> {
    if (!this.config.runtimeToken) return;
    try {
      const frame = await new AppaResponseFrame({
        session: this,
        profileId: params.profileId,
      }).complete({
        runtimeEventId: randomUUID(),
        provider: params.provider,
        protocol: params.protocol,
        model: params.model,
        request: params.request,
        response: params.response,
      });
      const checkpoint = await this.runtimeClient().checkpointCreate(
        this.rootId,
      );
      await new AppaProxyLedger({
        ...this.getNativeWireScope(),
        profileId: params.profileId,
      }).recordCheckpointBinding({ checkpoint, frame });
    } catch (error) {
      // Keep the original sealed-frame/checkpoint failure in backend logs while
      // preserving the fail-closed public hook error.
      logger.error(
        { err: error, stage: "completed_response_checkpoint" },
        "OpenAPPA completed response checkpoint failed",
      );
      throw new AppaProxyHookError("unavailable", "turn_end");
    }
  }

  /**
   * Sends the durable first half of a held native response.  This deliberately
   * records non-executable intent rows so operator review can bind the exact
   * candidates. Only commit promotes those same rows to executable dispatches.
   */
  async prepareRuntimeBatch(params: {
    batchId: string;
    calls: AppaOutboundToolCall[];
  }): Promise<Record<string, unknown>> {
    if (!this.config.runtimeToken) {
      throw new AppaProxyHookError("denied", "outbound");
    }
    await this.ensureV1Capabilities();
    await AppaProxySessionModel.createOutboundIntent({
      turn: this.turn,
      calls: params.calls.map((call) => ({
        callId: call.id,
        emittedName: call.emittedName,
        emittedArguments: call.emittedArguments,
        emittedArgumentsCanonical: call.emittedArgumentsCanonical,
        appaTargetName: call.targetName,
        appaTargetArguments: call.targetArguments,
      })),
      maxCallsPerSession: this.config.maxCallsPerSession ?? 1000,
    });
    const decision = await this.postV1(
      {
        event: "prepare_batch",
        root_id: this.rootId,
        batch_id: params.batchId,
        calls: params.calls.map((call) => ({
          call_id: call.id,
          tool: call.targetName,
          arguments: call.targetArguments,
          spawn: call.spawn === true,
        })),
      },
      "batch_prepared",
      "outbound",
      0,
      semanticEventId(this.rootId, params.batchId, "prepare"),
    );
    return parsePreparedRuntimeBatch({
      decision,
      rootId: this.rootId,
      batchId: params.batchId,
      calls: params.calls,
    });
  }

  /**
   * Commits a fully resolved held batch and opens the runtime's exact released
   * calls in one local transaction. The runtime owns effective arguments and
   * dispatch bindings; clients may not echo them into this request.
   */
  async commitRuntimeBatch(params: {
    batchId: string;
    calls: AppaOutboundToolCall[];
  }): Promise<AppaOutboundToolCall[]> {
    if (!this.config.runtimeToken) {
      throw new AppaProxyHookError("denied", "outbound");
    }
    const decision = await this.postV1(
      {
        event: "commit_batch",
        root_id: this.rootId,
        batch_id: params.batchId,
      },
      "batch_committed",
      "outbound",
      0,
      semanticEventId(this.rootId, params.batchId, "commit"),
    );
    const released = parseCommittedRuntimeBatch({
      decision,
      toolCalls: params.calls,
      batchId: params.batchId,
    });
    await AppaProxySessionModel.approveOutboundCallBatch({
      turn: this.turn,
      calls: released.authorized.map((authorization, index) => {
        const call = released.calls[index];
        return {
          ...authorization,
          effectiveCall: {
            callId: call.id,
            emittedName: call.emittedName,
            emittedArguments: call.emittedArguments,
            emittedArgumentsCanonical: call.emittedArgumentsCanonical,
            appaTargetName: call.targetName,
            appaTargetArguments: call.targetArguments,
          },
        };
      }),
    });
    for (const call of released.authorized) {
      if (call.spawnBinding) {
        this.authorizedSpawnBindings.set(call.callId, call.spawnBinding);
      }
    }
    const receipt = this.lastValidatedRuntimeReceipt;
    if (!receipt) {
      throw new AppaProxyHookError("unavailable", "outbound");
    }
    this.phaseTrace?.authorizationReceipt({
      callIds: released.authorized.map((call) => call.callId),
      receipt,
    });
    this.authorizedCallIdsAwaitingWrite.push(
      ...released.authorized.map((call) => call.callId),
    );
    this.undeliveredAuthorizedCalls = true;
    return released.calls;
  }

  async releaseWithoutPrompt(): Promise<void> {
    if (this.closed) return;
    await AppaProxySessionModel.releaseTurn(this.turn);
    this.closed = true;
  }

  /** A held batch whose commit outcome is unknown must never be retried. */
  async quarantineHeldResponse(): Promise<void> {
    if (this.closed) return;
    await AppaProxySessionModel.quarantineTurn(this.turn);
    this.closed = true;
  }

  private async prepareInboundResults(
    toolResults: AppaInboundToolResult[],
  ): Promise<Array<{ result: AppaInboundToolResult; resultHash: string }>> {
    const resultIds = new Set<string>();
    for (const result of toolResults) {
      if (!result.id || resultIds.has(result.id)) {
        throw new AppaProxySessionProtocolError("invalid tool result input");
      }
      resultIds.add(result.id);
    }

    const calls = await AppaProxySessionModel.listCalls(this.turn.session.id);
    const callsById = new Map(calls.map((call) => [call.callId, call]));
    const prepared: Array<{
      result: AppaInboundToolResult;
      resultHash: string;
    }> = [];

    for (let result of toolResults) {
      const call = callsById.get(result.id);
      if (!call) {
        throw new AppaProxySessionProtocolError(
          "tool result does not match a proxy-emitted call",
        );
      }
      if (
        this.nativeCodexExecution &&
        call.emittedName === "functions.write_stdin" &&
        result.claimedCall
      ) {
        try {
          result = {
            ...result,
            claimedCall: {
              ...result.claimedCall,
              rawArguments: await normalizeNativeCodexWriteStdinArguments({
                scope: this.getNativeWireScope(),
                sourceCallId: result.id,
                proxyArguments: call.emittedArguments,
                clientArguments: result.claimedCall.rawArguments,
              }),
            },
          };
        } catch {
          // The client executed a local handle. A missing durable association
          // makes that outcome unknowable, so the enclosing acquire quarantines.
          throw new AppaProxyHookError("unavailable", "input");
        }
      }
      if (result.claimedCall) {
        const canonical = canonicalJsonObject(result.claimedCall.rawArguments);
        if (
          result.claimedCall.name !== call.emittedName ||
          canonical !== call.emittedArgumentsCanonical
        ) {
          throw new AppaProxySessionProtocolError(
            "tool result contradicts the proxy-emitted call",
          );
        }
      }

      if (
        this.nativeCodexExecution &&
        (call.emittedName === "functions.exec_command" ||
          call.emittedName === "functions.write_stdin")
      ) {
        const observation = inspectCodexShellOutput(result.content);
        if (
          result.status !== undefined &&
          result.status !== observation.outcome
        ) {
          throw new AppaProxySessionProtocolError(
            "native outcome contradicts the client receipt",
          );
        }
        try {
          if (
            call.emittedName === "functions.exec_command" &&
            observation.processState === "running"
          ) {
            const routed = await persistNativeCodexProcessRoute({
              scope: this.getNativeWireScope(),
              sourceCallId: result.id,
              output: result.content,
            });
            result = { ...result, content: routed.output };
          } else if (call.emittedName === "functions.write_stdin") {
            const routed = await routeNativeCodexWriteStdinResult({
              scope: this.getNativeWireScope(),
              sourceCallId: result.id,
              proxyArguments: call.emittedArguments,
              output: result.content,
            });
            result = {
              ...result,
              content: routed.output,
              status: routed.outcome,
            };
          }
        } catch {
          // Process IDs correlate an issued client handle, not execution. An
          // unavailable, stale, or malformed route is therefore indeterminate.
          throw new AppaProxyHookError("unavailable", "input");
        }
        result = { ...result, status: observation.outcome, message: undefined };
      }
      const resultHash = keyedDigest(
        this.config.sessionHmacSecret,
        result.content,
      );
      if (call.state === "result_admitted") {
        if (
          call.resultHash !== resultHash ||
          (result.status !== undefined &&
            (call.resultStatus ?? "success") !== outcomeStatus(result)) ||
          (result.status !== undefined &&
            (call.resultMessageHash ?? null) !==
              outcomePresentationHash(this.config.sessionHmacSecret, result))
        ) {
          throw new AppaProxySessionProtocolError(
            "tool result id was reused with different content",
          );
        }
        const historicalStatus = call.resultStatus ?? "success";
        if (call.resultPresentation !== null) {
          this.modelResultUpdates.set(result.id, call.resultPresentation);
        } else if (this.config.runtimeToken) {
          throw new AppaProxySessionProtocolError(
            "authenticated APPA result has no canonical presentation",
          );
        } else if (historicalStatus !== "success") {
          if (
            historicalStatus !== "failure" &&
            historicalStatus !== "indeterminate"
          ) {
            throw new AppaProxySessionProtocolError(
              "unknown recorded result status",
            );
          }
          this.modelResultUpdates.set(
            result.id,
            modelOutcomeNotice({ ...result, status: historicalStatus }),
          );
        }
        continue;
      }
      if (call.state !== "open") {
        throw new AppaProxySessionProtocolError("tool result is not pending");
      }
      if (!this.config.runtimeToken && outcomeStatus(result) !== "success") {
        this.modelResultUpdates.set(result.id, modelOutcomeNotice(result));
      }
      prepared.push({ result, resultHash });
    }

    const pendingCallIds = calls
      .filter((call) => call.state === "open")
      .map((call) => call.callId);
    if (pendingCallIds.some((id) => !resultIds.has(id))) {
      throw new AppaProxySessionProtocolError(
        "pending tool results must be supplied before the next turn",
      );
    }
    return prepared;
  }

  private async attachCheckpointFork(checkpointId: string): Promise<void> {
    if (!this.config.runtimeToken) {
      throw new AppaProxyHookError("unavailable", "input");
    }
    try {
      await this.runtimeClient().checkpointFork({
        checkpointId,
        rootId: this.rootId,
      });
      await AppaProxySessionModel.markRootInitialized(this.turn);
      this.turn.session.rootInitializedAt = new Date();
    } catch {
      throw new AppaProxyHookError("unavailable", "input");
    }
  }

  private async admitInboundResults(
    prepared: Array<{ result: AppaInboundToolResult; resultHash: string }>,
  ): Promise<void> {
    if (prepared.length === 0) return;
    const callIds = prepared.map(({ result }) => result.id);
    await AppaProxySessionModel.beginResultAdmission({
      turn: this.turn,
      results: prepared.map(({ result, resultHash }) => ({
        callId: result.id,
        resultHash,
        resultStatus: outcomeStatus(result),
        resultMessageHash: outcomePresentationHash(
          this.config.sessionHmacSecret,
          result,
        ),
        resultPresentation: this.config.runtimeToken
          ? null
          : (this.modelResultUpdates.get(result.id) ?? null),
      })),
    });

    try {
      for (const { result } of prepared) {
        const call = (
          await AppaProxySessionModel.listCalls(this.turn.session.id)
        ).find((candidate) => candidate.callId === result.id);
        if (!call)
          throw new AppaProxySessionProtocolError("tool call disappeared");
        if (this.config.runtimeToken && !call.dispatchId) {
          throw new AppaProxySessionProtocolError(
            "authenticated APPA call has no dispatch mapping",
          );
        }
        const decision = await this.post(
          {
            event: "tool_result",
            root_id: this.rootId,
            ...(this.config.runtimeToken
              ? {
                  call_id: result.id,
                  dispatch_id: call.dispatchId,
                }
              : {
                  tool: call.appaTargetName,
                  arguments: call.appaTargetArguments,
                }),
            outcome:
              outcomeStatus(result) === "success"
                ? { status: "success", body: result.content }
                : outcomeStatus(result) === "failure"
                  ? {
                      status: "failure",
                      message: outcomePresentation(result),
                    }
                  : { status: "indeterminate" },
          },
          "ack",
          "input",
        );
        if (this.config.runtimeToken) {
          const presentation = parseCanonicalResultPresentation({
            decision,
            callId: result.id,
          });
          await AppaProxySessionModel.setResultPresentations({
            turn: this.turn,
            presentations: [{ callId: result.id, presentation }],
          });
          this.modelResultUpdates.set(result.id, presentation);
        }
        if (outcomeStatus(result) === "indeterminate") {
          // The client cannot attest whether the side effect ran. Do not admit
          // a model-visible success or allow this trajectory to continue.
          await AppaProxySessionModel.quarantineTurn(this.turn);
          this.closed = true;
          throw new AppaProxySessionProtocolError(
            "indeterminate tool outcome quarantined",
          );
        }
        // A later result can be denied. Commit each acknowledged result before
        // advancing so a retry never re-posts an effect APPA already accepted.
        try {
          await AppaProxySessionModel.admitResults(this.turn, [result.id]);
          if (this.config.runtimeToken) {
            const receipt = this.lastValidatedRuntimeReceipt;
            if (!receipt) {
              throw new AppaProxyHookError("unavailable", "input");
            }
            this.phaseTrace?.resultAdmissionReceipt({
              callId: result.id,
              receipt,
            });
            this.admittedCallIdsAwaitingContinuationWrite.push(result.id);
          }
        } catch {
          throw new AppaProxyHookError("unavailable", "input");
        }
      }
    } catch (error) {
      if (error instanceof AppaProxyHookError && error.kind === "denied") {
        const currentCalls = await AppaProxySessionModel.listCalls(
          this.turn.session.id,
        );
        await AppaProxySessionModel.revertResultIntent(
          this.turn,
          currentCalls
            .filter(
              (call) =>
                call.state === "result_intent" && callIds.includes(call.callId),
            )
            .map((call) => call.callId),
        );
      } else {
        await this.closeAfterKnownFailure(
          error instanceof AppaProxyHookError
            ? error
            : new AppaProxyHookError("unavailable", "input"),
        );
      }
      throw error;
    }
  }

  private async post(
    event: Record<string, unknown>,
    expectedDecision: "ack" | "allow_call" | "allow_calls",
    stage: "input" | "outbound" | "turn_end",
  ): Promise<Record<string, unknown>> {
    event = this.targetChildActor(event);
    if (this.config.runtimeToken) {
      return await this.postV1(event, expectedDecision, stage);
    }
    await AppaProxySessionModel.markRemoteIntent(
      this.turn,
      String(event.event),
    );
    const timeoutSignal = AbortSignal.timeout(this.config.timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.config.url}/hook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
        redirect: "error",
        signal: timeoutSignal,
      });
    } catch {
      throw new AppaProxyHookError("unavailable", stage);
    }

    if (response.status === 429 || response.status >= 500) {
      throw new AppaProxyHookError("unavailable", stage);
    }
    if (response.status !== 200 && response.status !== 409) {
      throw new AppaProxyHookError("unavailable", stage);
    }

    let body: Record<string, unknown>;
    try {
      body = await readHookResponse(response, timeoutSignal);
    } catch {
      throw new AppaProxyHookError("unavailable", stage);
    }

    if (response.status === 409) {
      if (isRefusalEnvelope(body)) {
        await AppaProxySessionModel.markRemoteSettled(this.turn);
        throw new AppaProxyHookError("denied", stage);
      }
      throw new AppaProxyHookError("unavailable", stage);
    }
    if (isExpectedDecision(body, expectedDecision)) {
      try {
        await AppaProxySessionModel.markRemoteSettled(this.turn);
      } catch {
        throw new AppaProxyHookError("unavailable", stage);
      }
      return body;
    }
    if (isPolicyDenialEnvelope(body)) {
      await AppaProxySessionModel.markRemoteSettled(this.turn);
      throw new AppaProxyHookError("denied", stage);
    }
    throw new AppaProxyHookError("unavailable", stage);
  }

  private async postV1(
    event: Record<string, unknown>,
    expectedDecision:
      | "ack"
      | "allow_call"
      | "allow_calls"
      | "offer_resolved"
      | "batch_prepared"
      | "batch_committed",
    stage: "input" | "outbound" | "turn_end",
    resolutionAttempts = 0,
    fixedEventId?: string,
  ): Promise<Record<string, unknown>> {
    event = this.targetChildActor(event);
    if (this.requestSignal?.aborted && stage !== "turn_end") {
      throw new AppaProxyHookError("denied", stage);
    }
    const eventId = fixedEventId ?? randomUUID();
    const runtime = this.runtimeClient();
    const prepared = runtime.prepareEvent({
      eventId,
      event: event as { event: string } & Record<string, unknown>,
    });
    if (Buffer.byteLength(prepared.body) > 1024 * 1024) {
      throw new AppaProxySessionProtocolError(
        "APPA event exceeds the 1 MiB request limit",
      );
    }
    await AppaProxySessionModel.createRemoteEventIntent({
      turn: this.turn,
      eventId,
      event: String(event.event),
      requestBody: prepared.body,
      requestSha256: prepared.requestSha256,
    });

    let body: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      const timeoutSignal =
        this.requestSignal && stage !== "turn_end"
          ? AbortSignal.any([
              AbortSignal.timeout(this.config.timeoutMs),
              this.requestSignal,
            ])
          : AbortSignal.timeout(this.config.timeoutMs);
      try {
        body = await runtime.postPreparedEvent(prepared, timeoutSignal);
        break;
      } catch (error) {
        if (error instanceof AppaProxyHookError) throw error;
        if (
          error instanceof AppaRuntimeError &&
          (error.code === "uncertain" ||
            (error.code === "refused" &&
              error.status !== undefined &&
              error.status < 500))
        ) {
          throw new AppaProxyHookError("unavailable", stage);
        }
        if (this.requestSignal?.aborted)
          throw new AppaProxyHookError("unavailable", stage);
        if (attempt < 2) {
          await shortBackoff(attempt);
          continue;
        }
        throw new AppaProxyHookError("unavailable", stage);
      }
    }
    if (!body || !isV1Receipt(body, eventId, prepared.requestSha256)) {
      throw new AppaProxyHookError("unavailable", stage);
    }
    await AppaProxySessionModel.settleRemoteEvent(this.turn, eventId, body);
    this.lastValidatedRuntimeReceipt = {
      id: eventId,
      sha256: receiptSha256(body),
    };
    const decision = body.decision as Record<string, unknown>;
    if (expectedDecision === "offer_resolved") {
      if (isRefusalEnvelope(decision))
        throw new AppaProxyHookError("denied", stage);
      const expected =
        event.resolution === "accept_restriction"
          ? { kind: "acceptance", resolution: "accepted" }
          : event.resolution === "apply_sanitizer"
            ? { kind: "sanitizer", resolution: "bound" }
            : event.resolution === "approve"
              ? { kind: "human_approval", resolution: "approved" }
              : { kind: "human_approval", resolution: "denied" };
      if (
        decision.decision === "offer_resolved" &&
        decision.offer_id === event.offer_id &&
        decision.tool === event.tool &&
        decision.arguments_sha256 === event.arguments_sha256 &&
        decision.resolution === expected.resolution &&
        decision.kind === expected.kind
      )
        return decision;
      throw new AppaProxyHookError("unavailable", stage);
    }
    if (
      isExpectedDecision(decision, expectedDecision) ||
      (event.event === "tool_result" &&
        expectedDecision === "ack" &&
        isCanonicalResultPresentation(decision))
    ) {
      return decision;
    }
    const denial = parseV1BatchDenial(decision, this.rootId, event);
    if (denial) {
      const { offers } = denial;
      const sanitizerOffer = denial.singleton
        ? offers.find((offer) => offer.kind === "sanitizer")
        : undefined;
      // A configured sanitizer is an explicit alternate remedy for this
      // result, not a generic acceptance. Prefer it to permanently narrowing
      // the trajectory when both routes are offered.
      if (sanitizerOffer && resolutionAttempts < 3) {
        await this.resolveOffer({
          offer: sanitizerOffer,
          resolution: "apply_sanitizer",
          stage,
          label: denial.spawn ? {} : undefined,
        });
        return await this.postV1(
          event,
          expectedDecision,
          stage,
          resolutionAttempts + 1,
        );
      }
      if (
        denial.singleton &&
        offers.some((offer) => offer.kind === "acceptance") &&
        this.config.autoAcceptRestrictions &&
        this.capabilities.restrictions &&
        resolutionAttempts < 3
      ) {
        const offer = offers.find(
          (candidate) => candidate.kind === "acceptance",
        );
        if (offer) {
          await this.resolveOffer({
            offer,
            resolution: "accept_restriction",
            stage,
            // An explicit empty spelling is the runtime's parent-derived
            // return floor; omitting it leaves a marked spawn incomplete.
            label: denial.spawn ? {} : undefined,
          });
          // This is a new semantic attempt. Never reuse the cached deny event.
          return await this.postV1(
            event,
            expectedDecision,
            stage,
            resolutionAttempts + 1,
          );
        }
      }
      const humanOffer = offers.find(
        (offer) => offer.kind === "human_approval",
      );
      if (
        humanOffer &&
        this.activeCall &&
        this.capabilities.humanApprovals &&
        resolutionAttempts < 3
      ) {
        if (!this.organizationId)
          throw new AppaProxySessionProtocolError(
            "APPA approval requires organization identity",
          );
        const approval = await AppaApprovalModel.create({
          organizationId: this.organizationId,
          sessionId: this.turn.session.id,
          activeTurnId: this.turn.turnId,
          candidateCallId: this.activeCall.id,
          rootId: this.rootId,
          tool: humanOffer.tool,
          argumentsSha256: humanOffer.arguments_sha256,
          offerId: humanOffer.offer_id,
        });
        this.pendingApprovalId = approval.id;
        try {
          const choice = await AppaApprovalModel.waitForDecision(approval.id, {
            signal: this.requestSignal,
          });
          if (this.requestSignal?.aborted)
            throw new AppaProxyHookError("denied", stage);
          if (choice === "approved" || choice === "denied") {
            const decided = await AppaApprovalModel.getForTurn({
              id: approval.id,
              sessionId: this.turn.session.id,
              activeTurnId: this.turn.turnId,
              decision: choice,
            });
            if (
              !decided ||
              decided.status !== choice ||
              !decided.approverId ||
              decided.expiresAt.getTime() <= Date.now() ||
              !this.config.approvalSigningSecret
            ) {
              throw new AppaProxyHookError("denied", stage);
            }
            const resolution = choice === "approved" ? "approve" : "deny";
            const claims = {
              approval_id: decided.id,
              reviewer_id: decided.approverId,
              root_id: this.rootId,
              offer_id: humanOffer.offer_id,
              tool: humanOffer.tool,
              arguments_sha256: humanOffer.arguments_sha256,
              resolution,
              expires_at: decided.expiresAt.getTime(),
            };
            const grant = {
              ...claims,
              signature: createHmac("sha256", this.config.approvalSigningSecret)
                .update(stableStringify(claims))
                .digest("hex"),
            };
            await this.resolveOffer({
              offer: humanOffer,
              resolution,
              stage,
              approval: grant,
            });
            if (choice === "approved") {
              this.approvalExpiresAt = decided.expiresAt.getTime();
              if (Date.now() >= this.approvalExpiresAt)
                throw new AppaProxyHookError("denied", stage);
              return await this.postV1(
                event,
                expectedDecision,
                stage,
                resolutionAttempts + 1,
              );
            }
          }
        } finally {
          await AppaApprovalModel.cancel(approval.id);
          this.pendingApprovalId = undefined;
        }
      }
      throw new AppaProxyHookError("denied", stage);
    }
    if (isPolicyDenialEnvelope(decision))
      throw new AppaProxyHookError("denied", stage);
    throw new AppaProxyHookError("unavailable", stage);
  }

  private async ensureV1Capabilities(): Promise<void> {
    if (!this.config.runtimeToken || this.v1CapabilitiesChecked) return;
    let capabilities: Record<string, unknown>;
    try {
      capabilities = await this.runtimeClient().capabilities();
    } catch {
      throw new AppaProxyHookError("unavailable", "input");
    }
    if (
      capabilities.protocol_version !== 1 ||
      capabilities.completed_event_replay !== true ||
      capabilities.typed_offers !== true ||
      typeof capabilities.restriction_acceptance !== "boolean" ||
      typeof capabilities.human_approval !== "boolean" ||
      capabilities.sanitized_results !== true ||
      typeof capabilities.child_workflows !== "boolean" ||
      (capabilities.child_actor_targeting !== undefined &&
        typeof capabilities.child_actor_targeting !== "boolean")
    ) {
      throw new AppaProxyHookError("unavailable", "input");
    }
    this.capabilities = {
      restrictions: capabilities.restriction_acceptance === true,
      humanApprovals:
        capabilities.human_approval === true &&
        capabilities.approval_grants === true &&
        Boolean(this.config.approvalSigningSecret),
      sanitizedResults: true,
      childWorkflows:
        capabilities.child_workflows === true &&
        capabilities.child_actor_targeting === true,
    };
    this.v1CapabilitiesChecked = true;
  }

  private runtimeClient(): AppaRuntimeClient {
    if (!this.config.runtimeToken) {
      throw new AppaProxyHookError("unavailable", "input");
    }
    return new AppaRuntimeClient({
      url: this.config.url,
      runtimeToken: this.config.runtimeToken,
      timeoutMs: this.config.timeoutMs,
    });
  }

  private async resolveOffer(params: {
    offer: AppaOffer;
    resolution: "accept_restriction" | "apply_sanitizer" | "approve" | "deny";
    stage: "input" | "outbound" | "turn_end";
    approval?: Record<string, unknown>;
    label?: Record<string, never>;
  }): Promise<void> {
    const { offer, resolution, stage, approval, label } = params;
    await this.postV1(
      {
        event: "resolve_offer",
        root_id: this.rootId,
        offer_id: offer.offer_id,
        tool: offer.tool,
        arguments_sha256: offer.arguments_sha256,
        resolution,
        ...(label ? { label } : {}),
        ...(approval ? { approval } : {}),
      },
      "offer_resolved",
      stage,
    );
  }

  private async authorizeV1Batch(
    toolCalls: AppaOutboundToolCall[],
  ): Promise<
    Array<{ callId: string; dispatchId: string; spawnBinding: string | null }>
  > {
    // A remedy is bound to one exact call. Multi-call remedies need an explicit
    // per-call offer protocol; until then they remain fail-closed.
    this.activeCall = toolCalls.length === 1 ? toolCalls[0] : undefined;
    try {
      const decision = await this.postV1(
        {
          event: "tool_calls",
          root_id: this.rootId,
          calls: toolCalls.map((toolCall) => ({
            call_id: toolCall.id,
            tool: toolCall.targetName,
            arguments: toolCall.targetArguments,
            spawn: toolCall.spawn === true,
          })),
        },
        "allow_calls",
        "outbound",
      );
      return parseAllowedCallBatch({ decision, toolCalls });
    } finally {
      this.activeCall = undefined;
    }
  }

  private targetChildActor(
    event: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!this.turn.session.parentSessionId || "child_id" in event) return event;
    // `root_id` names the family for receipts; child_id selects the APPA actor
    // whose policy state, labels, and open dispatches the event may affect.
    return { ...event, child_id: this.turn.session.clientSessionId };
  }

  private async closeAfterKnownFailure(error: unknown): Promise<void> {
    if (this.closed) return;
    if (this.pendingApprovalId)
      await AppaApprovalModel.cancel(this.pendingApprovalId);
    if (
      (error instanceof AppaProxyHookError && error.kind === "unavailable") ||
      (!(error instanceof AppaProxyHookError) &&
        !(error instanceof AppaProxySessionProtocolError))
    ) {
      await AppaProxySessionModel.quarantineTurn(this.turn);
    } else {
      await AppaProxySessionModel.releaseTurn(this.turn);
    }
    this.closed = true;
  }

  private async runBeforeRelease(
    beforeRelease: (() => Promise<void>) | undefined,
  ): Promise<void> {
    if (!beforeRelease) return;
    try {
      await beforeRelease();
    } catch {
      // APPA already accepted the lifecycle event. Replaying it after a local
      // persistence failure could double-publish opaque client wire state.
      throw new AppaProxyHookError("unavailable", "turn_end");
    }
  }
}

export function deriveAppaOwnerScope(params: {
  secret: string;
  profileId: string;
  virtualKeyId?: string;
  passthroughVirtualKeyId?: string;
  authenticatedPrincipalId?: string;
  authenticatedAppId?: string;
  rawProviderCredential?: string;
}): string | null {
  const credentialScope =
    params.virtualKeyId ??
    params.passthroughVirtualKeyId ??
    (params.rawProviderCredential
      ? `credential:${keyedDigest(params.secret, params.rawProviderCredential)}`
      : undefined);
  const principalScope =
    params.authenticatedPrincipalId ??
    params.authenticatedAppId ??
    // A raw provider credential has no platform principal row. Its keyed
    // fingerprint is still a reliable credential-bound principal scope.
    credentialScope;
  if (!credentialScope) return null;
  return keyedDigest(params.secret, {
    profileId: params.profileId,
    credentialScope,
    principalScope,
  });
}

export function canonicalJsonObject(value: string): string {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return stableStringify(parsed);
  } catch {
    throw new AppaProxySessionProtocolError(
      "tool call arguments must be a JSON object",
    );
  }
}

function keyedDigest(secret: string, value: unknown): string {
  return createHmac("sha256", secret)
    .update(stableStringify(value))
    .digest("hex");
}

function receiptSha256(receipt: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(receipt)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}

async function readHookResponse(
  response: Response,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error("missing response body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await readChunk(reader, signal);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_HOOK_RESPONSE_BYTES)
        throw new Error("hook response too large");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const value: unknown = JSON.parse(
    new TextDecoder().decode(concatenate(chunks, size)),
  );
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("hook response is not an object");
  }
  return value as Record<string, unknown>;
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) throw signal.reason;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function concatenate(chunks: Uint8Array[], size: number): Uint8Array {
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function isExpectedDecision(
  body: Record<string, unknown>,
  expectedDecision:
    | "ack"
    | "allow_call"
    | "allow_calls"
    | "offer_resolved"
    | "batch_prepared"
    | "batch_committed",
): boolean {
  if (expectedDecision === "batch_prepared") {
    return body.decision === "batch_prepared" && Array.isArray(body.positions);
  }
  if (expectedDecision === "batch_committed") {
    return body.decision === "batch_committed" && Array.isArray(body.calls);
  }
  if (expectedDecision === "allow_calls") {
    return body.decision === "allow_calls" && Array.isArray(body.calls);
  }
  return Object.keys(body).length === 1 && body.decision === expectedDecision;
}

function semanticEventId(
  rootId: string,
  batchId: string,
  phase: string,
): string {
  const hex = createHash("sha256")
    .update(`appa-held-batch-v1:${rootId}:${batchId}:${phase}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function parseAllowedCallBatch(params: {
  decision: Record<string, unknown>;
  toolCalls: AppaOutboundToolCall[];
}): Array<{ callId: string; dispatchId: string; spawnBinding: string | null }> {
  const { decision, toolCalls } = params;
  if (
    decision.decision !== "allow_calls" ||
    !Array.isArray(decision.calls) ||
    Object.keys(decision).some((key) => key !== "decision" && key !== "calls")
  ) {
    throw new AppaProxyHookError("unavailable", "outbound");
  }
  const proposedById = new Map(toolCalls.map((call) => [call.id, call]));
  const authorized = new Map<
    string,
    { callId: string; dispatchId: string; spawnBinding: string | null }
  >();
  for (const candidate of decision.calls) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      throw new AppaProxyHookError("unavailable", "outbound");
    }
    const call = candidate as Record<string, unknown>;
    if (
      typeof call.call_id !== "string" ||
      typeof call.dispatch_id !== "string" ||
      call.call_id.length === 0 ||
      call.dispatch_id.length === 0 ||
      (call.spawn_binding !== undefined &&
        (typeof call.spawn_binding !== "string" ||
          Buffer.byteLength(call.spawn_binding, "utf8") >
            MAX_SPAWN_BINDING_BYTES)) ||
      Object.keys(call).some(
        (key) =>
          key !== "call_id" && key !== "dispatch_id" && key !== "spawn_binding",
      ) ||
      !proposedById.has(call.call_id) ||
      authorized.has(call.call_id)
    ) {
      throw new AppaProxyHookError("unavailable", "outbound");
    }
    const proposed = proposedById.get(call.call_id);
    if ((call.spawn_binding !== undefined) !== (proposed?.spawn === true)) {
      throw new AppaProxyHookError("unavailable", "outbound");
    }
    authorized.set(call.call_id, {
      callId: call.call_id,
      dispatchId: call.dispatch_id,
      spawnBinding:
        typeof call.spawn_binding === "string" ? call.spawn_binding : null,
    });
  }
  if (authorized.size !== toolCalls.length) {
    throw new AppaProxyHookError("unavailable", "outbound");
  }
  return toolCalls.map((call) => {
    const authorizedCall = authorized.get(call.id);
    if (!authorizedCall)
      throw new AppaProxyHookError("unavailable", "outbound");
    return authorizedCall;
  });
}

function parsePreparedRuntimeBatch(params: {
  decision: Record<string, unknown>;
  rootId: string;
  batchId: string;
  calls: AppaOutboundToolCall[];
}): Record<string, unknown> {
  const { decision, rootId, batchId, calls } = params;
  if (
    !hasExactKeys(decision, [
      "decision",
      "batch_id",
      "root_id",
      "positions",
      "next",
    ]) ||
    decision.decision !== "batch_prepared" ||
    decision.batch_id !== batchId ||
    decision.root_id !== rootId ||
    decision.next !== "resolve_batch_offer or commit_batch" ||
    !Array.isArray(decision.positions) ||
    decision.positions.length !== calls.length
  ) {
    throw new AppaProxyHookError("unavailable", "outbound");
  }
  const callsById = new Map(
    calls.map((call, position) => [call.id, { call, position }]),
  );
  const seen = new Set<number>();
  for (const candidate of decision.positions) {
    if (!isRecord(candidate))
      throw new AppaProxyHookError("unavailable", "outbound");
    const position = candidate;
    if (
      typeof position.position !== "number" ||
      !Number.isInteger(position.position) ||
      typeof position.call_id !== "string" ||
      typeof position.tool !== "string" ||
      typeof position.arguments_sha256 !== "string" ||
      typeof position.state !== "string"
    ) {
      throw new AppaProxyHookError("unavailable", "outbound");
    }
    const expected = callsById.get(position.call_id);
    if (
      !expected ||
      expected.position !== position.position ||
      seen.has(position.position) ||
      position.tool !== expected.call.targetName ||
      position.arguments_sha256 !==
        runtimeArgumentsSha256(expected.call.targetArguments)
    ) {
      throw new AppaProxyHookError("unavailable", "outbound");
    }
    seen.add(position.position);
    if (position.state === "held") {
      if (
        !hasExactKeys(position, [
          "position",
          "call_id",
          "state",
          "tool",
          "arguments_sha256",
        ])
      ) {
        throw new AppaProxyHookError("unavailable", "outbound");
      }
      continue;
    }
    if (
      position.state !== "blocked" ||
      !hasExactKeys(position, [
        "position",
        "call_id",
        "state",
        "tool",
        "arguments_sha256",
        "feedback",
        "offers",
        "review",
      ]) ||
      typeof position.feedback !== "string" ||
      !Array.isArray(position.offers) ||
      !Array.isArray(position.review)
    ) {
      throw new AppaProxyHookError("unavailable", "outbound");
    }
    for (const rawOffer of position.offers) {
      if (
        !isRecord(rawOffer) ||
        !hasExactKeys(rawOffer, [
          "offer_id",
          "kind",
          "root_id",
          "tool",
          "arguments_sha256",
          "batch_id",
          "position",
        ]) ||
        typeof rawOffer.offer_id !== "string" ||
        typeof rawOffer.kind !== "string" ||
        rawOffer.root_id !== rootId ||
        rawOffer.tool !== position.tool ||
        rawOffer.arguments_sha256 !== position.arguments_sha256 ||
        rawOffer.batch_id !== batchId ||
        rawOffer.position !== position.position
      ) {
        throw new AppaProxyHookError("unavailable", "outbound");
      }
    }
  }
  if (seen.size !== calls.length) {
    throw new AppaProxyHookError("unavailable", "outbound");
  }
  return decision;
}

function parseCommittedRuntimeBatch(params: {
  decision: Record<string, unknown>;
  toolCalls: AppaOutboundToolCall[];
  batchId: string;
}): {
  calls: AppaOutboundToolCall[];
  authorized: Array<{
    callId: string;
    dispatchId: string;
    spawnBinding: string | null;
  }>;
} {
  const { decision, toolCalls, batchId } = params;
  if (
    !hasExactKeys(decision, ["decision", "batch_id", "calls"]) ||
    decision.decision !== "batch_committed" ||
    decision.batch_id !== batchId ||
    !Array.isArray(decision.calls) ||
    decision.calls.length !== toolCalls.length
  ) {
    throw new AppaProxyHookError("unavailable", "outbound");
  }
  const proposedById = new Map(
    toolCalls.map((call, position) => [call.id, { call, position }]),
  );
  const released = new Map<
    string,
    {
      call: AppaOutboundToolCall;
      authorized: {
        callId: string;
        dispatchId: string;
        spawnBinding: string | null;
      };
    }
  >();
  for (const candidate of decision.calls) {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, [
        "position",
        "call_id",
        "dispatch_id",
        "tool",
        "arguments_sha256",
        "arguments",
        "spawn_binding",
      ]) ||
      typeof candidate.position !== "number" ||
      !Number.isInteger(candidate.position) ||
      typeof candidate.call_id !== "string" ||
      typeof candidate.dispatch_id !== "string" ||
      typeof candidate.tool !== "string" ||
      typeof candidate.arguments_sha256 !== "string" ||
      !isRecord(candidate.arguments) ||
      (candidate.spawn_binding !== null &&
        (typeof candidate.spawn_binding !== "string" ||
          Buffer.byteLength(candidate.spawn_binding, "utf8") >
            MAX_SPAWN_BINDING_BYTES))
    ) {
      throw new AppaProxyHookError("unavailable", "outbound");
    }
    const proposed = proposedById.get(candidate.call_id);
    if (
      !proposed ||
      proposed.position !== candidate.position ||
      released.has(candidate.call_id) ||
      candidate.tool !== proposed.call.targetName ||
      candidate.arguments_sha256 !==
        runtimeArgumentsSha256(candidate.arguments) ||
      (candidate.spawn_binding !== null) !== (proposed.call.spawn === true)
    ) {
      throw new AppaProxyHookError("unavailable", "outbound");
    }
    released.set(candidate.call_id, {
      call: withCommittedArguments(proposed.call, candidate.arguments),
      authorized: {
        callId: candidate.call_id,
        dispatchId: candidate.dispatch_id,
        spawnBinding: candidate.spawn_binding,
      },
    });
  }
  if (released.size !== toolCalls.length) {
    throw new AppaProxyHookError("unavailable", "outbound");
  }
  return {
    calls: toolCalls.map((call) => {
      const releasedCall = released.get(call.id);
      if (!releasedCall)
        throw new AppaProxyHookError("unavailable", "outbound");
      return releasedCall.call;
    }),
    authorized: toolCalls.map((call) => {
      const releasedCall = released.get(call.id);
      if (!releasedCall)
        throw new AppaProxyHookError("unavailable", "outbound");
      return releasedCall.authorized;
    }),
  };
}

function withCommittedArguments(
  call: AppaOutboundToolCall,
  effectiveArguments: Record<string, unknown>,
): AppaOutboundToolCall {
  const effectiveArgumentsCanonical = canonicalJsonObject(
    JSON.stringify(effectiveArguments),
  );
  let emitted: Record<string, unknown>;
  try {
    emitted = JSON.parse(call.emittedArguments) as Record<string, unknown>;
  } catch {
    throw new AppaProxyHookError("unavailable", "outbound");
  }
  if (!isRecord(emitted))
    throw new AppaProxyHookError("unavailable", "outbound");

  if (
    call.emittedArgumentsCanonical ===
    canonicalJsonObject(JSON.stringify(call.targetArguments))
  ) {
    return {
      ...call,
      emittedArguments: effectiveArgumentsCanonical,
      emittedArgumentsCanonical: effectiveArgumentsCanonical,
      targetArguments: effectiveArguments,
    };
  }
  if (
    isRunToolWrapper(call.emittedName) &&
    emitted.tool_name === emittedRunToolTargetName(call.targetName) &&
    isRecord(emitted.tool_args) &&
    canonicalJsonObject(JSON.stringify(emitted.tool_args)) ===
      canonicalJsonObject(JSON.stringify(call.targetArguments))
  ) {
    const emittedArguments = JSON.stringify({
      ...emitted,
      tool_args: effectiveArguments,
    });
    return {
      ...call,
      emittedArguments,
      emittedArgumentsCanonical: canonicalJsonObject(emittedArguments),
      targetArguments: effectiveArguments,
    };
  }
  throw new AppaProxyHookError("unavailable", "outbound");
}

function isRunToolWrapper(name: string): boolean {
  return (
    name === "archestra__run_tool" || name.endsWith("__archestra__run_tool")
  );
}

/**
 * APPA receives registry-canonical `mcp/<gateway>/<tool>` identities while the
 * client must execute its original run_tool envelope. This only reconstructs
 * the already-authorized wrapper relation; it never selects an APPA target.
 */
function emittedRunToolTargetName(targetName: string): string {
  const match = /^mcp\/[^/]+\/(.+)$/.exec(targetName);
  return match?.[1] ?? targetName;
}

function runtimeArgumentsSha256(arguments_: Record<string, unknown>): string {
  return createHash("sha256")
    .update(canonicalJsonObject(JSON.stringify(arguments_)))
    .digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length &&
    actual.every((key, index) => key === [...keys].sort()[index])
  );
}

function isCanonicalResultPresentation(
  decision: Record<string, unknown>,
): boolean {
  return (
    (decision.decision === "ack" || decision.decision === "result_admitted") &&
    typeof decision.call_id === "string" &&
    typeof decision.presentation === "string" &&
    (decision.offers === undefined ||
      (Array.isArray(decision.offers) && decision.offers.length === 0)) &&
    Object.keys(decision).every(
      (key) =>
        key === "decision" ||
        key === "call_id" ||
        key === "presentation" ||
        key === "offers",
    )
  );
}

function toOutboundCall(call: AppaOutboundToolCall) {
  return {
    callId: call.id,
    emittedName: call.emittedName,
    emittedArguments: call.emittedArguments,
    emittedArgumentsCanonical: call.emittedArgumentsCanonical,
    appaTargetName: call.targetName,
    appaTargetArguments: call.targetArguments,
  };
}

function parseCanonicalResultPresentation(params: {
  decision: Record<string, unknown>;
  callId: string;
}): string {
  if (
    !isCanonicalResultPresentation(params.decision) ||
    params.decision.call_id !== params.callId ||
    Buffer.byteLength(params.decision.presentation as string, "utf8") >
      64 * 1024
  ) {
    throw new AppaProxyHookError("unavailable", "input");
  }
  return params.decision.presentation as string;
}

function isRefusalEnvelope(body: Record<string, unknown>): boolean {
  return (
    Object.keys(body).length === 2 &&
    body.decision === "refuse" &&
    typeof body.detail === "string"
  );
}

function isPolicyDenialEnvelope(body: Record<string, unknown>): boolean {
  if (body.decision === "block") {
    return Object.keys(body).length === 2 && typeof body.reason === "string";
  }
  if (body.decision === "refuse") return isRefusalEnvelope(body);
  return (
    (body.decision === "deny_call" || body.decision === "deny_calls") &&
    Object.keys(body).length === 4 &&
    typeof body.feedback === "string" &&
    Array.isArray(body.offers) &&
    Array.isArray(body.review)
  );
}

function isV1Receipt(
  body: Record<string, unknown>,
  eventId: string,
  requestSha256: string,
): boolean {
  return (
    body.protocol_version === 1 &&
    body.event_id === eventId &&
    body.request_sha256 === requestSha256 &&
    body.decision !== null &&
    typeof body.decision === "object" &&
    !Array.isArray(body.decision)
  );
}

function parseV1BatchDenial(
  decision: Record<string, unknown>,
  rootId: string,
  event: Record<string, unknown>,
): { offers: AppaOffer[]; singleton: boolean; spawn: boolean } | null {
  if (
    decision.decision !== "deny_calls" ||
    !Array.isArray(decision.calls) ||
    Object.keys(decision).some((key) => key !== "decision" && key !== "calls")
  ) {
    return null;
  }
  const proposed = singletonOfferCall(event);
  // Multi-call batches are one atomic runtime proposal. They never resolve a
  // single call and are denied as a whole by the caller.
  if (!proposed) return { offers: [], singleton: false, spawn: false };
  if (decision.calls.length !== 1) return null;
  const [denied] = decision.calls;
  if (!denied || typeof denied !== "object" || Array.isArray(denied))
    return null;
  const candidate = denied as Record<string, unknown>;
  if (
    candidate.call_id !== proposed.callId ||
    candidate.decision !== "deny_call" ||
    typeof candidate.feedback !== "string" ||
    !Array.isArray(candidate.offers) ||
    !Array.isArray(candidate.review) ||
    Object.keys(candidate).some(
      (key) =>
        key !== "call_id" &&
        key !== "decision" &&
        key !== "feedback" &&
        key !== "offers" &&
        key !== "review",
    )
  ) {
    return null;
  }
  return {
    offers: parseOffers(candidate.offers, rootId, proposed),
    singleton: true,
    spawn: proposed.spawn,
  };
}

function parseOffers(
  value: unknown,
  rootId: string,
  proposed: { callId: string; tool: string; args: unknown; spawn: boolean },
): AppaOffer[] {
  if (!Array.isArray(value)) return [];
  const { tool, args } = proposed;
  const expectedDigest = createHash("sha256")
    .update(stableStringify(args))
    .digest("hex");
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const offer = candidate as Record<string, unknown>;
    if (
      typeof offer.offer_id !== "string" ||
      typeof offer.root_id !== "string" ||
      typeof offer.tool !== "string" ||
      typeof offer.arguments_sha256 !== "string" ||
      ![
        "acceptance",
        "human_approval",
        "authority",
        "sanitizer",
        "unsupported",
      ].includes(String(offer.kind)) ||
      offer.root_id !== rootId ||
      offer.tool !== tool ||
      offer.arguments_sha256 !== expectedDigest
    ) {
      return [];
    }
    return [offer as AppaOffer];
  });
}

function singletonOfferCall(
  event: Record<string, unknown>,
): { callId: string; tool: string; args: unknown; spawn: boolean } | null {
  if (event.event === "tool_call" && typeof event.tool === "string") {
    return {
      callId: "",
      tool: event.tool,
      args: event.arguments,
      spawn: event.spawn === true,
    };
  }
  if (event.event !== "tool_calls" || !Array.isArray(event.calls)) return null;
  if (event.calls.length !== 1) return null;
  const [call] = event.calls;
  if (!call || typeof call !== "object" || Array.isArray(call)) return null;
  const candidate = call as Record<string, unknown>;
  if (
    typeof candidate.call_id !== "string" ||
    typeof candidate.tool !== "string"
  )
    return null;
  return {
    callId: candidate.call_id,
    tool: candidate.tool,
    args: candidate.arguments,
    spawn: candidate.spawn === true,
  };
}

function shortBackoff(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
}

function outcomeStatus(
  result: AppaInboundToolResult,
): "success" | "failure" | "indeterminate" {
  return result.status ?? (result.isError ? "failure" : "success");
}

function outcomePresentation(result: AppaInboundToolResult): string {
  return result.message ?? "Tool execution failed.";
}

function modelOutcomeNotice(result: AppaInboundToolResult): string {
  return JSON.stringify({
    status: outcomeStatus(result),
    message:
      outcomeStatus(result) === "failure"
        ? outcomePresentation(result)
        : "Tool outcome is unknown.",
  });
}

function outcomePresentationHash(
  secret: string,
  result: AppaInboundToolResult,
): string | null {
  if (result.message) return keyedDigest(secret, result.message);
  if (outcomeStatus(result) !== "failure") return null;
  return keyedDigest(secret, outcomePresentation(result));
}
