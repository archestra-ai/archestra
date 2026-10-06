import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  hasScopedPermission,
  TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
} from "@archestra/shared";
import type { UIMessage } from "ai";
import type { A2AActor } from "@/agents/a2a/a2a-base";
import {
  A2AContextManager,
  A2ATaskManager,
} from "@/agents/a2a/a2a-model-manager";
import {
  type A2AArchestraApprovalRequest,
  A2AProtocolRole,
  A2AProtocolTaskState,
} from "@/agents/a2a/a2a-protocol";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import config from "@/config";
import {
  A2AMessageModel,
  A2ATaskApprovalRequestModel,
  A2ATaskModel,
  AgentModel,
} from "@/models";
import MemberModel from "@/models/member";
import { ResourcePermissions } from "@/services/resource-permissions";
import type { DurableReviewPause } from "./durable-review";
import {
  consumeHitlRuling,
  getHitlReview,
  recordHitlRuling,
} from "./hitl-review";
import {
  type OfferJws,
  OfferJwsSchema,
  verifyOfferClaims,
} from "./offer-claims";
import {
  type ReviewOrigin,
  stampReviewOrigin,
  verifyReviewOrigin,
} from "./review-origin";
import {
  executeRemedyByOffer,
  loadOfferReview,
  type OpenAppaSession,
} from "./service";

/** Fixed shared-channel notice. Ledger text stays on the authenticated page. */
export const OPENAPPA_REVIEW_NOTICE = "Review required";

type ChatOpsReviewGate =
  | { kind: "legacy" }
  | { kind: "blocked"; reason: string }
  | {
      kind: "allowed";
      agentId: string;
      sessionId: string;
      offerId: string;
      origin?: ReviewOrigin;
    };

type ChatOpsReviewView = {
  taskId: string;
  approvalId: string;
  offerId: string;
  text: string;
  tool?: string;
  arguments?: string;
};

const STAMPED_KEYS = [
  "execution",
  "protected",
  "payload",
  "signature",
] as const;

export function isExecuteRemedyPlanTool(toolName: string): boolean {
  return (
    toolName === TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME ||
    toolName.endsWith(TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME)
  );
}

export function shouldInstallDurableReview(params: {
  source?: string;
  userId: string;
  parentDelegationChain?: string;
}): boolean {
  if (params.parentDelegationChain) return false;
  if (!params.userId || params.userId === "system") return false;
  return (
    params.source === "email" ||
    params.source === "chatops:slack" ||
    params.source === "chatops:ms-teams" ||
    params.source === "chatops:telegram"
  );
}

export function formatChatOpsReviewUrl(params: {
  taskId: string;
  approvalId: string;
}): string {
  const url = new URL("/openappa-review", config.frontendBaseUrl);
  url.searchParams.set("task", params.taskId);
  url.searchParams.set("approval", params.approvalId);
  return url.toString();
}

export function parkDurableReviewPauses(params: {
  message: UIMessage;
  pauses: readonly DurableReviewPause[];
  origin?: ReviewOrigin;
}): UIMessage {
  const { message, pauses, origin } = params;
  if (pauses.length === 0) return message;
  const parts = message.parts.map((part) => ({ ...part }));
  const origins: Record<string, unknown> = {};
  for (const pause of pauses) {
    if (origin) {
      const verified = verifyOfferClaims(
        pause.jws,
        config.openappa.offerSigningSecret,
      );
      if (verified)
        origins[pause.offerId] = stampReviewOrigin(origin, verified);
    }
    const index = parts.findIndex((part) => partMatchesPause(part, pause));
    const approvalId = crypto.randomUUID();
    if (index >= 0) {
      const part = parts[index] as Record<string, unknown>;
      delete part.output;
      parts[index] = {
        ...part,
        state: "approval-requested",
        approval: { id: approvalId },
      } as UIMessage["parts"][number];
      continue;
    }
    parts.push(syntheticReviewPart(pause, approvalId));
  }
  return {
    ...message,
    parts,
    ...(origin
      ? {
          metadata: {
            ...(isRecord(message.metadata) ? message.metadata : {}),
            openappaReviewOrigins: origins,
          },
        }
      : {}),
  };
}

