import { createHash, randomUUID } from "node:crypto";
import logger from "@/logging";
import { skillSandboxRuntimeService } from "@/skills-sandbox/skill-sandbox-runtime-service";
import type { HookFile, HookOutcome } from "@/types/hook";
import { asSandboxId } from "@/types/skill-sandbox";

interface HookRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  outcome: HookOutcome;
}

/**
 * Run a single hook script inside a sandbox.
 *
 * The script and payload are uploaded as durable replay events via
 * `uploadFile`, then executed via `runCommand` — all three events append to
 * the replay log so the hook script, its payload, and its filesystem effects
 * persist and replay exactly like `upload_file` + `run_command` tool calls.
 *
 * Script path is namespaced by hook id to avoid collisions when two hooks
 * share the same fileName across events.  Payload path is further unique per
 * fire (randomUUID) so concurrent fires for the same hook on parallel tool
 * calls don't race on the payload file.
 *
 * Never throws: runtime failures map to outcome "error" (fail open).
 *
 * The script upload uses a content-addressed `dedupeId` so the same
 * (sandbox, hook, content) triple uploads the script exactly once; subsequent
 * fires are no-ops for the script row.  The payload upload is unique per fire
 * (no dedupeId) because it changes on every invocation.
 *
 * Exit-code contract: 2 → blocked, 0 → proceeded, timeout → timeout,
 * anything else → error.
 */
export async function runHookScript(params: {
  sandboxId: string;
  caller: { userId: string; organizationId: string };
  hookFile: HookFile;
  payload: Record<string, unknown>;
}): Promise<HookRunResult> {
  const { sandboxId, caller, hookFile, payload } = params;
  const startedAt = Date.now();
  try {
    const dir = `/home/sandbox/hooks/${hookFile.id}`;
    const scriptPath = `${dir}/${hookFile.fileName}`;
    const payloadPath = `${dir}/payload-${randomUUID()}.json`;

    await skillSandboxRuntimeService.uploadFile({
      sandboxId: asSandboxId(sandboxId),
      path: scriptPath,
      data: Buffer.from(hookFile.content, "utf8"),
      // content-addressed dedup id: stable per (path, content), changes when
      // the user edits the hook, so the script uploads once per
      // (sandbox, hook, content) and is a no-op on subsequent fires.
      dedupeId: deterministicUuid(`${scriptPath}\0${hookFile.content}`),
    });

    await skillSandboxRuntimeService.uploadFile({
      sandboxId: asSandboxId(sandboxId),
      path: payloadPath,
      data: Buffer.from(JSON.stringify(payload), "utf8"),
    });

    const executed = await skillSandboxRuntimeService.runCommand({
      sandboxId: asSandboxId(sandboxId),
      caller,
      command: buildExecCommand(hookFile, scriptPath, payloadPath),
      timeoutSeconds: HOOK_TIMEOUT_SECONDS,
    });

    return {
      exitCode: executed.exitCode,
      stdout: executed.stdout,
      stderr: executed.stderr,
      durationMs: executed.durationMs,
      outcome: executed.timedOut
        ? "timeout"
        : executed.exitCode === 2
          ? "blocked"
          : executed.exitCode === 0
            ? "proceeded"
            : "error",
    };
  } catch (error) {
    logger.warn(
      { err: error, hookFileId: hookFile.id },
      "[Hooks] sandbox run failed — failing open",
    );
    return {
      exitCode: null,
      stdout: "",
      stderr: "",
      durationMs: Date.now() - startedAt,
      outcome: "error",
    };
  }
}

// === internal ===

/** Hooks are expected to be short-lived; a generous upper bound, not a knob. */
const HOOK_TIMEOUT_SECONDS = 30;

/**
 * Derive a deterministic UUID v5-style from an arbitrary string input.
 * sha256 the input, take the first 16 bytes, stamp version=5 and the RFC 4122
 * variant bits, format as a hyphenated hex string. No external package needed.
 */
function deterministicUuid(input: string): string {
  const b = createHash("sha256").update(input).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // variant
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Build the small exec command that runs an already-uploaded script with an
 * already-uploaded payload on stdin.  Paths are single-quoted via `shQuote`.
 * No base64, no mkdir — the files are already in place from `uploadFile`.
 */
function buildExecCommand(
  hookFile: HookFile,
  scriptPath: string,
  payloadPath: string,
): string {
  if (hookFile.fileName.endsWith(".py")) {
    const withs = hookFile.requirements
      .map((r) => `--with ${shQuote(r)}`)
      .join(" ");
    const prefix = withs ? `uv run ${withs} python3` : "python3";
    return `${prefix} ${shQuote(scriptPath)} < ${shQuote(payloadPath)}`;
  }
  return `sh ${shQuote(scriptPath)} < ${shQuote(payloadPath)}`;
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
