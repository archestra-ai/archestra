import config from "@/config";
import { HookFileModel, SkillSandboxModel } from "@/models";
import { SKILL_SANDBOX_HOME } from "@/skills-sandbox/runtime-image";
import type { HookEvent } from "@/types/hook";
import type { HookRunDetail } from "./hook-run-parts";
import { runHookScript } from "./hook-runner";

/** @public — consumed by the chat route + MCP client wiring (Task 8). */
export interface FireParams {
  event: HookEvent;
  conversationId: string;
  agentId: string;
  organizationId: string;
  userId: string;
  /** Event-specific payload fields, e.g. { prompt } or { tool_name, tool_input }. */
  fields: Record<string, unknown>;
}

/** @public — consumed by the chat route + MCP client wiring (Task 8). */
export interface FireResult {
  decision: "proceed" | "block";
  reason?: string;
  injectedContext?: string;
  /**
   * One entry per hook script that actually ran, in execution order (a block
   * stops the loop, so later scripts are absent). `fire()` always populates it;
   * optional only so existing stubs that predate it still type-check. The chat
   * layer turns these into inline `data-hook-run` entries; others ignore it.
   */
  runs?: HookRunDetail[];
}

class HookDispatcherService {
  get isEnabled(): boolean {
    // `config.hooks.enabled` already folds in the agent-runtime requirement
    // (hooks run in the conversation sandbox), so this is the single gate.
    return config.hooks.enabled;
  }

  /**
   * Fire one lifecycle event's hooks against the conversation's default sandbox.
   *
   * Mirrors the run_command tool handler: resolve the default sandbox via
   * `findOrCreateDefault`, then run each hook script via `runHookScript`.
   * Cheap no-op when the agent has no matching hooks. Runner fails open —
   * errors and timeouts map to outcome "error" → proceed.
   *
   * Scripts run in fileName order (the order `listEnabledByAgent` returns).
   * First "blocked" outcome short-circuits; remaining hooks are not run.
   */
  async fire(params: FireParams): Promise<FireResult> {
    if (!this.isEnabled) return { decision: "proceed", runs: [] };

    const enabled = await HookFileModel.listEnabledByAgent(
      params.agentId,
      params.organizationId,
    );
    const scripts = enabled.filter((h) => h.event === params.event);
    if (scripts.length === 0) return { decision: "proceed", runs: [] };

    const sandbox = await SkillSandboxModel.findOrCreateDefault({
      organizationId: params.organizationId,
      userId: params.userId,
      conversationId: params.conversationId,
      defaultCwd: SKILL_SANDBOX_HOME,
    });

    const hookEventName = HOOK_EVENT_NAMES[params.event];

    const payload = {
      ...params.fields,
      session_id: params.conversationId,
      cwd: SKILL_SANDBOX_HOME,
      permission_mode: "default",
      hook_event_name: hookEventName,
    };

    const injected: string[] = [];
    // One detail per script that actually ran, in execution order; surfaced as
    // inline `data-hook-run` entries by the chat layer.
    const runs: HookRunDetail[] = [];
    for (const hookFile of scripts) {
      const r = await runHookScript({
        sandboxId: sandbox.id,
        caller: {
          userId: params.userId,
          organizationId: params.organizationId,
        },
        hookFile,
        payload,
      });
      runs.push({
        hookEventName,
        fileName: hookFile.fileName,
        outcome: r.outcome,
        exitCode: r.exitCode,
        stdout: r.stdout,
        stderr: r.stderr,
        durationMs: r.durationMs,
        payload,
      });
      if (r.outcome === "blocked") {
        return {
          decision: "block",
          reason: r.stderr.trim() || "Blocked by hook",
          runs,
        };
      }
      if (r.outcome === "proceeded" && r.stdout.trim()) {
        injected.push(r.stdout.trim());
      }
    }

    return {
      decision: "proceed",
      injectedContext: injected.length ? injected.join("\n") : undefined,
      runs,
    };
  }
}

export const hookDispatcherService = new HookDispatcherService();

// === internal ===

/** Claude Code `hook_event_name` values — kept identical so customer scripts port. */
const HOOK_EVENT_NAMES: Record<HookEvent, string> = {
  session_start: "SessionStart",
  pre_tool_use: "PreToolUse",
  post_tool_use: "PostToolUse",
};