/**
 * Read the ledger review for an authenticated reviewer. Wrong actor, org, or
 * a missing stage returns blocked and no ledger text.
 */
export async function readChatOpsReview(params: {
  taskId: string;
  approvalId: string;
  reviewerUserId: string;
  organizationId: string;
}): Promise<
  | { kind: "ready"; view: ChatOpsReviewView }
  | { kind: "blocked"; reason: string }
> {
  const bound = await bindReview(params);
  if (bound.kind !== "ready") return bound;
  return {
    kind: "ready",
    view: {
      taskId: params.taskId,
      approvalId: params.approvalId,
      offerId: bound.claims.offer_id,
      text: bound.ledger.text,
      tool: bound.ledger.tool,
      arguments: bound.ledger.arguments,
    },
  };
}

/**
 * Read-only gate. Legacy tool approvals are not OpenAPPA reviews. A remedy
 * approval that fails the signed binding is blocked and must not resume.
 */
export async function authorizeChatOpsReviewResume(params: {
  taskId: string;
  approvalId: string;
  reviewerUserId: string;
  organizationId: string;
  toolName?: string;
}): Promise<ChatOpsReviewGate> {
  const saved = await A2ATaskApprovalRequestModel.findByApprovalId(
    params.approvalId,
  );
  if (!saved || saved.taskId !== params.taskId)
    return { kind: "blocked", reason: "missing_gate" };
  // Provider action payload is routing data, not the classification authority.
  if (!isExecuteRemedyPlanTool(saved.toolName)) {
    return { kind: "legacy" };
  }
  const bound = await bindReview(params);
  if (bound.kind !== "ready") return bound;
  if (!bound.task.agentId) return { kind: "blocked", reason: "wrong_org" };
  return {
    kind: "allowed",
    agentId: bound.task.agentId,
    sessionId: bound.claims.session_id,
    offerId: bound.claims.offer_id,
    ...(bound.origin ? { origin: bound.origin } : {}),
  };
}

/** The signed owner is necessary but cannot override membership or revoked use. */
export async function reviewActorStillAllowed(params: {
  reviewerUserId: string;
  organizationId: string;
  agentId: string;
}): Promise<boolean> {
  const agent = await AgentModel.findById(params.agentId);
  if (
    !agent ||
    agent.organizationId !== params.organizationId ||
    !["agent", "profile"].includes(agent.agentType)
  )
    return false;
  if (
    !(await MemberModel.getByUserId(
      params.reviewerUserId,
      params.organizationId,
    ))
  )
    return false;
  const permission = {
    organizationId: params.organizationId,
    resource: "agent" as const,
    scope: params.agentId,
    action: "use" as const,
  };
  return hasScopedPermission({
    grants: (
      await ResourcePermissions.getEffective({
        ...permission,
        userId: params.reviewerUserId,
      })
    ).grants,
    required: permission,
  });
}

/**
 * After the approval CAS has won and before the SDK re-executes, record the
 * verified ruling. Deny retires the offer here because a denied resume does
 * not enter tool execute.
 */
