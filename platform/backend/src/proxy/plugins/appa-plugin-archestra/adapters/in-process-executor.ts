import { isAgentTool, isSkillTool } from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { childSessionId } from "@/openappa/actor";
import {
  type AppaChildTrajectoryReceipt,
  verifyChildTrajectoryReceipt,
} from "@/openappa/child-trajectory-receipt";
import {
  type AppaDelegationMarker,
  verifyDelegatedPrompt,
} from "@/openappa/delegation";
import { ApiError } from "@/types";
import type {
  AppaChildTrajectory,
  AppaClientAdapter,
  AppaMatchContext,
} from "../types";
import { withoutCallerScope } from "../utils";
import { bindMintedChildTrajectory } from "./trajectory";

/**
 * In-process `agent__` / `skill__` delegation. Coding clients keep first
 * match. This adapter covers adapter-less loopback executors (ChatOps, email,
 * schedule, A2A) after the proxy has authenticated the session. Chat grows
 * the same spawn/bind case on its own adapter so it is not stolen.
 */
export class AppaInProcessExecutorAdapter implements AppaClientAdapter {
  readonly id = "archestra-executor";
  readonly trajectoryPrefix = "executor";

  matches(context: AppaMatchContext): boolean {
    return (
      context.trustedContext?.inProcessExecutor === true &&
      context.trustedContext.chatSource === undefined
    );
  }

  classifyToolName(name: string, _namespace?: string): "gateway" | "local" {
    return archestraMcpBranding.isToolName(name) ? "gateway" : "local";
  }

  normalizeLocalToolName(name: string): string {
    return name;
  }

  isSpawnTool(name: string, _namespace?: string): boolean {
    return isInProcessDelegationTool(name);
  }

  spawnPromptField(name: string, _args: Record<string, unknown>) {
    return inProcessSpawnPromptField(name);
  }

  nativeConversationId(context: AppaMatchContext): string | undefined {
    return inProcessSpawnerNativeId(context);
  }

  namesChildren(): [] {
    return [];
  }

  bindChildTrajectory(
    context: AppaMatchContext,
  ): AppaChildTrajectory | undefined {
    return bindInProcessChild(context);
  }

  stripCarrierMetadata<T>(value: T): T {
    return value;
  }
}

export function isInProcessDelegationTool(name: string): boolean {
  return isAgentTool(name) || isSkillTool(name);
}

export function inProcessSpawnPromptField(
  name: string,
): { field: "message"; kind: "text" } | undefined {
  return isInProcessDelegationTool(name)
    ? { field: "message", kind: "text" }
    : undefined;
}

function inProcessSpawnerNativeId(
  context: AppaMatchContext,
): string | undefined {
  const session = context.trustedContext?.session;
  if (!session) return undefined;
  return withoutCallerScope(session, session.session_id);
}

/**
 * Binds a child from a verified marker or receipt. The parent claim is only a
 * candidate for the HMAC; a claim without that proof is not a child.
 * Header-only identity is refused. No trusted context is not a child request.
 */
export function bindInProcessChild(
  context: AppaMatchContext,
): AppaChildTrajectory | undefined {
  const trusted = context.trustedContext;
  if (!trusted?.claims?.parentId) return undefined;
  const child = bindMintedChildTrajectory({
    context,
    parentNativeId: trusted.claims.parentId,
    childNativeId: undefined,
  });
  if (
    !child ||
    child.lineage?.source === "native" ||
    !child.lineage?.spawnCallId
  ) {
    throw new ApiError(
      400,
      "OpenAPPA cannot bind a delegated child without a verified spawn marker",
    );
  }
  return child;
}

/**
 * Proof a loopback nested run may open a child session. Client session and
 * parent headers are claims: a contradiction is refused, and a missing proof
 * is refused. The returned ids are what the proxy must bind, not the headers.
 */
export function requireDelegatedChildSession(params: {
  organizationId: string;
  callerId: string | undefined;
  markers: readonly AppaDelegationMarker[];
  receipts: readonly AppaChildTrajectoryReceipt[];
  claimedSessionId?: string;
  claimedParentId?: string;
}): { sessionId: string; parentId: string } {
  for (const receipt of params.receipts) {
    if (!receipt.spawnCallId) continue;
    if (
      !verifyChildTrajectoryReceipt({
        receipt,
        organizationId: params.organizationId,
        callerId: params.callerId,
        spawnerNativeId: receipt.spawnerNativeId,
      })
    ) {
      continue;
    }
    return assertChildClaims({
      sessionId: receipt.childId,
      parentId: receipt.parentId,
      claimedSessionId: params.claimedSessionId,
      claimedParentId: params.claimedParentId,
    });
  }
  for (const marker of params.markers) {
    if (!marker.spawnCallId) continue;
    if (
      !verifyDelegatedPrompt({
        marker,
        organizationId: params.organizationId,
        callerId: params.callerId,
        spawnerNativeId: marker.parentId,
      })
    ) {
      continue;
    }
    return assertChildClaims({
      sessionId: childSessionId(marker.parentId, marker.spawnCallId),
      parentId: marker.parentId,
      claimedSessionId: params.claimedSessionId,
      claimedParentId: params.claimedParentId,
    });
  }
  throw new ApiError(
    400,
    "OpenAPPA cannot bind a delegated run without a verified spawn marker",
  );
}

function assertChildClaims(params: {
  sessionId: string;
  parentId: string;
  claimedSessionId?: string;
  claimedParentId?: string;
}): { sessionId: string; parentId: string } {
  if (
    (params.claimedSessionId !== undefined &&
      params.claimedSessionId !== params.sessionId) ||
    (params.claimedParentId !== undefined &&
      params.claimedParentId !== params.parentId)
  ) {
    throw new ApiError(
      400,
      "OpenAPPA child session claims do not match the verified spawn marker",
    );
  }
  return { sessionId: params.sessionId, parentId: params.parentId };
}
