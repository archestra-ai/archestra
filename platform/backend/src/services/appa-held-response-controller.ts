import { createHash, randomUUID } from "node:crypto";
import { hasAnyAgentTypeAdminPermission } from "@/auth";
import {
  AgentTeamModel,
  AppaApprovalModel,
  AppaProxySessionModel,
} from "@/models";
import AppaProxyWireModel from "@/models/appa-proxy-wire";
import type {
  AppaInboundToolResult,
  AppaOutboundToolCall,
  AppaProxyHookConfig,
} from "@/routes/proxy/appa-proxy-hook";
import {
  AppaProxyHookSession,
  canonicalJsonObject,
} from "@/routes/proxy/appa-proxy-hook";
import { AppaControlFramePayloadSchema } from "@/types/appa-proxy-wire";

export type AppaSyntheticControlCall = {
  id: string;
  namespace: string;
  name:
    | "archestra__appa_inspect_plan"
    | "archestra__appa_execute_remedy"
    | "archestra__appa_status";
  arguments: string;
};

type HeldBatch = {
  batchId: string;
  calls: AppaOutboundToolCall[];
  offers: HeldOffer[];
  preparedPositions: number[];
};

type HeldOffer = {
  id: string;
  batchId: string;
  position: number;
  callId: string;
  kind:
    | "acceptance"
    | "human_approval"
    | "sanitizer"
    | "authority"
    | "unsupported";
  tool: string;
  argumentsSha256: string;
  effectiveArguments: Record<string, unknown>;
};

/**
 * Owns the held-response remedy loop. It never asks the model to regenerate a
 * tool call: it returns either a server-vouched control call or the exact call
 * bytes persisted before the original response was withheld.
 */