export async function applyResumedChatOpsReviews(params: {
  messages: UIMessage[];
  reviewerUserId: string;
  organizationId: string;
}): Promise<{ blockedApprovalIds: string[] }> {
  const blockedApprovalIds: string[] = [];
  for (const message of params.messages) {
    for (const part of remedyParts(message)) {
      if (!part.approval?.id) continue;
      if (
        part.state !== "approval-responded" &&
        part.state !== "approval-requested"
      ) {
        continue;
      }
      const row = await A2ATaskApprovalRequestModel.findByApprovalId(
        part.approval.id,
      );
      // A supplied UI part is not the decision. An unresolved row, or a part
      // whose approval flag disagrees with the stored CAS, must not execute.
      if (!row?.resolved || part.approval.approved !== row.approved) {
        blockedApprovalIds.push(part.approval.id);
        continue;
      }
      if (row && part.toolCallId && part.toolCallId !== row.toolCallId) {
        blockedApprovalIds.push(part.approval.id);
        continue;
      }
      const bound = await bindReview({
        approvalId: part.approval.id,
        reviewerUserId: params.reviewerUserId,
        organizationId: params.organizationId,
        allowResolved: true,
      });
      if (bound.kind !== "ready") {
        blockedApprovalIds.push(part.approval.id);
        continue;
      }
      if (!isRecord(part.input) || !sameRemedy(part.input, bound.input)) {
        blockedApprovalIds.push(part.approval.id);
        continue;
      }
      const ruling = row?.approved === true ? "approve" : "deny";
      const recorded = await recordHitlRuling({
        session: bound.session,
        offerId: bound.claims.offer_id,
        ruling,
        durableApproval: { id: row.id, taskId: row.taskId },
      });
      if (!recorded) {
        blockedApprovalIds.push(part.approval.id);
        continue;
      }
      if (ruling !== "deny") continue;
      if (
        (await consumeHitlRuling({
          session: bound.session,
          offerId: bound.claims.offer_id,
        })) !== "deny"
      ) {
        blockedApprovalIds.push(part.approval.id);
        continue;
      }
      const remedy = withoutPlan(bound.staged.remedyArguments ?? {});
      await executeRemedyByOffer({
        organizationId: bound.claims.organization_id,
        callerId: bound.claims.caller_id ?? undefined,
        sessionId: bound.claims.session_id,
        parentId: bound.claims.parent_id ?? undefined,
        ownerCallerId: bound.claims.caller_id ?? undefined,
        tool: bound.claims.tool ?? undefined,
        spelling: bound.claims.spelling ?? undefined,
        dispatch: bound.claims.dispatch,
        toolCallId: executionCallId(bound.input),
        originalArguments: JSON.stringify(bound.staged.remedyArguments ?? {}),
        args: remedy,
        ruling: "deny",
      });
    }
  }
  return { blockedApprovalIds };
}

export async function persistForegroundEmailReview(params: {
  actor: A2AActor;
  agentId: string;
  uiMessage: UIMessage | undefined;
  /** Already-admitted input; retained so a restarted review does not lose its task. */
  originalTurn?: {
    text: string;
    attachments?: import("@/agents/a2a-executor").A2AAttachment[];
  };
}): Promise<Array<{ taskId: string; approvalId: string; url: string }>> {
  if (!params.uiMessage || params.actor.kind !== "user") return [];
  if (!params.actor.id || params.actor.id === "system") return [];
  const requests = approvalRequestsFromMessage(params.uiMessage);
  if (requests.length === 0) return [];
  const context = await A2AContextManager.createContext(params.actor);
  const task = await A2ATaskManager.createTask({
    context,
    actor: params.actor,
    state: A2AProtocolTaskState.InputRequired,
    approvalRequests: requests,
    agentId: params.agentId,
  });
  if (params.originalTurn) {
    const userMessage: UIMessage = {
      id: crypto.randomUUID(),
      role: "user",
      parts: [
        { type: "text", text: params.originalTurn.text },
        ...(params.originalTurn.attachments ?? []).map((attachment) => ({
          type: "file" as const,
          mediaType: attachment.contentType,
          filename: attachment.name,
          url: `data:${attachment.contentType};base64,${attachment.contentBase64}`,
        })),
      ],
    };
    await A2ATaskManager.addMessageToTask({
      task,
      message: {
        messageId: userMessage.id,
        contextId: context.id,
        taskId: task.id,
        role: A2AProtocolRole.User,
        parts: [{ text: params.originalTurn.text }],
      },
      uiMessage: userMessage,
    });
  }
  await A2ATaskManager.addMessageToTask({
    task,
    message: {
      messageId: params.uiMessage.id,
      contextId: context.id,
      taskId: task.id,
      role: A2AProtocolRole.Agent,
      parts: [{ text: OPENAPPA_REVIEW_NOTICE }],
    },
    uiMessage: params.uiMessage,
  });
  return requests.map((request) => ({
    taskId: task.id,
    approvalId: request.approvalId,
    url: formatChatOpsReviewUrl({
      taskId: task.id,
      approvalId: request.approvalId,
    }),
  }));
}

