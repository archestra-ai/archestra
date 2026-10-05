import type { ArchestraContext } from "@/archestra-mcp-server/types";
import type { OpenAppaSession } from "@/openappa/service";
import {
  addressRuntimeChild,
  loadChildReturns,
  returnRuntimeValue,
  startRuntimeChild,
} from "@/openappa/service";
import { isGuardrailsV2Active } from "@/services/guardrails-deployment";
import type { AgentRunActorKind } from "@/types";
import { ApiError } from "@/types";
import {
  resolveRuntimeSessionForWorkspace,
  runtimeOpenAppaSession,
} from "./runtime-identity";

/** Inlined governed output above this is withheld whole, never sliced. */
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

export async function guardRuntimeCrossing(
  context: Pick<ArchestraContext, "openappaRuntimeCall">,
): Promise<
  | { kind: "inactive" }
  | { kind: "proof"; crossing: RuntimeCrossing }
  | { kind: "refused"; reason: string }
> {
  if (!(await isGuardrailsV2Active())) return { kind: "inactive" };
  const crossing = crossingFromContext(context);
  if (!crossing) {
    return {
      kind: "refused",
      reason:
        "This runtime crossing has no verified source. The request was not sent.",
    };
  }
  return { kind: "proof", crossing };
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
      throw new RuntimeCrossingRefusal(error.message);
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
    return {
      kind: "refused",
      reason:
        "This runtime session could not be verified. The request was refused.",
    };
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
    return {
      kind: "refused",
      reason:
        "This runtime is bound to a different session. The request was refused.",
    };
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
  const records = await loadChildReturns({
    organizationId: params.organizationId,
    parentSessionId: params.crossing.source.session_id,
  });
  const prefix = `runtime-return:${params.taskId}:`;
  const matches = records.filter(
    (record) =>
      record.childSessionId === relation.child.session_id &&
      record.operationId?.startsWith(prefix),
  );
  const last = matches.at(-1);
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

/** Crosses exact file bytes. Held or unavailable does not release the original. */
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
    throw new RuntimeCrossingRefusal(result.reason);
  }
  return result.value;
}
