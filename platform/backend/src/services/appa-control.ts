import { createHash, createHmac } from "node:crypto";
import { hasAnyAgentTypeAdminPermission, userHasPermission } from "@/auth";
import { AppaRuntimeClient } from "@/clients/appa-runtime";
import AgentTeamModel from "@/models/agent-team";
import AppaApprovalModel from "@/models/appa-approval";
import AppaProxyWireModel from "@/models/appa-proxy-wire";
import type {
  AppaControlOperationResponse,
  AppaControlPrincipal,
  AppaControlResponse,
  AppaControlService,
  AppaControlSession,
  AppaWireContext,
} from "@/routes/mcp-gateway/appa-controls";
import type {
  AppaControlFramePayload,
  AppaControlOfferKind,
  AppaControlVouchedOperation,
} from "@/types/appa-proxy-wire";
import { AppaControlFramePayloadSchema } from "@/types/appa-proxy-wire";

const MAX_RUNTIME_REQUEST_BYTES = 1024 * 1024;

interface AppaControlRuntime {
  post(params: {
    eventId: string;
    requestBody: string;
    requestSha256: string;
  }): Promise<Record<string, unknown>>;
}

/** Strict, bounded transport for the APPA control-only v1 protocol. */
export class HttpAppaControlRuntime implements AppaControlRuntime {
  private readonly runtime: AppaRuntimeClient;

  constructor(config: {
    url: string;
    runtimeToken: string;
    timeoutMs: number;
  }) {
    this.runtime = new AppaRuntimeClient(config);
  }

  async post(params: {
    eventId: string;
    requestBody: string;
    requestSha256: string;
  }): Promise<Record<string, unknown>> {
    try {
      const prepared = this.runtime.restorePreparedEvent({
        eventId: params.eventId,
        body: params.requestBody,
        requestSha256: params.requestSha256,
      });
      return await this.runtime.postPreparedEvent(prepared);
    } catch {
      throw new AppaControlRuntimeError();
    }
  }
}

/**
 * Durable gateway control service. It intentionally has no process-global
 * instance: the parent integration installs a provider only when it can supply
 * the runtime endpoint and the exact control-session secret.
 */
export class DurableAppaControlService implements AppaControlService {
  constructor(
    private readonly config: {
      runtime: AppaControlRuntime;
      controlSessionSecret: string;
      approvalSigningSecret?: string;
    },
  ) {}

  async authorizeControlSession(params: {
    principal: AppaControlPrincipal;
  }): Promise<AppaControlSession | null> {
    if (!(await this.authorizeMcpProfile(params.principal))) return null;
    return { id: this.controlSessionId(params.principal) };
  }

  async inspectPlan(params: {
    principal: AppaControlPrincipal;
    controlSession: AppaControlSession;
    wireContext: AppaWireContext;
    intentId: string;
  }): Promise<AppaControlResponse> {
    const control = await this.lookup({ ...params, operation: "inspect" });
    if (!control) return rejected();
    if (!this.hasActiveHeldParent(control)) return rejected();
    return {
      state: "complete",
      result: {
        intent_id: control.payload.intent.id,
        status: control.frame.state === "completed" ? "completed" : "available",
        remedies: control.payload.offers.map((offer) => ({
          remedy_id: offer.id,
          kind: offer.kind,
          tool: offer.tool,
          requires_human: offer.kind === "human_approval",
        })),
      },
    };
  }

