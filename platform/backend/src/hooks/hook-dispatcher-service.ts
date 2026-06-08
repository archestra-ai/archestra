import config from "@/config";
import { HookFileModel, SkillSandboxModel } from "@/models";
import { SKILL_SANDBOX_HOME } from "@/skills-sandbox/runtime-image";
import type { HookEvent } from "@/types/hook";
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
}

class HookDispatcherService {
  get isEnabled(): boolean {
    return config.skillsSandbox.enabled;
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
    if (!this.isEnabled) return { decision: "proceed" };

    const enabled = await HookFileModel.listEnabledByAgent(
      params.agentId,
      params.organizationId,
    );
    const scripts = enabled.filter((h) => h.event === params.event);
    if (scripts.length === 0) return { decision: "proceed" };

    const sandbox = await SkillSandboxModel.findOrCreateDefault({
      organizationId: params.organizationId,
      userId: params.userId,
      conversationId: params.conversationId,
      defaultCwd: SKILL_SANDBOX_HOME,
    });

    const payload = {
      ...params.fields,
      session_id: params.conversationId,
      cwd: SKILL_SANDBOX_HOME,
      permission_mode: "default",
      hook_event_name: HOOK_EVENT_NAMES[params.event],
    };

    const injected: string[] = [];
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
      if (r.outcome === "blocked") {
        return {
          decision: "block",
          reason: r.stderr.trim() || "Blocked by hook",
        };
      }
      if (r.outcome === "proceeded" && r.stdout.trim()) {
        injected.push(r.stdout.trim());
      }
    }

    return {
      decision: "proceed",
      injectedContext: injected.length ? injected.join("\n") : undefined,
    };
  }
}

export const hookDispatcherService = new HookDispatcherService();

// === internal ===

/** Claude Code `hook_event_name` values — kept identical so customer scripts port. */
const HOOK_EVENT_NAMES: Record<HookEvent, string> = {
  session_start: "SessionStart",
  user_prompt_submit: "UserPromptSubmit",
  pre_tool_use: "PreToolUse",
  post_tool_use: "PostToolUse",
  stop: "Stop",
};
