import { actorFromUserId } from "@/auth/service-account-user-id";
import logger from "@/logging";
import AuditLogModel from "@/models/audit-log";
import ServiceAccountModel from "@/models/service-account";
import UserModel from "@/models/user";
import type { AgentRunRecord } from "@/types";
import { trackBackgroundWork } from "@/utils/background-work";

/**
 * Audit trail for a browser attached to a run's live terminal.
 *
 * Typing into the terminal reaches the agent's own input loop, so a keystroke
 * there can stop the turn or close the agent. The audit log keeps who was
 * attached, when, and when they sent an interrupt, which a terminal recording
 * (output only) cannot show.
 */
type TerminalAuditAction =
  | "agentRun.terminal_attached"
  | "agentRun.terminal_detached"
  | "agentRun.terminal_interrupted";

/** ETX, what a terminal sends for Ctrl+C. */
const INTERRUPT = "\x03";

/** How many Ctrl+C one input message carries; a paste or a fast key can send several. */
export function countInterrupts(data: string): number {
  return data.split(INTERRUPT).length - 1;
}

/** Interrupts repeated within this window are one event, not a row each. */
export const INTERRUPT_AUDIT_WINDOW_MS = 5_000;

export interface TerminalAttachment {
  session: AgentRunRecord;
  /** The run id the client attached by; a stable alias of an earlier turn, at times. */
  requestedRunId: string;
  actorUserId: string;
  podName: string;
  attachedAt: number;
  lastInterruptAt: number | null;
  /** Every Ctrl+C sent, counting the ones a burst folded into one row. */
  interruptCount: number;
}

async function recordTerminalAudit(
  action: TerminalAuditAction,
  attachment: TerminalAttachment,
  occurredAt: Date,
  details: Record<string, unknown>,
): Promise<void> {
  const { session, requestedRunId, actorUserId, podName } = attachment;
  const actor = actorFromUserId(actorUserId);
  const user = actor.kind === "user" ? await UserModel.getById(actor.id) : null;
  const account =
    actor.kind === "serviceAccount"
      ? await ServiceAccountModel.findById(actor.id, session.organizationId)
      : null;
  await AuditLogModel.create({
    organizationId: session.organizationId,
    actorId: actor.kind === "user" ? actor.id : null,
    actorType: actor.kind === "user" ? "user" : "service_account",
    actorName: user?.name ?? account?.name ?? null,
    actorEmail: user?.email ?? null,
    action,
    outcome: "success",
    resourceType: "agentRun",
    resourceId: session.taskId,
    resourceName: session.title,
    before: null,
    after: {
      taskId: session.taskId,
      runId: requestedRunId,
      agentId: session.agentId,
      workloadName: session.workloadName,
      podName,
      ...(actor.kind === "serviceAccount"
        ? { serviceAccountId: actor.id }
        : {}),
      ...details,
    },
    httpMethod: null,
    httpPath: "websocket:agent_run_attach",
    httpRoute: null,
    httpStatus: null,
    requestId: null,
    sourceIp: null,
    userAgent: null,
    occurredAt,
  });
}

/**
 * Fire-and-forget: a failed audit write must not break the live terminal.
 * The write is tracked background work, so shutdown and test teardown wait
 * for it rather than closing the database under it.
 */
export function auditTerminal(
  action: TerminalAuditAction,
  attachment: TerminalAttachment,
  details: Record<string, unknown> = {},
): void {
  const occurredAt = new Date();
  const context = {
    action,
    runId: attachment.requestedRunId,
    taskId: attachment.session.taskId,
    podName: attachment.podName,
    actorUserId: attachment.actorUserId,
    ...details,
  };
  logger.info(context, "Agent run terminal event");
  trackBackgroundWork(
    recordTerminalAudit(action, attachment, occurredAt, details).catch((err) =>
      logger.error(
        { err, ...context },
        "audit: failed to record terminal event",
      ),
    ),
  );
}
