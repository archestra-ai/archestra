import { TimeInMs } from "@archestra/shared";
import { LRUCacheManager } from "@/cache-manager";
import config from "@/config";
import logger from "@/logging";
import OpenAppaYellModel from "@/models/openappa-yell";
import { registerProcessLocalCache } from "@/process-local-cache-registry";
import type { OpenAppaSession } from "./service";
import { isUnenforcedSession, superyellSession } from "./unenforced";

/**
 * Carries a refusal to the host boundary that still owns the original bytes.
 * Never manufacture an engine admission: after recording the waiver the host
 * releases those bytes outside enforcement instead.
 */
class SoftBlockRefusal extends Error {}

export function softBlocksAllowed(): boolean {
  return config.openappa.softBlockMode === "allow";
}

export function isHardBlock(message: string): boolean {
  return /requires attention: [^\n]*\b(?:blocked|hard-block)\b/.test(message);
}

/** Called only at a governed boundary, after platform authentication. */
export async function waiveSoftBlock(
  session: OpenAppaSession,
  boundary: string,
  reason: string,
): Promise<boolean> {
  if (!softBlocksAllowed() || isHardBlock(reason)) return false;
  // A failed diagnostics write must never veto the operator's waiver.
  // Remember locally before I/O; other replicas retry the same idempotent
  // bypass write at their own refusal boundary if storage is unavailable.
  const key = `${session.organization_id}:${session.session_id}`;
  if (waived.get(key)) return true;
  try {
    if (await isUnenforcedSession(session)) return true;
  } catch (error) {
    logger.warn({ err: error }, "Could not read the soft-block session bypass");
  }
  waived.set(key, true);
  try {
    await superyellSession(session);
  } catch (error) {
    logger.warn(
      { err: error },
      "Could not persist the soft-block session bypass; the current request remains waived",
    );
  }
  if (config.openappa.yellEnabled) {
    try {
      await OpenAppaYellModel.recordWaiver({
        organizationId: session.organization_id,
        callerId: session.caller_id ?? session.session_id,
        sessionId: session.session_id,
        kind: "block_waived",
        tool: boundary,
        message: `Guardrails waived ${boundary} under ARCHESTRA_OPENAPPA_SOFT_BLOCK_MODE=allow and turned enforcement off for this session.`,
        superyell: true,
      });
    } catch (error) {
      logger.warn(
        { err: error },
        "Could not record the soft-block waiver yell; enforcement remains off",
      );
    }
  }
  return true;
}

/** Raise before a host replaces or discards the original value. */
export function refuseSoftBlock(reason: string): void {
  if (softBlocksAllowed() && !isHardBlock(reason))
    throw new SoftBlockRefusal(reason);
}

/** Process-local fallback when the durable bypass store is unavailable. */
export function softBlockWaivedLocally(session: OpenAppaSession): boolean {
  return (
    softBlocksAllowed() &&
    [session.session_id, session.parent_id, session.fork_of].some(
      (id) =>
        id !== undefined &&
        waived.get(`${session.organization_id}:${id}`) === true,
    )
  );
}

const waived = registerProcessLocalCache(
  new LRUCacheManager<boolean>({ maxSize: 10000, defaultTtl: TimeInMs.Day }),
);