export class AppaHeldResponseController {
  /**
   * Handler-facing pre-acquire continuation. Call this before ordinary session
   * acquisition for every inbound tool-result batch. Active controls occupy the
   * held turn; completed controls from an issued parent are surfaced so callers
   * can omit their synthetic traffic from normal APPA admission.
   */
  async continueBeforeAcquire(params: {
    config: AppaProxyHookConfig;
    organizationId: string;
    authenticatedUserId: string;
    profileId: string;
    ownerScopeHash: string;
    threadId: string;
    controlItemIds: ReadonlyMap<string, string>;
    results: ReadonlyArray<Pick<AppaInboundToolResult, "id">>;
    signal?: AbortSignal;
  }): Promise<
    | { state: "not_control" }
    | { state: "historical"; controlCallIds: string[] }
    | { state: "pending" }
    | {
        state: "held";
        session: AppaProxyHookSession;
        heldFrameId: string;
        control: AppaSyntheticControlCall;
      }
    | { state: "rejected" }
    | {
        state: "committed";
        session: AppaProxyHookSession;
        heldFrameId: string;
        calls: AppaOutboundToolCall[];
      }
  > {
    if (params.results.length === 0) return { state: "not_control" };
    const metadata = await Promise.all(
      params.results.map(async (result) => ({
        result,
        control: await AppaProxyWireModel.findControlMetadataForOrganization({
          controlCallId: result.id,
          organizationId: params.organizationId,
        }),
      })),
    );
    const controls = metadata.filter((candidate) => candidate.control !== null);
    if (controls.length === 0) return { state: "not_control" };
    if (controls.some((candidate) => !candidate.control))
      return { state: "rejected" };
    if (
      controls.some(
        (candidate) =>
          candidate.control?.session.profileId !== params.profileId ||
          candidate.control?.session.ownerScopeHash !== params.ownerScopeHash,
      )
    ) {
      // Check the caller's header-derived scope before considering whether the
      // control is pending. A pending control is not a cross-scope status API.
      return { state: "rejected" };
    }
    const firstControl = controls[0]?.control;
    if (
      !firstControl ||
      controls.some(
        (candidate) =>
          candidate.control?.session.id !== firstControl.session.id,
      )
    ) {
      return { state: "rejected" };
    }
    const classified = await Promise.all(
      controls.map(async ({ result, control }) => {
        if (!control) return undefined;
        const scope = {
          sessionId: control.session.id,
          ownerScopeHash: control.session.ownerScopeHash,
        };
        const owned = await AppaProxyWireModel.findOwned({
          ...scope,
          frameId: control.frame.id,
        });
        const payload =
          owned && AppaControlFramePayloadSchema.safeParse(owned.payload);
        if (
          !owned ||
          !payload?.success ||
          owned.frame.kind !== "remedy_control" ||
          owned.frame.controlCallId !== result.id ||
          payload.data.owner.id !== params.authenticatedUserId ||
          payload.data.boundThreadId !== params.threadId ||
          (payload.data.boundItemId !== undefined &&
            payload.data.boundItemId !== params.controlItemIds.get(result.id))
        ) {
          return undefined;
        }
        const parent = await AppaProxyWireModel.findOwned({
          ...scope,
          frameId: payload.data.heldParentFrameId,
        });
        if (
          !parent ||
          parent.frame.kind !== "model_response" ||
          parent.frame.turnId !== owned.frame.turnId
        ) {
          return undefined;
        }
        const completed =
          owned.frame.state === "completed" && owned.receipt !== null;
        if (parent.frame.state === "issued" && completed) {
          return {
            kind: "historical" as const,
            controlCallId: result.id,
          };
        }
        if (parent.frame.state !== "held") return undefined;
        return {
          kind: "active" as const,
          controlCallId: result.id,
          heldFrameId: payload.data.heldParentFrameId,
          completed,
        };
      }),
    );
    if (classified.some((control) => !control)) return { state: "rejected" };
    const active = classified.filter(
      (
        control,
      ): control is Extract<(typeof classified)[number], { kind: "active" }> =>
        control?.kind === "active",
    );
    const historical = classified.filter(
      (
        control,
      ): control is Extract<
        (typeof classified)[number],
        { kind: "historical" }
      > => control?.kind === "historical",
    );
    if (active.length > 0 && historical.length > 0) {
      return { state: "rejected" };
    }
    if (historical.length === classified.length) {
      return {
        state: "historical",
        controlCallIds: historical.map((control) => control.controlCallId),
      };
    }
    const ordinaryResults = metadata.filter(
      (candidate) => candidate.control === null,
    );
    const sessionCalls = await AppaProxySessionModel.listCalls(
      firstControl.session.id,
    );
    if (
      ordinaryResults.some(
        ({ result }) =>
          sessionCalls.find((call) => call.callId === result.id)?.state !==
          "result_admitted",
      )
    ) {
      return { state: "rejected" };
    }
    const activeControl = active[active.length - 1];
    if (
      !activeControl ||
      active.some(
        (control) => control.heldFrameId !== activeControl.heldFrameId,
      )
    ) {
      return { state: "rejected" };
    }
    if (active.some((control) => !control.completed))
      return { state: "pending" };
    const claimed = await this.claimContinuationForControlResult({
      config: params.config,
      organizationId: params.organizationId,
      authenticatedUserId: params.authenticatedUserId,
      controlCallId: activeControl.controlCallId,
      threadId: params.threadId,
      itemId: params.controlItemIds.get(activeControl.controlCallId),
      signal: params.signal,
    });
    if (!claimed) return { state: "rejected" };
    const continued = await this.continueInboundControlResults({
      session: claimed.session,
      results: [{ id: activeControl.controlCallId }],
    });
    if (continued.state === "not_control") return { state: "rejected" };
    if (continued.state === "pending") return continued;
    return {
      ...continued,
      session: claimed.session,
      heldFrameId: claimed.heldFrameId,
    };
  }

