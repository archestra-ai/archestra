import type { ArchestraContext } from "@/archestra-mcp-server/types";
import type { OpenAppaSession } from "@/openappa/service";
import {
  addressRuntimeChild,
  loadChildReturns,
  returnRuntimeValue,
  startRuntimeChild,
} from "@/openappa/service";
import {
  getGuardrailsDeployment,
  isGuardrailsV2Active,
} from "@/services/guardrails-deployment";
import type { AgentRunActorKind } from "@/types";
import { ApiError } from "@/types";
import {
  resolveRuntimeSessionForWorkspace,
  runtimeOpenAppaSession,
} from "./runtime-identity";

/** JavaScript UTF-16 code units, not UTF-8 bytes; larger output is withheld whole. */
const RUNTIME_OUTPUT_INLINE_LIMIT = 20_000;

export const SPAWN_TARGET_MISMATCH =
  "This spawn was classified for a runtime that is no longer the resolved target. No run was started.";

/**
 * Server-only source of a model-facing runtime crossing.
 * Set from a verified proxy proof, never from client metadata.
 */
export type RuntimeCrossing = {
  source: OpenAppaSession;
  callId: string;
  spawn: boolean;
};

class RuntimeCrossingRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeCrossingRefusal";
  }
}

function crossingFromContext(
  context: Pick<ArchestraContext, "openappaRuntimeCall">,
): RuntimeCrossing | undefined {
  const call = context.openappaRuntimeCall;
  if (!call?.session.session_id || !call.toolCallId) return undefined;
  return {
    source: call.session,
    callId: call.toolCallId,
    spawn: call.spawn,
  };
}

/**
 * A call without a proof comes from a client whose model requests did not pass
 * the proxy. The organization's setting for unrecognized clients decides it
 * here as it does there: such a caller has no session to bind, so it may only
 * open and use runtimes that have no parent (see `refuseUnrecognizedCaller`).
 */
export async function guardRuntimeCrossing(
  context: Pick<ArchestraContext, "openappaRuntimeCall">,
): Promise<
  | { kind: "inactive" }
  | { kind: "proof"; crossing: RuntimeCrossing }
  | { kind: "unrecognized" }
  | { kind: "refused"; reason: string }
> {
  if (!(await isGuardrailsV2Active())) return { kind: "inactive" };
  const crossing = crossingFromContext(context);
  if (crossing) return { kind: "proof", crossing };
  const { unsupportedClientAction } = await getGuardrailsDeployment();
  if (unsupportedClientAction === "block") {
    return {
      kind: "refused",
      reason:
        "Guardrails do not recognize this client, so the request was not sent. Send the client's model requests through the LLM Proxy, or ask an administrator to allow unrecognized clients.",
    };
  }
  return { kind: "unrecognized" };
}

/**
 * A runtime bound to a parent answers only to that parent's proof. Returns the
 * refusal for a caller without one, or undefined when the runtime has no
 * parent. A runtime whose session cannot be resolved is refused, not assumed
 * to be unbound. Without a proof the gateway cannot tell the parent from a
 * stranger, so the refusal names the missing proof, not a different session.
 */
export async function refuseUnrecognizedCaller(params: {
  organizationId: string;
  workspaceId: string | undefined;
}): Promise<string | undefined> {
  const resolved = params.workspaceId
    ? await resolveRuntimeSessionForWorkspace({
        organizationId: params.organizationId,
        workspaceId: params.workspaceId,
      })
    : null;
  if (!resolved) return UNVERIFIED_RUNTIME_SESSION;
  return resolved.session.parent_id
    ? UNPROVEN_CALLER_ON_BOUND_RUNTIME
    : undefined;
}

export function promptWithContract(
  task: string | null | undefined,
  contract: string | undefined,
): string | null | undefined {
  if (!contract) return task;
  if (!task) return contract;
  return `${contract}\n\n${task}`;
}

export function crossingRefusal(error: unknown): string | undefined {
  return error instanceof RuntimeCrossingRefusal ? error.message : undefined;
}

/** Binds a new same-family child. Refusal throws before any process starts. */
export async function bindRuntimeChild(params: {
  crossing: RuntimeCrossing;
  organizationId: string;
  workspaceId: string;
  workloadName: string;
  actorKind: AgentRunActorKind;
  actorId: string;
}): Promise<string | undefined> {
  if (params.crossing.source.organization_id !== params.organizationId) {
    throw new RuntimeCrossingRefusal(
      "The source belongs to another organization.",
    );
  }
  if (!params.crossing.spawn) {
    throw new RuntimeCrossingRefusal(
      "This start was not classified as a protected spawn. No runtime was started.",
    );
  }
  const session = runtimeOpenAppaSession({
    organizationId: params.organizationId,
    workspaceId: params.workspaceId,
    workloadName: params.workloadName,
    actorKind: params.actorKind,
    actorId: params.actorId,
    parentId: params.crossing.source.session_id,
  });
  try {
    const bound = await startRuntimeChild({
      session,
      spawnCallId: params.crossing.callId,
    });
    return bound.contract;
  } catch (error) {
    if (error instanceof RuntimeCrossingRefusal) throw error;
    if (error instanceof ApiError) {
      throw new RuntimeCrossingRefusal(
        "The protected runtime could not be bound. No input was delivered; inspect the guardrail decision before requesting a new launch.",
      );
    }
    throw error;
  }
}

