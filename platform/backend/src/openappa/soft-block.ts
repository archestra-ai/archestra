import { AsyncLocalStorage } from "node:async_hooks";
import { TimeInMs } from "@archestra/shared";
import { LRUCacheManager } from "@/cache-manager";
import config from "@/config";
import logger from "@/logging";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import OpenAppaYellModel from "@/models/openappa-yell";
import { registerProcessLocalCache } from "@/process-local-cache-registry";
import type { UnapprovableBlockMode } from "@/types/guardrails-policy";
import type { OpenAppaSession } from "./service";
import { isUnenforcedSession, superyellSession } from "./unenforced";

/**
 * Carries a refusal to the host boundary that still owns the original bytes.
 * Never manufacture an engine admission: after recording the waiver the host
 * releases those bytes outside enforcement instead.
 */
class SoftBlockRefusal extends Error {
  constructor(
    message: string,
    readonly tools: string[] = [],
  ) {
    super(message);
  }
}

/** Preserve the native cause for diagnostics without recording URL credentials. */
export function softBlockReason(error: Error): string {
  const messages: string[] = [];
  const seen = new Set<Error>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current) && seen.size < 8) {
    seen.add(current);
    if (!messages.includes(current.message)) messages.push(current.message);
    current = current.cause;
  }
  return messages.join("\nCaused by: ").replace(/\/\/[^/\s@]+@/g, "//");
}

export function softBlockTools(error: Error): string[] {
  return error instanceof SoftBlockRefusal ? error.tools : [];
}

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
const requestSettings = new AsyncLocalStorage<{
  mode?: UnapprovableBlockMode;
}>();

/** Isolate the proxy's captured setting from other requests and MCP calls. */
export function withSoftBlockRequest<T>(run: () => Promise<T>): Promise<T> {
  return requestSettings.run({}, run);
}

/** Use the deployment snapshot already read for this proxy request. */
export function captureSoftBlockMode(mode: UnapprovableBlockMode): void {
  const settings = requestSettings.getStore();
  if (settings) settings.mode = mode;
}

export async function softBlocksAllowed(): Promise<boolean> {
  const override =
    config.openappa.breakTheGlassOverrides?.unapprovableBlockMode;
  if (override !== undefined) return override === "allow";
  const captured = requestSettings.getStore()?.mode;
  if (captured !== undefined) return captured === "allow";
  return (
    (await GuardrailsDeploymentModel.get()).unapprovableBlockMode === "allow"
  );
}
// SPDX-SnippetEnd

export function isHardBlock(message: string): boolean {
  return /requires attention: [^\n]*\b(?:blocked|hard-block)\b/.test(message);
}

/** Called only at a governed boundary, after platform authentication. */
export async function waiveSoftBlock(
  session: OpenAppaSession,
  boundary: string,
  reason: string,
  tools: readonly string[] = [],
): Promise<boolean> {
  if (!(await softBlocksAllowed()) || isHardBlock(reason)) return false;
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
  rememberSoftBlockWaiver(session);
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
        tool: tools.length ? [...new Set(tools)].join(", ") : boundary,
        message: [
          `Affected tools: ${tools.length ? [...new Set(tools)].join(", ") : "Not attributed (session operation)"}.`,
          `Original refusal:\n${reason}`,
          `Result: The effective Other blocked calls setting (allow) turned Guardrails enforcement off for session ${session.session_id}. Subsequent operations in this session bypass Guardrails.`,
          `Technical boundary: ${boundary}.`,
        ].join("\n\n"),
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
export async function refuseSoftBlock(
  reason: string,
  tools: string[] = [],
): Promise<void> {
  if ((await softBlocksAllowed()) && !isHardBlock(reason))
    throw new SoftBlockRefusal(reason, tools);
}

/** Process-local fallback when the durable bypass store is unavailable. */
export function rememberSoftBlockWaiver(session: OpenAppaSession): void {
  waived.set(`${session.organization_id}:${session.session_id}`, true);
}

/** Reads only the session and its bound immediate parent or fork source. */
export async function softBlockWaivedLocally(
  session: OpenAppaSession,
): Promise<boolean> {
  return (
    (await softBlocksAllowed()) &&
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