type BoundReview = {
  kind: "ready";
  claims: NonNullable<ReturnType<typeof verifyOfferClaims>>;
  session: OpenAppaSession;
  ledger: NonNullable<Awaited<ReturnType<typeof loadOfferReview>>>;
  staged: NonNullable<Awaited<ReturnType<typeof getHitlReview>>>;
  input: Record<string, unknown>;
  origin?: ReviewOrigin;
  task: NonNullable<Awaited<ReturnType<typeof A2ATaskModel.findById>>>;
};

async function bindReview(params: {
  taskId?: string;
  approvalId: string;
  reviewerUserId: string;
  organizationId: string;
  part?: ToolPart;
  allowResolved?: boolean;
}): Promise<BoundReview | { kind: "blocked"; reason: string }> {
  if (!params.reviewerUserId || params.reviewerUserId === "system") {
    return { kind: "blocked", reason: "missing_reviewer" };
  }
  const taskId =
    params.taskId ||
    (await A2ATaskApprovalRequestModel.findByApprovalId(params.approvalId))
      ?.taskId;
  const task = taskId ? await A2ATaskModel.findById(taskId) : null;
  if (!task?.agentId) return { kind: "blocked", reason: "wrong_task" };
  const agent = await AgentModel.findById(task.agentId);
  if (!agent || agent.organizationId !== params.organizationId) {
    return { kind: "blocked", reason: "wrong_org" };
  }
  const approvals = await A2ATaskApprovalRequestModel.findByTaskId(task.id);
  const approval = approvals.find(
    (row) => row.approvalId === params.approvalId,
  );
  if (!approval) return { kind: "blocked", reason: "wrong_task" };
  if (approval.resolved && !params.allowResolved) {
    return { kind: "blocked", reason: "already_resolved" };
  }
  if (!isExecuteRemedyPlanTool(approval.toolName) && !params.part) {
    return { kind: "blocked", reason: "not_openappa" };
  }
  const savedPart = await findApprovalPart({
    taskId: task.id,
    approvalId: params.approvalId,
  });
  const part = params.part ?? savedPart?.part;
  if (!part) return { kind: "blocked", reason: "wrong_task" };
  const input = isRecord(part.input) ? part.input : null;
  const jws = input ? jwsFromInput(input) : null;
  if (!input || !jws) return { kind: "blocked", reason: "invalid_offer" };
  const claims = verifyOfferClaims(jws, config.openappa.offerSigningSecret);
  if (!claims) return { kind: "blocked", reason: "invalid_offer" };
  if (claims.organization_id !== params.organizationId) {
    return { kind: "blocked", reason: "wrong_org" };
  }
  if (claims.caller_id !== `user:${params.reviewerUserId}`) {
    return {
      kind: "blocked",
      reason: claims.caller_id ? "wrong_actor" : "missing_reviewer",
    };
  }
  if (!(await reviewActorStillAllowed({ ...params, agentId: task.agentId }))) {
    return { kind: "blocked", reason: "permission_revoked" };
  }
  const session = sessionFromClaims(claims);
  const staged = await getHitlReview({
    session,
    offerId: claims.offer_id,
  });
  if (!staged) return { kind: "blocked", reason: "expired" };
  if (!sameRemedy(unstamped(input), staged.remedyArguments ?? {})) {
    return { kind: "blocked", reason: "args_mismatch" };
  }
  const ledger = await loadOfferReview({
    organizationId: claims.organization_id,
    sessionId: claims.session_id,
    offerId: claims.offer_id,
  });
  if (!ledger) return { kind: "blocked", reason: "expired" };
  if (
    (ledger.tool ?? "") !== (staged.tool ?? "") ||
    (ledger.arguments ?? "") !== (staged.arguments ?? "")
  ) {
    return { kind: "blocked", reason: "args_mismatch" };
  }
  const origins = savedPart?.origins;
  const origin = isRecord(origins)
    ? verifyReviewOrigin(origins[claims.offer_id], claims)
    : undefined;
  return {
    kind: "ready",
    claims,
    session,
    ledger,
    staged,
    input,
    task,
    origin,
  };
}