  /**
   * Pre-acquire path for an inbound synthetic control result. The call id is a
   * locator only: this reads the server-owned control frame and receipt before
   * returning the occupied turn. Parent handlers must invoke this before an
   * ordinary `AppaProxyHookSession.acquire` attempt.
   */
  async claimContinuationForControlResult(params: {
    config: AppaProxyHookConfig;
    organizationId: string;
    authenticatedUserId: string;
    controlCallId: string;
    threadId: string;
    itemId?: string;
    signal?: AbortSignal;
  }): Promise<
    | {
        session: AppaProxyHookSession;
        heldFrameId: string;
      }
    | undefined
  > {
    const metadata =
      await AppaProxyWireModel.findControlMetadataForOrganization({
        controlCallId: params.controlCallId,
        organizationId: params.organizationId,
      });
    if (!metadata) return undefined;
    const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
      userId: params.authenticatedUserId,
      organizationId: params.organizationId,
    });
    if (
      !(await AgentTeamModel.userHasAgentAccess(
        params.authenticatedUserId,
        metadata.session.profileId,
        isAgentAdmin,
      ))
    ) {
      return undefined;
    }
    const found = await AppaProxyWireModel.findOwned({
      sessionId: metadata.session.id,
      ownerScopeHash: metadata.session.ownerScopeHash,
      frameId: metadata.frame.id,
    });
    const payload =
      found && AppaControlFramePayloadSchema.safeParse(found.payload);
    if (
      !found ||
      !payload?.success ||
      found.frame.state !== "completed" ||
      !found.receipt ||
      payload.data.owner.id !== params.authenticatedUserId ||
      payload.data.boundThreadId !== params.threadId ||
      (payload.data.boundItemId !== undefined &&
        payload.data.boundItemId !== params.itemId)
    ) {
      return undefined;
    }
    const session = await AppaProxyHookSession.claimHeldContinuation({
      config: params.config,
      sessionId: metadata.session.id,
      ownerScopeHash: metadata.session.ownerScopeHash,
      turnId: metadata.frame.turnId,
      organizationId: params.organizationId,
      signal: params.signal,
    });
    return { session, heldFrameId: payload.data.heldParentFrameId };
  }

  /**
   * Completes the pre-acquire control-result path. It intentionally ignores the
   * result content and `claimedCall`: only the stored receipt authorizes the
   * continuation, so this must run before ordinary APPA result admission.
   */
  async continueInboundControlResults(params: {
    session: AppaProxyHookSession;
    results: ReadonlyArray<{ id: string }>;
  }): Promise<
    | { state: "not_control" }
    | { state: "pending" }
    | { state: "held"; control: AppaSyntheticControlCall }
    | { state: "committed"; calls: AppaOutboundToolCall[] }
  > {
    const scope = params.session.getNativeWireScope();
    const controls = await Promise.all(
      params.results.map(async (result) => ({
        result,
        frame: await AppaProxyWireModel.findByControlCall({
          ...scope,
          controlCallId: result.id,
        }),
      })),
    );
    const matched = controls.filter((control) => control.frame !== null);
    if (matched.length === 0) return { state: "not_control" };
    if (matched.length !== 1) {
      throw new Error(
        "control result cannot be mixed with ordinary tool results",
      );
    }
    const sessionCalls = await AppaProxySessionModel.listCalls(scope.sessionId);
    if (
      controls.some(
        ({ result, frame }) =>
          frame === null &&
          sessionCalls.find((call) => call.callId === result.id)?.state !==
            "result_admitted",
      )
    ) {
      throw new Error(
        "control result was mixed with an unadmitted tool result",
      );
    }
    const control = matched[0];
    const payload = AppaControlFramePayloadSchema.safeParse(
      control.frame?.payload,
    );
    if (!payload.success)
      throw new Error("control result has no durable binding");
    return await this.continueFromControlResult({
      session: params.session,
      heldFrameId: payload.data.heldParentFrameId,
      controlCallId: control.result.id,
    });
  }

  async prepare(params: {
    session: AppaProxyHookSession;
    heldFrameId: string;
    calls: AppaOutboundToolCall[];
    organizationId?: string;
    authenticatedUserId: string;
    controlNamespace: string;
    boundThreadId: string;
  }): Promise<
    | { state: "committed"; calls: AppaOutboundToolCall[] }
    | { state: "held"; batchId: string; control: AppaSyntheticControlCall }
  > {
    assertUserAndNamespace(params);
    if (params.calls.length === 0)
      throw new Error("held response has no calls");
    const batchId = randomUUID();
    let batch: HeldBatch;
    try {
      const prepared = await params.session.prepareRuntimeBatch({
        batchId,
        calls: params.calls,
      });
      batch = parsePreparedBatch({
        prepared,
        batchId,
        calls: params.calls,
      });
    } catch (error) {
      // A prepared receipt we cannot prove is an unknown remote state, not a
      // retryable authorization failure.
      await params.session.quarantineHeldResponse();
      throw error;
    }
    if (batch.offers.length === 0) {
      let committedCalls: AppaOutboundToolCall[];
      try {
        committedCalls = await params.session.commitRuntimeBatch({
          batchId,
          calls: params.calls,
        });
        await this.rebuildHeldResponse({
          session: params.session,
          heldFrameId: params.heldFrameId,
          calls: committedCalls,
        });
        await this.publishHeldResponse({
          session: params.session,
          heldFrameId: params.heldFrameId,
        });
      } catch (error) {
        await params.session.quarantineHeldResponse();
        throw error;
      }
      return { state: "committed", calls: committedCalls };
    }
    await this.persistBatch({
      session: params.session,
      heldFrameId: params.heldFrameId,
      batch,
    });
    const selected = selectSafeOffer(batch, new Set(batch.preparedPositions));
    if (!selected) {
      await params.session.quarantineHeldResponse();
      throw new Error("held response has no executable safe remedy");
    }
    const control = await this.createControl({
      ...params,
      batch,
      operation: "execute",
      remedyId: selected.id,
    });
    return { state: "held", batchId, control };
  }

  /** Issues an operation only from offers encrypted in the held response. */
  async issueControl(params: {
    session: AppaProxyHookSession;
    heldFrameId: string;
    authenticatedUserId: string;
    controlNamespace: string;
    boundThreadId: string;
    operation: "inspect" | "execute" | "status";
    remedyId?: string;
  }): Promise<AppaSyntheticControlCall> {
    assertUserAndNamespace(params);
    const scope = params.session.getNativeWireScope();
    const controls = await AppaProxyWireModel.listControlsForParent({
      ...scope,
      parentFrameId: params.heldFrameId,
    });
    const prior = controls
      .map((control) =>
        AppaControlFramePayloadSchema.safeParse(control?.payload),
      )
      .find((result) => result.success)?.data;
    if (!prior) throw new Error("held response has no prepared remedy batch");
    if (prior.owner.id !== params.authenticatedUserId) {
      throw new Error("held response belongs to another authenticated user");
    }
    const batch: HeldBatch = {
      batchId: prior.offers[0]?.batchId ?? "",
      calls: [],
      offers: prior.offers,
      preparedPositions: [],
    };
    if (
      params.operation === "execute" &&
      (!params.remedyId ||
        !batch.offers.some((offer) => offer.id === params.remedyId))
    ) {
      throw new Error("selected remedy is not in the held batch");
    }
    return await this.createControl({ ...params, batch });
  }

  /**
   * A client result is merely a locator. Continuation requires the matching
   * stored control receipt and commits only when every held position has one.
   */
  async continueFromControlResult(params: {
    session: AppaProxyHookSession;
    heldFrameId: string;
    controlCallId: string;
  }): Promise<
    | { state: "pending" }
    | { state: "held"; control: AppaSyntheticControlCall }
    | { state: "committed"; calls: AppaOutboundToolCall[] }
  > {
    const scope = params.session.getNativeWireScope();
    const result = await AppaProxyWireModel.findByControlCall({
      ...scope,
      controlCallId: params.controlCallId,
    });
    const payload =
      result && AppaControlFramePayloadSchema.safeParse(result.payload);
    if (
      !result ||
      !payload?.success ||
      payload.data.heldParentFrameId !== params.heldFrameId ||
      result.frame.state !== "completed" ||
      !result.receipt
    ) {
      throw new Error("control result has no durable trusted receipt");
    }

    const controls = await AppaProxyWireModel.listControlsForParent({
      ...scope,
      parentFrameId: params.heldFrameId,
    });
    const receipts = controls.flatMap((control) => {
      const parsed =
        control && AppaControlFramePayloadSchema.safeParse(control.payload);
      return control?.frame.state === "completed" &&
        control.receipt &&
        parsed?.success
        ? [{ payload: parsed.data, receipt: control.receipt }]
        : [];
    });
    const batchFrame = await AppaProxyWireModel.findHeldBatchForParent({
      ...scope,
      parentFrameId: params.heldFrameId,
    });
    const batch = parseHeldBatch(batchFrame?.payload);
    const calls = batch.calls;
    const batchId = batch.batchId;
    const resolvedPositions = new Set(batch.preparedPositions);
    for (const receipt of receipts) {
      if (receipt.payload.vouch.operation !== "execute") continue;
      const chosen = receipt.payload.offers.find(
        (offer) => offer.id === receipt.payload.vouch.chosenRemedyId,
      );
      if (chosen) {
        resolvedPositions.add(chosen.position);
      }
    }
    if (resolvedPositions.size !== calls.length) {
      const selected = selectSafeOffer(batch, resolvedPositions);
      if (!selected) {
        await params.session.quarantineHeldResponse();
        throw new Error("held response has no executable safe remedy");
      }
      if (!payload.data.controlNamespace) {
        await params.session.quarantineHeldResponse();
        throw new Error("held response has no registered control namespace");
      }
      return {
        state: "held",
        control: await this.createControl({
          session: params.session,
          heldFrameId: params.heldFrameId,
          organizationId: payload.data.organizationId,
          authenticatedUserId: payload.data.owner.id,
          controlNamespace: payload.data.controlNamespace,
          boundThreadId: payload.data.boundThreadId,
          batch,
          operation: "execute",
          remedyId: selected.id,
        }),
      };
    }
    if (!batchFrame) throw new Error("held response batch disappeared");
    const commit = await AppaProxyWireModel.beginHeldBatchCommit({
      ...scope,
      frameId: batchFrame.frame.id,
    });
    if (!commit.acquired) {
      if (commit.frame.state !== "completed") return { state: "pending" };
      await this.publishHeldResponse({
        session: params.session,
        heldFrameId: params.heldFrameId,
      });
      return {
        state: "committed",
        calls: await this.readCommittedHeldCalls({
          session: params.session,
          heldFrameId: params.heldFrameId,
        }),
      };
    }
    try {
      const committedCalls = await params.session.commitRuntimeBatch({
        batchId,
        calls,
      });
      await this.rebuildHeldResponse({
        session: params.session,
        heldFrameId: params.heldFrameId,
        calls: committedCalls,
      });
      await AppaProxyWireModel.completeHeldBatchCommit({
        ...scope,
        frameId: batchFrame.frame.id,
      });
      await this.publishHeldResponse({
        session: params.session,
        heldFrameId: params.heldFrameId,
      });
      return { state: "committed", calls: committedCalls };
    } catch (error) {
      await params.session.quarantineHeldResponse();
      throw error;
    }
  }

  private async createControl(params: {
    session: AppaProxyHookSession;
    heldFrameId: string;
    organizationId?: string;
    authenticatedUserId: string;
    controlNamespace: string;
    boundThreadId: string;
    batch: HeldBatch;
    operation: "inspect" | "execute" | "status";
    remedyId?: string;
  }): Promise<AppaSyntheticControlCall> {
    const scope = params.session.getNativeWireScope();
    const controlCallId = `call_appa_control_${randomUUID().replaceAll("-", "")}`;
    const controlItemId = `fc_${controlCallId}`;
    const selectedOffer = params.remedyId
      ? params.batch.offers.find((offer) => offer.id === params.remedyId)
      : undefined;
    const approval =
      selectedOffer?.kind === "human_approval"
        ? await this.createHumanApproval({
            organizationId: params.organizationId,
            session: params.session,
            offer: selectedOffer,
          })
        : undefined;
    const payload = {
      version: 1 as const,
      purpose: "gateway_remedy" as const,
      type: "remedy_batch" as const,
      intent: {
        id: params.heldFrameId,
        descriptor: "APPA held response remedy",
      },
      rootId: params.session.rootId,
      heldParentFrameId: params.heldFrameId,
      controlNamespace: params.controlNamespace,
      ...(params.organizationId
        ? { organizationId: params.organizationId }
        : {}),
      boundThreadId: params.boundThreadId,
      boundItemId: controlItemId,
      owner: { kind: "user" as const, id: params.authenticatedUserId },
      vouch: {
        operation: params.operation,
        ...(params.operation === "execute"
          ? { chosenRemedyId: params.remedyId }
          : {}),
      },
      offers: params.batch.offers,
      ...(approval ? { approvalId: approval.id } : {}),
    };
    const persistedPayload = AppaControlFramePayloadSchema.parse(payload);
    const wireContext = {
      call_id: controlCallId,
      thread_id: params.boundThreadId,
      item_id: controlItemId,
    };
    const frame = await AppaProxyWireModel.createFrame({
      ...scope,
      kind: "remedy_control",
      protocol: "codex-native-held-remedy/v1",
      requestHash: digest(payload),
      idempotencyKey: `held-remedy:${params.heldFrameId}:${controlCallId}`,
      parentFrameId: params.heldFrameId,
      runtimeBatchId: params.batch.batchId,
      controlCallId,
      payload,
      expiresAt: new Date(Date.now() + 5 * 60_000),
    });
    if (
      frame.kind !== "remedy_control" ||
      frame.controlCallId !== wireContext.call_id ||
      frame.parentFrameId !== persistedPayload.heldParentFrameId ||
      persistedPayload.boundThreadId !== wireContext.thread_id ||
      persistedPayload.boundItemId !== wireContext.item_id
    ) {
      throw new Error(
        "control wire context does not match its durable binding",
      );
    }
    await AppaProxyWireModel.markReady({ ...scope, frameId: frame.id });
    await AppaProxyWireModel.markIssued({ ...scope, frameId: frame.id });
    const name =
      params.operation === "inspect"
        ? "archestra__appa_inspect_plan"
        : params.operation === "execute"
          ? "archestra__appa_execute_remedy"
          : "archestra__appa_status";
    return {
      id: controlCallId,
      namespace: params.controlNamespace,
      name,
      arguments: JSON.stringify(
        params.operation === "execute"
          ? {
              intent_id: params.heldFrameId,
              remedy_id: params.remedyId,
              wire_context: wireContext,
            }
          : { intent_id: params.heldFrameId, wire_context: wireContext },
      ),
    };
  }

  private async persistBatch(params: {
    session: AppaProxyHookSession;
    heldFrameId: string;
    batch: HeldBatch;
  }): Promise<void> {
    const scope = params.session.getNativeWireScope();
    await AppaProxyWireModel.createFrame({
      ...scope,
      kind: "inbound_hold",
      protocol: "held-response-batch/v1",
      requestHash: digest(params.batch),
      idempotencyKey: `held-response-batch:${params.heldFrameId}:${params.batch.batchId}`,
      parentFrameId: params.heldFrameId,
      runtimeBatchId: params.batch.batchId,
      payload: params.batch,
      expiresAt: new Date(Date.now() + 5 * 60_000),
    });
  }

  private async createHumanApproval(params: {
    organizationId: string | undefined;
    session: AppaProxyHookSession;
    offer: HeldOffer;
  }) {
    if (!params.organizationId) {
      throw new Error("human APPA remedy requires organization identity");
    }
    const scope = params.session.getNativeWireScope();
    return await AppaApprovalModel.create({
      organizationId: params.organizationId,
      sessionId: scope.sessionId,
      activeTurnId: scope.turnId,
      candidateCallId: params.offer.callId,
      rootId: params.session.rootId,
      tool: params.offer.tool,
      argumentsSha256: params.offer.argumentsSha256,
      offerId: params.offer.id,
    });
  }

  private async publishHeldResponse(params: {
    session: AppaProxyHookSession;
    heldFrameId: string;
  }): Promise<void> {
    const scope = params.session.getNativeWireScope();
    const held = await AppaProxyWireModel.findOwned({
      ...scope,
      frameId: params.heldFrameId,
    });
    if (!held) throw new Error("held response frame is unavailable");
    if (held.frame.state === "held") {
      await AppaProxyWireModel.finalizeNativeMcpBindingsAndMarkReady({
        ...scope,
        frameId: held.frame.id,
      });
      await AppaProxyWireModel.markIssued({ ...scope, frameId: held.frame.id });
      return;
    }
    if (held.frame.state !== "issued") {
      throw new Error("held response frame cannot be published");
    }
  }

  private async rebuildHeldResponse(params: {
    session: AppaProxyHookSession;
    heldFrameId: string;
    calls: AppaOutboundToolCall[];
  }): Promise<void> {
    const scope = params.session.getNativeWireScope();
    const held = await AppaProxyWireModel.findOwned({
      ...scope,
      frameId: params.heldFrameId,
    });
    if (!held || !isRecord(held.payload) || !isRecord(held.payload.response))
      return;
    const output = Array.isArray(held.payload.response.output)
      ? held.payload.response.output
      : [];
    let position = 0;
    const response = {
      ...held.payload.response,
      output: output.map((item) => {
        if (!isRecord(item) || item.type !== "function_call") return item;
        const call = params.calls[position++];
        if (!call) throw new Error("held native call positions changed");
        return {
          ...item,
          id: `fc_${call.id}`,
          call_id: call.id,
          name: call.emittedName,
          arguments: call.emittedArguments,
        };
      }),
    };
    if (position !== params.calls.length) {
      throw new Error("held native call positions changed");
    }
    await AppaProxyWireModel.replaceHeldPayload({
      ...scope,
      frameId: params.heldFrameId,
      // A replay can observe a completed batch after another continuation
      // published it. Persist the runtime-effective calls with the rebuilt
      // response so that replay never falls back to the held proposal.
      payload: {
        ...held.payload,
        response,
        // `claimNativeMcpExecution` seals against payload.calls. Keep it in
        // lockstep with the server-committed call arguments before publication.
        calls: params.calls.map((call) => ({
          id: call.id,
          name: call.emittedName,
          arguments: call.emittedArguments,
        })),
        committedCalls: params.calls,
      },
    });
  }

  private async readCommittedHeldCalls(params: {
    session: AppaProxyHookSession;
    heldFrameId: string;
  }): Promise<AppaOutboundToolCall[]> {
    const held = await AppaProxyWireModel.findOwned({
      ...params.session.getNativeWireScope(),
      frameId: params.heldFrameId,
    });
    if (!held || !isRecord(held.payload)) {
      throw new Error("committed held response is unavailable");
    }
    return parseCommittedHeldCalls(held.payload.committedCalls);
  }
}