/**
 * Joins the current parent label into a registered child.
 * Callers must not inject message or file bytes until this resolves.
 */
export async function admitRuntimeSteer(params: {
  crossing: RuntimeCrossing;
  organizationId: string;
  workspaceId: string;
}): Promise<OpenAppaSession> {
  const relation = await classifyRuntimeCaller(params);
  if (relation.kind === "refused") {
    throw new RuntimeCrossingRefusal(relation.reason);
  }
  if (relation.kind === "producer") return relation.child;
  try {
    await addressRuntimeChild({
      session: params.crossing.source,
      childSessionId: relation.child.session_id,
      operationId: params.crossing.callId,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      throw new RuntimeCrossingRefusal(error.message);
    }
    throw error;
  }
  return relation.child;
}

export async function classifyRuntimeCaller(params: {
  crossing: RuntimeCrossing;
  organizationId: string;
  workspaceId: string;
}): Promise<
  | { kind: "producer"; child: OpenAppaSession }
  | { kind: "parent"; child: OpenAppaSession }
  | { kind: "refused"; reason: string }
> {
  if (params.crossing.source.organization_id !== params.organizationId) {
    return {
      kind: "refused",
      reason: "The source belongs to another organization.",
    };
  }
  const resolved = await resolveRuntimeSessionForWorkspace({
    organizationId: params.organizationId,
    workspaceId: params.workspaceId,
  });
  if (!resolved) {
    return { kind: "refused", reason: UNVERIFIED_RUNTIME_SESSION };
  }
  if (
    params.crossing.source.session_id === resolved.session.session_id &&
    params.crossing.source.caller_id === resolved.session.caller_id
  ) {
    return { kind: "producer", child: resolved.session };
  }
  if (!resolved.session.parent_id) {
    return {
      kind: "refused",
      reason:
        "This runtime was opened without a parent. Its raw result was not returned.",
    };
  }
  if (resolved.session.parent_id !== params.crossing.source.session_id) {
    return { kind: "refused", reason: BOUND_TO_ANOTHER_SESSION };
  }
  return { kind: "parent", child: resolved.session };
}

export async function crossRuntimeOutput(params: {
  crossing: RuntimeCrossing;
  organizationId: string;
  workspaceId: string;
  taskId: string;
}): Promise<
  | { kind: "producer" }
  | { kind: "admitted"; value: string }
  | { kind: "withheld"; reason: string }
  | { kind: "refused"; reason: string }
> {
  const relation = await classifyRuntimeCaller(params);
  if (relation.kind === "refused") return relation;
  if (relation.kind === "producer") return { kind: "producer" };
  const prefix = `runtime-return:${params.taskId}:`;
  const records = await loadChildReturns({
    organizationId: params.organizationId,
    parentSessionId: params.crossing.source.session_id,
    childSessionId: relation.child.session_id,
    operationPrefix: prefix,
  });
  const matches = records.filter(
    (record) =>
      record.childSessionId === relation.child.session_id &&
      record.operationId?.startsWith(prefix),
  );
  // Native lookup is newest-first and returns the latest matching admitted row.
  const last = matches[0];
  if (!last) {
    return {
      kind: "withheld",
      reason:
        "This turn has no admitted result yet. The raw output was not returned.",
    };
  }
  if (last.value.length > RUNTIME_OUTPUT_INLINE_LIMIT) {
    return {
      kind: "withheld",
      reason:
        "The admitted result is too large to inline. It was not truncated.",
    };
  }
  return { kind: "admitted", value: last.value };
}

/**
 * Crosses exact file bytes. Held or unavailable does not release the original.
 * The ruling travels with the refusal: it is the same model-facing text a
 * blocked tool call gets, and it carries the remedy offers the caller can act on.
 */
export async function crossRuntimeFile(params: {
  child: OpenAppaSession;
  operationId: string;
  value: string;
}): Promise<string> {
  const result = await returnRuntimeValue({
    session: params.child,
    operationId: params.operationId,
    value: params.value,
  });
  if (result.kind !== "admitted") {
    throw new RuntimeCrossingRefusal(heldFileRefusal(result.reason));
  }
  return result.value;
}

/** Shared with protected transfers so both file paths explain a hold the same way. */
export function heldFileRefusal(reason: string): string {
  return `The protected file could not be admitted. No original bytes were returned.\n\nGuardrails ruling: ${reason}`;
}

const UNVERIFIED_RUNTIME_SESSION =
  "This runtime session could not be verified. The request was refused.";

const BOUND_TO_ANOTHER_SESSION =
  "This runtime is bound to a different session. The request was refused.";

const UNPROVEN_CALLER_ON_BOUND_RUNTIME =
  "This runtime is bound to a Guardrails session, and this call carried no proof of its source. The request was refused. Retry from the conversation that started the run, with its model requests going through the LLM Proxy.";