async function findApprovalPart(params: {
  taskId: string;
  approvalId: string;
}): Promise<{ part: ToolPart; origins: unknown } | null> {
  const messages = await A2AMessageModel.findByTaskId(params.taskId);
  for (const message of messages) {
    const ui = message.content as UIMessage | null;
    if (!ui || !Array.isArray(ui.parts)) continue;
    for (const part of remedyParts(ui)) {
      if (part.approval?.id === params.approvalId) {
        const metadata = ui.metadata;
        return {
          part,
          origins: isRecord(metadata)
            ? metadata.openappaReviewOrigins
            : undefined,
        };
      }
    }
  }
  return null;
}

function sessionFromClaims(
  claims: NonNullable<ReturnType<typeof verifyOfferClaims>>,
): OpenAppaSession {
  return {
    organization_id: claims.organization_id,
    session_id: claims.session_id,
    ...(claims.caller_id ? { caller_id: claims.caller_id } : {}),
    ...(claims.parent_id ? { parent_id: claims.parent_id } : {}),
  };
}

function jwsFromInput(input: Record<string, unknown>): OfferJws | null {
  const parsed = OfferJwsSchema.safeParse({
    protected: input.protected,
    payload: input.payload,
    signature: input.signature,
  });
  return parsed.success ? parsed.data : null;
}

function unstamped(input: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...input };
  for (const key of STAMPED_KEYS) delete copy[key];
  return copy;
}

function withoutPlan(args: Record<string, unknown>): Record<string, unknown> {
  const { plan: _plan, ...rest } = args;
  return rest;
}

function sameRemedy(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  return isDeepStrictEqual(left, right);
}

function executionCallId(input: Record<string, unknown>): string | undefined {
  const execution = input.execution;
  if (!isRecord(execution)) return undefined;
  return typeof execution.call_id === "string" ? execution.call_id : undefined;
}

type ToolPart = {
  type: string;
  state?: string;
  toolCallId?: string;
  input?: unknown;
  approval?: { id?: string; approved?: boolean };
};

function remedyParts(message: UIMessage): ToolPart[] {
  return message.parts.flatMap((part) => {
    if (
      typeof part.type !== "string" ||
      !part.type.startsWith("tool-") ||
      !isExecuteRemedyPlanTool(part.type.slice("tool-".length))
    ) {
      return [];
    }
    return [part as ToolPart];
  });
}

function partMatchesPause(
  part: UIMessage["parts"][number],
  pause: DurableReviewPause,
): boolean {
  if (!part.type.startsWith("tool-")) return false;
  const record = part as { toolCallId?: string; input?: unknown };
  if (pause.toolCallId && record.toolCallId === pause.toolCallId) return true;
  return (
    isRecord(record.input) &&
    record.input.offer_id === pause.offerId &&
    isExecuteRemedyPlanTool(part.type.slice("tool-".length))
  );
}

function syntheticReviewPart(
  pause: DurableReviewPause,
  approvalId: string,
): UIMessage["parts"][number] {
  const toolName =
    pause.toolName ??
    archestraMcpBranding.getToolName(TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME);
  return {
    type: `tool-${toolName}`,
    toolCallId: pause.toolCallId ?? crypto.randomUUID(),
    state: "approval-requested",
    input: { ...pause.remedyArguments, ...pause.jws },
    approval: { id: approvalId },
  } as UIMessage["parts"][number];
}

function approvalRequestsFromMessage(
  message: UIMessage,
): A2AArchestraApprovalRequest[] {
  const requests: A2AArchestraApprovalRequest[] = [];
  for (const part of remedyParts(message)) {
    if (!part.state?.startsWith("approval-") || !part.approval?.id) continue;
    if (!part.toolCallId) continue;
    requests.push({
      approvalId: part.approval.id,
      toolCallId: part.toolCallId,
      toolName: part.type.slice("tool-".length),
      approved: false,
      resolved: false,
    });
  }
  return requests;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