/**
 * A gateway-issued remedy is never a model selection. Prefer the narrowest
 * configured transformation, then an explicit restriction acceptance. Human
 * remedies stay bound to the durable approval row created with their voucher.
 */
function selectSafeOffer(
  batch: HeldBatch,
  resolvedPositions: ReadonlySet<number>,
): HeldOffer | undefined {
  for (const position of Array.from(
    { length: batch.calls.length },
    (_, i) => i,
  )) {
    if (resolvedPositions.has(position)) continue;
    const offers = batch.offers.filter((offer) => offer.position === position);
    return (
      offers.find((offer) => offer.kind === "sanitizer") ??
      offers.find((offer) => offer.kind === "acceptance") ??
      offers.find((offer) => offer.kind === "human_approval")
    );
  }
  return undefined;
}

function assertUserAndNamespace(params: {
  authenticatedUserId: string;
  controlNamespace: string;
}): void {
  if (!params.authenticatedUserId)
    throw new Error("authenticated user is required");
  if (!/^mcp__[A-Za-z0-9_-]+$/.test(params.controlNamespace)) {
    throw new Error("registered APPA control namespace is required");
  }
}

function parsePreparedBatch(params: {
  prepared: Record<string, unknown>;
  batchId: string;
  calls: AppaOutboundToolCall[];
}): HeldBatch {
  if (
    params.prepared.decision !== "batch_prepared" ||
    params.prepared.batch_id !== params.batchId ||
    !Array.isArray(params.prepared.positions)
  ) {
    throw new Error("prepared runtime batch receipt is invalid");
  }
  const byCall = new Map(
    params.calls.map((call, position) => [call.id, { call, position }]),
  );
  const offers: HeldOffer[] = [];
  const preparedPositions: number[] = [];
  const seen = new Set<string>();
  for (const item of params.prepared.positions) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("prepared runtime call is invalid");
    const decision = item as Record<string, unknown>;
    const candidate =
      typeof decision.call_id === "string"
        ? byCall.get(decision.call_id)
        : undefined;
    if (
      !candidate ||
      decision.position !== candidate.position ||
      seen.has(candidate.call.id) ||
      !["held", "blocked"].includes(String(decision.state))
    ) {
      throw new Error("prepared runtime batch does not bind every call");
    }
    seen.add(candidate.call.id);
    if (decision.state === "held") {
      preparedPositions.push(candidate.position);
      continue;
    }
    if (!Array.isArray(decision.offers)) {
      throw new Error("prepared runtime batch position has no offers");
    }
    for (const rawOffer of decision.offers) {
      if (!rawOffer || typeof rawOffer !== "object" || Array.isArray(rawOffer))
        throw new Error("prepared runtime offer is invalid");
      const offer = rawOffer as Record<string, unknown>;
      if (
        typeof offer.offer_id !== "string" ||
        ![
          "acceptance",
          "human_approval",
          "sanitizer",
          "authority",
          "unsupported",
        ].includes(String(offer.kind)) ||
        offer.batch_id !== params.batchId ||
        offer.position !== candidate.position ||
        offer.tool !== candidate.call.targetName ||
        offer.arguments_sha256 !== digest(candidate.call.targetArguments)
      )
        throw new Error("prepared runtime offer binding is invalid");
      offers.push({
        id: offer.offer_id,
        batchId: params.batchId,
        position: candidate.position,
        callId: candidate.call.id,
        kind: offer.kind as HeldOffer["kind"],
        tool: candidate.call.targetName,
        argumentsSha256: offer.arguments_sha256 as string,
        // The current control payload retains this legacy field. It is only a
        // binding for the offered input; committed runtime arguments replace it
        // before the call is ledgered or emitted.
        effectiveArguments: candidate.call.targetArguments,
      });
    }
  }
  if (seen.size !== params.calls.length) {
    throw new Error("prepared runtime batch does not bind every call");
  }
  return {
    batchId: params.batchId,
    calls: params.calls,
    offers,
    preparedPositions,
  };
}