  async executeSelectedNonHumanRemedy(params: {
    principal: AppaControlPrincipal;
    controlSession: AppaControlSession;
    wireContext: AppaWireContext;
    intentId: string;
    remedyId: string;
  }): Promise<AppaControlOperationResponse> {
    const control = await this.lookup({
      ...params,
      operation: "execute",
      chosenRemedyId: params.remedyId,
    });
    if (!control || !this.hasActiveHeldParent(control)) return rejected();
    const offer = control.payload.offers.find(
      (candidate) => candidate.id === params.remedyId,
    );
    if (
      !offer ||
      !isExecutableOfferKind(offer.kind) ||
      !hasExactEffectiveArguments(offer)
    ) {
      return rejected();
    }

    let approvalId: string | null = null;
    if (offer.kind === "human_approval") {
      if (!control.payload.approvalId) return rejected();
      const decision = await AppaApprovalModel.waitForDecision(
        control.payload.approvalId,
      );
      if (decision !== "approved") return rejected();
      approvalId = await this.getApprovedOfferId(control, offer);
      if (!approvalId) return rejected();
      if (!this.config.approvalSigningSecret) return rejected();
    }

    const selection = {
      operation: control.payload.vouch.operation,
      chosen_remedy_id: control.payload.vouch.chosenRemedyId,
      offer_id: offer.id,
      batch_id: offer.batchId,
      position: offer.position,
      call_id: offer.callId,
      resolution: resolutionFor(offer.kind),
      approval_id: approvalId ?? null,
    };
    let execution: Awaited<
      ReturnType<typeof AppaProxyWireModel.beginControlExecution>
    >;
    try {
      execution = await AppaProxyWireModel.beginControlExecution({
        sessionId: control.session.id,
        ownerScopeHash: control.session.ownerScopeHash,
        frameId: control.frame.id,
        selection,
      });
    } catch {
      return rejected();
    }

    if (!execution.acquired) {
      return execution.frame.state === "completed" ? completed() : pending();
    }

    try {
      const resolutionReceipt = await this.resolveRuntimeOffer({
        control,
        offer,
        executionEventId: execution.frame.executionEventId,
      });
      await AppaProxyWireModel.completeControl({
        sessionId: control.session.id,
        ownerScopeHash: control.session.ownerScopeHash,
        frameId: control.frame.id,
        // Completion follows only an exact acknowledgement of the held offer.
        receipt: resolutionReceipt,
      });
      return completed();
    } catch {
      // The running frame and possibly pending event are intentionally retained:
      // a timeout or malformed receipt cannot safely be replayed.
      return pending();
    }
  }

  async getStatus(params: {
    principal: AppaControlPrincipal;
    controlSession: AppaControlSession;
    wireContext: AppaWireContext;
    intentId: string;
  }): Promise<AppaControlResponse> {
    const control = await this.lookup({ ...params, operation: "status" });
    if (!control) return rejected();
    if (control.frame.state === "completed") return completed();
    if (control.frame.state === "running") return pending();
    if (!this.hasActiveHeldParent(control)) return rejected();
    return {
      state: "complete",
      result: { status: "available" },
    };
  }

  async recordUntrustedMcpElicitationResponse(params: {
    principal: AppaControlPrincipal;
    controlSession: AppaControlSession;
    wireContext: AppaWireContext;
    intentId: string;
    remedyId: string;
    verifiedRequestState: string;
    response: unknown;
  }): Promise<AppaControlResponse> {
    const control = await this.lookup({
      ...params,
      operation: "execute",
      chosenRemedyId: params.remedyId,
    });
    const offer = control?.payload.offers.find(
      (candidate) => candidate.id === params.remedyId,
    );
    // Do not persist client evidence as an authorization decision. The gateway
    // has authenticated the request-state, but only the user-session decision
    // route can create an approved AppaApproval record.
    void params.response;
    if (
      !control ||
      !this.hasActiveHeldParent(control) ||
      !offer ||
      offer.kind !== "human_approval" ||
      params.verifiedRequestState.length === 0
    ) {
      return rejected();
    }
    return pending("awaiting_trusted_review");
  }

