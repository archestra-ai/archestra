import { randomUUID } from "node:crypto";
import type { Transaction } from "@/database";
import type { ClusterLeaseGuard } from "@/models/mcp-deployment-lease";
import McpServerModel from "@/models/mcp-server";
import { broadcastMcpInstallationStatus } from "@/websocket";

export const HARD_RESET_STATUS_MARKER_PREFIX = "archestra:hard-reset:";

type HardResetStatusMarker = {
  operationId: string;
  physicalDeployment: string;
  startedAtMs: number;
  /** null means the Deployment was already absent; undefined is a legacy marker. */
  originalDeploymentUid?: string | null;
  /** Present only after this reset has verifiably removed the old workload. */
  phase?: "teardown-complete";
};

/** Create persisted identity for one hard reset's pending/final status writes. */
export function createHardResetStatusMarker(params: {
  physicalDeployment: string;
  originalDeploymentUid?: string | null;
}): string {
  return `${HARD_RESET_STATUS_MARKER_PREFIX}${JSON.stringify({
    operationId: randomUUID(),
    physicalDeployment: params.physicalDeployment,
    startedAtMs: Date.now(),
    originalDeploymentUid: params.originalDeploymentUid,
  } satisfies HardResetStatusMarker)}`;
}

/** Parse only markers written by {@link createHardResetStatusMarker}. */
export function parseHardResetStatusMarker(
  value: string | null,
): HardResetStatusMarker | null {
  if (!value?.startsWith(HARD_RESET_STATUS_MARKER_PREFIX)) return null;
  try {
    const parsed = JSON.parse(
      value.slice(HARD_RESET_STATUS_MARKER_PREFIX.length),
    ) as Partial<HardResetStatusMarker>;
    if (
      typeof parsed.operationId !== "string" ||
      typeof parsed.physicalDeployment !== "string" ||
      typeof parsed.startedAtMs !== "number" ||
      !Number.isFinite(parsed.startedAtMs) ||
      (parsed.originalDeploymentUid !== undefined &&
        parsed.originalDeploymentUid !== null &&
        typeof parsed.originalDeploymentUid !== "string") ||
      (parsed.phase !== undefined && parsed.phase !== "teardown-complete")
    ) {
      return null;
    }
    return parsed as HardResetStatusMarker;
  } catch {
    return null;
  }
}

/** Advance a pending marker only after its old workload is verifiably gone. */
export function markHardResetTeardownComplete(value: string): string {
  const marker = parseHardResetStatusMarker(value);
  if (!marker) throw new Error("Cannot advance an invalid hard-reset marker");
  return `${HARD_RESET_STATUS_MARKER_PREFIX}${JSON.stringify({
    ...marker,
    phase: "teardown-complete",
  } satisfies HardResetStatusMarker)}`;
}

/**
 * Atomically update one reset's sibling installs, retrying transient database
 * failures and broadcasting only rows still owned by this operation marker.
 */
export async function writeHardResetStatuses(params: {
  mcpServerIds: string[];
  status: "pending" | "success" | "error";
  error: string | null;
  expectedMarker?: string;
  runFencedMutation?: ClusterLeaseGuard["runFencedMutation"];
}): Promise<string[]> {
  let lastError: unknown;
  for (
    let attempt = 1;
    attempt <= HARD_RESET_STATUS_WRITE_ATTEMPTS;
    attempt++
  ) {
    try {
      const update = (tx?: Transaction) =>
        McpServerModel.updateInstallationStatuses({
          ids: params.mcpServerIds,
          status: params.status,
          error: params.error,
          expected: params.expectedMarker
            ? { status: "pending", error: params.expectedMarker }
            : undefined,
          tx,
        });
      const updatedIds = params.runFencedMutation
        ? await params.runFencedMutation(update)
        : await update();
      for (const mcpServerId of updatedIds) {
        broadcastMcpInstallationStatus(
          mcpServerId,
          params.status,
          params.error,
        );
      }
      return updatedIds;
    } catch (error) {
      lastError = error;
      if (attempt < HARD_RESET_STATUS_WRITE_ATTEMPTS) {
        await new Promise((resolve) =>
          setTimeout(resolve, HARD_RESET_STATUS_RETRY_MS * attempt),
        );
      }
    }
  }
  throw lastError;
}

const HARD_RESET_STATUS_WRITE_ATTEMPTS = 5;
const HARD_RESET_STATUS_RETRY_MS = 250;