function parseHeldBatch(value: unknown): HeldBatch {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("held response is unavailable");
  const record = value as Record<string, unknown>;
  if (
    !Array.isArray(record.calls) ||
    !Array.isArray(record.offers) ||
    typeof record.batchId !== "string"
  ) {
    throw new Error("held response has no persisted batch candidates");
  }
  return {
    batchId: record.batchId,
    calls: record.calls as AppaOutboundToolCall[],
    offers: record.offers as HeldOffer[],
    preparedPositions: Array.isArray(record.preparedPositions)
      ? (record.preparedPositions as number[])
      : [],
  };
}

function parseCommittedHeldCalls(value: unknown): AppaOutboundToolCall[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("committed held response has no durable calls");
  }
  return value.map((item) => {
    if (!isRecord(item) || !isRecord(item.targetArguments)) {
      throw new Error("committed held response call is invalid");
    }
    const {
      id,
      emittedName,
      emittedArguments,
      emittedArgumentsCanonical,
      targetName,
      targetArguments,
      spawn,
    } = item;
    if (
      typeof id !== "string" ||
      typeof emittedName !== "string" ||
      typeof emittedArguments !== "string" ||
      typeof emittedArgumentsCanonical !== "string" ||
      typeof targetName !== "string" ||
      (spawn !== undefined && typeof spawn !== "boolean") ||
      emittedArgumentsCanonical !== canonicalJsonObject(emittedArguments)
    ) {
      throw new Error("committed held response call is invalid");
    }
    return {
      id,
      emittedName,
      emittedArguments,
      emittedArgumentsCanonical,
      targetName,
      targetArguments,
      ...(spawn === undefined ? {} : { spawn }),
    };
  });
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