  private async lookup(params: {
    principal: AppaControlPrincipal;
    controlSession: AppaControlSession;
    wireContext: AppaWireContext;
    intentId: string;
    operation: AppaControlVouchedOperation;
    chosenRemedyId?: string;
  }): Promise<ControlRecord | null> {
    if (
      params.controlSession.id !== this.controlSessionId(params.principal) ||
      !(await this.authorizeMcpProfile(params.principal)) ||
      !params.wireContext.callId
    ) {
      return null;
    }
    const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
      userId: params.principal.subject.id,
      organizationId: params.principal.organizationId,
    });
    // Only immutable metadata is read here. This locates the actual LLM
    // profile, which is intentionally independent from the MCP gateway profile.
    const metadata =
      await AppaProxyWireModel.findControlMetadataForOrganization({
        controlCallId: params.wireContext.callId,
        organizationId: params.principal.organizationId,
      });
    if (
      !metadata ||
      !(await AgentTeamModel.userHasAgentAccess(
        params.principal.subject.id,
        metadata.session.profileId,
        isAgentAdmin,
      ))
    ) {
      return null;
    }
    // The payload can only be decrypted after membership has been verified for
    // the LLM profile that issued the held parent frame.
    const found = await AppaProxyWireModel.findOwned({
      sessionId: metadata.session.id,
      ownerScopeHash: metadata.session.ownerScopeHash,
      frameId: metadata.frame.id,
    });
    if (!found || found.frame.controlCallId !== params.wireContext.callId)
      return null;
    const parsed = AppaControlFramePayloadSchema.safeParse(found.payload);
    if (
      !parsed.success ||
      !this.matchesWireContext(
        params,
        found.frame,
        metadata.session,
        parsed.data,
      )
    ) {
      return null;
    }
    const parent = await AppaProxyWireModel.getOwnedFrameMetadata({
      sessionId: metadata.session.id,
      ownerScopeHash: metadata.session.ownerScopeHash,
      frameId: parsed.data.heldParentFrameId,
    });
    return {
      ...found,
      payload: parsed.data,
      session: metadata.session,
      parent,
    };
  }

  private async authorizeMcpProfile(
    principal: AppaControlPrincipal,
  ): Promise<boolean> {
    if (principal.subject.kind !== "user") return false;
    const [hasReadPermission, isAgentAdmin] = await Promise.all([
      userHasPermission(
        principal.subject.id,
        principal.organizationId,
        "agent",
        "read",
      ),
      hasAnyAgentTypeAdminPermission({
        userId: principal.subject.id,
        organizationId: principal.organizationId,
      }),
    ]);
    return (
      hasReadPermission &&
      (await AgentTeamModel.userHasAgentAccess(
        principal.subject.id,
        principal.gatewayProfileId,
        isAgentAdmin,
      ))
    );
  }

  private matchesWireContext(
    params: {
      principal: AppaControlPrincipal;
      wireContext: AppaWireContext;
      intentId: string;
      operation: AppaControlVouchedOperation;
      chosenRemedyId?: string;
    },
    frame: { controlCallId: string | null; runtimeBatchId: string | null },
    session: {
      rootId: string;
      clientSessionId: string;
      parentSessionId: string | null;
    },
    payload: AppaControlFramePayload,
  ): boolean {
    return (
      params.principal.subject.kind === "user" &&
      payload.owner.id === params.principal.subject.id &&
      payload.intent.id === params.intentId &&
      payload.heldParentFrameId === params.intentId &&
      frame.controlCallId === params.wireContext.callId &&
      payload.vouch.operation === params.operation &&
      payload.vouch.chosenRemedyId === params.chosenRemedyId &&
      params.wireContext.threadId === payload.boundThreadId &&
      (payload.boundItemId === undefined ||
        params.wireContext.itemId === payload.boundItemId) &&
      session.rootId === payload.rootId &&
      (payload.childId === undefined
        ? session.parentSessionId === null
        : payload.childId === session.clientSessionId) &&
      payload.offers.every((offer) => offer.batchId === frame.runtimeBatchId)
    );
  }

  private hasActiveHeldParent(control: ControlRecord): boolean {
    const { frame, session, parent } = control;
    return (
      frame.expiresAt > new Date() &&
      session.state === "in_turn" &&
      session.activeTurnId === frame.turnId &&
      parent !== null &&
      parent.frame.id === control.payload.heldParentFrameId &&
      parent.frame.turnId === frame.turnId &&
      parent.frame.state === "held" &&
      parent.frame.expiresAt > new Date()
    );
  }

  private async resolveRuntimeOffer(params: {
    control: ControlRecord;
    offer: AppaControlFramePayload["offers"][number];
    executionEventId: string | null;
  }): Promise<Record<string, unknown>> {
    if (!params.executionEventId) throw new AppaControlRuntimeError();
    const { control, offer } = params;
    const resolution = resolutionFor(offer.kind);
    const approval =
      offer.kind === "human_approval"
        ? await this.signedApprovalGrant({
            control,
            offer,
            resolution: "approve",
          })
        : undefined;
    const receipt = await this.postRuntimeEvent({
      control,
      // This is the frame's CAS event id. Once persisted, an uncertain outcome
      // leaves the frame running and cannot be posted again.
      eventId: params.executionEventId,
      event: {
        event: "resolve_batch_offer",
        root_id: control.payload.rootId,
        ...(control.payload.childId
          ? { child_id: control.payload.childId }
          : {}),
        batch_id: offer.batchId,
        position: offer.position,
        offer_id: offer.id,
        tool: offer.tool,
        arguments_sha256: offer.argumentsSha256,
        resolution,
        ...(approval ? { approval } : {}),
      },
    });
    assertResolved(receipt, { offer, resolution });
    return receipt;
  }

  private async signedApprovalGrant(params: {
    control: ControlRecord;
    offer: AppaControlFramePayload["offers"][number];
    resolution: "approve";
  }): Promise<Record<string, unknown>> {
    const approvalId = params.control.payload.approvalId;
    if (!approvalId || !this.config.approvalSigningSecret)
      throw new AppaControlRuntimeError();
    const approval = await AppaApprovalModel.getForTurn({
      id: approvalId,
      sessionId: params.control.session.id,
      activeTurnId: params.control.frame.turnId,
      decision: "approved",
    });
    if (
      !approval ||
      approval.rootId !== params.control.payload.rootId ||
      approval.offerId !== params.offer.id ||
      approval.tool !== params.offer.tool ||
      approval.argumentsSha256 !== params.offer.argumentsSha256 ||
      approval.expiresAt <= new Date()
    ) {
      throw new AppaControlRuntimeError();
    }
    const claims = {
      approval_id: approval.id,
      reviewer_id: approval.approverId,
      root_id: params.control.payload.rootId,
      offer_id: params.offer.id,
      tool: params.offer.tool,
      arguments_sha256: params.offer.argumentsSha256,
      batch_id: params.offer.batchId,
      position: params.offer.position,
      resolution: params.resolution,
      expires_at: approval.expiresAt.getTime(),
    };
    return {
      ...claims,
      signature: createHmac("sha256", this.config.approvalSigningSecret)
        .update(stableStringify(claims))
        .digest("hex"),
    };
  }

  private async getApprovedOfferId(
    control: ControlRecord,
    offer: AppaControlFramePayload["offers"][number],
  ): Promise<string | null> {
    if (!control.payload.approvalId) return null;
    const approval = await AppaApprovalModel.getForTurn({
      id: control.payload.approvalId,
      sessionId: control.session.id,
      activeTurnId: control.frame.turnId,
      decision: "approved",
    });
    return approval &&
      approval.rootId === control.payload.rootId &&
      approval.offerId === offer.id &&
      approval.tool === offer.tool &&
      approval.argumentsSha256 === offer.argumentsSha256
      ? approval.id
      : null;
  }

  private async postRuntimeEvent(params: {
    control: ControlRecord;
    eventId: string;
    event: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const requestBody = JSON.stringify({
      event_id: params.eventId,
      event: params.event,
    });
    if (Buffer.byteLength(requestBody) > MAX_RUNTIME_REQUEST_BYTES) {
      throw new AppaControlRuntimeError();
    }
    const requestSha256 = sha256(requestBody);
    const scope = {
      sessionId: params.control.session.id,
      ownerScopeHash: params.control.session.ownerScopeHash,
      frameId: params.control.frame.id,
      turnId: params.control.frame.turnId,
    };
    await AppaProxyWireModel.createControlRemoteEventIntent({
      ...scope,
      eventId: params.eventId,
      event: String(params.event.event),
      requestBody,
      requestSha256,
    });
    const receipt = await this.config.runtime.post({
      eventId: params.eventId,
      requestBody,
      requestSha256,
    });
    if (
      receipt.protocol_version !== 1 ||
      receipt.event_id !== params.eventId ||
      receipt.request_sha256 !== requestSha256 ||
      !isRecord(receipt.decision)
    ) {
      throw new AppaControlRuntimeError();
    }
    await AppaProxyWireModel.settleControlRemoteEvent({
      ...scope,
      eventId: params.eventId,
      response: receipt,
    });
    return receipt;
  }

  private controlSessionId(principal: AppaControlPrincipal): string {
    return createHmac("sha256", this.config.controlSessionSecret)
      .update(
        `${principal.organizationId}:${principal.gatewayProfileId}:${principal.subject.kind}:${principal.subject.id}`,
      )
      .digest("hex");
  }
}

type FoundControl = Exclude<
  Awaited<ReturnType<typeof AppaProxyWireModel.findOwned>>,
  null
>;
type FoundControlMetadata = Exclude<
  Awaited<
    ReturnType<typeof AppaProxyWireModel.findControlMetadataForOrganization>
  >,
  null
>;
type ControlRecord = Omit<FoundControl, "payload"> & {
  payload: AppaControlFramePayload;
  session: FoundControlMetadata["session"];
  parent: Awaited<ReturnType<typeof AppaProxyWireModel.getOwnedFrameMetadata>>;
};

class AppaControlRuntimeError extends Error {}

function rejected(): AppaControlResponse {
  return { state: "rejected", result: { status: "unavailable" } };
}

function pending(status = "pending"): AppaControlResponse {
  return { state: "pending", result: { status } };
}

function completed(): AppaControlResponse {
  return { state: "complete", result: { status: "completed" } };
}

function isExecutableOfferKind(kind: AppaControlOfferKind): boolean {
  return (
    kind === "acceptance" || kind === "sanitizer" || kind === "human_approval"
  );
}

function hasExactEffectiveArguments(
  offer: AppaControlFramePayload["offers"][number],
): boolean {
  return (
    sha256(stableStringify(offer.effectiveArguments)) === offer.argumentsSha256
  );
}

function resolutionFor(
  kind: AppaControlOfferKind,
): "accept_restriction" | "apply_sanitizer" | "approve" {
  if (kind === "acceptance") return "accept_restriction";
  if (kind === "sanitizer") return "apply_sanitizer";
  if (kind === "human_approval") return "approve";
  throw new AppaControlRuntimeError();
}

function assertResolved(
  receipt: Record<string, unknown>,
  params: {
    offer: AppaControlFramePayload["offers"][number];
    resolution: string;
  },
): void {
  const decision = receipt.decision;
  if (
    !isRecord(decision) ||
    decision.decision !== "batch_offer_resolved" ||
    decision.batch_id !== params.offer.batchId ||
    decision.position !== params.offer.position ||
    decision.offer_id !== params.offer.id ||
    decision.tool !== params.offer.tool ||
    decision.arguments_sha256 !== params.offer.argumentsSha256 ||
    !(
      params.resolution === "accept_restriction"
        ? ["accepted"]
        : params.resolution === "apply_sanitizer"
          ? ["bound", "substituted"]
          : params.resolution === "approve"
            ? ["approved"]
            : ["denied"]
    ).includes(String(decision.resolution))
  ) {
    throw new AppaControlRuntimeError();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
