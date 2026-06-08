import config from "@/config";
import logger from "@/logging";
import { HookFileModel, MessageModel, SkillSandboxModel } from "@/models";
import { SKILL_SANDBOX_HOME } from "@/skills-sandbox/runtime-image";
import { skillSandboxRuntimeService } from "@/skills-sandbox/skill-sandbox-runtime-service";
import type { ChatMessage } from "@/types";
import type { HookEvent } from "@/types/hook";
import { asSandboxId } from "@/types/skill-sandbox";
import { messagesToClaudeTranscript } from "./claude-transcript";
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
  /**
   * In-flight conversation used to materialize the Claude-format transcript
   * exposed to scripts as `transcript_path`. When omitted, the dispatcher loads
   * persisted history from the DB. The chat route passes the request messages
   * (history + current prompt) for prompt/session events and the final messages
   * for Stop.
   */
  messages?: ChatMessage[];
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

    // Best-effort: materialize a Claude-format transcript into the sandbox so
    // scripts can read it via `transcript_path`. A failure here must never block
    // hook execution, so it is caught and the path is simply omitted.
    let transcriptPath: string | undefined;
    try {
      transcriptPath = await writeTranscript(params, sandbox.id);
    } catch (error) {
      logger.warn(
        { err: error, conversationId: params.conversationId },
        "[Hooks] transcript write failed — proceeding without transcript_path",
      );
    }

    const payload = {
      ...params.fields,
      session_id: params.conversationId,
      cwd: SKILL_SANDBOX_HOME,
      permission_mode: "default",
      hook_event_name: hookEventName,
      ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
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
  user_prompt_submit: "UserPromptSubmit",
  pre_tool_use: "PreToolUse",
  post_tool_use: "PostToolUse",
  stop: "Stop",
};

// SYNTH transcript fields with no real Archestra source (see claude-transcript).
const SYNTH_TRANSCRIPT_MODEL = "claude"; // real model is in the SessionStart payload
const SYNTH_TRANSCRIPT_VERSION = "archestra";

/**
 * Build the Claude-format transcript for this fire and upload it into the
 * sandbox at a stable per-conversation path, overwriting the previous version.
 * Each fire re-uploads (a durable replay event, like the per-fire payload) so
 * the transcript reflects current state; returns the path, or undefined when
 * there is nothing to write yet (empty conversation). Uses the caller-supplied
 * messages when present, else persisted history from the DB.
 */
async function writeTranscript(
  params: FireParams,
  sandboxId: string,
): Promise<string | undefined> {
  const messages =
    params.messages ?? (await loadConversationMessages(params.conversationId));
  const jsonl = messagesToClaudeTranscript(messages, {
    sessionId: params.conversationId,
    cwd: SKILL_SANDBOX_HOME,
    model: SYNTH_TRANSCRIPT_MODEL,
    version: SYNTH_TRANSCRIPT_VERSION,
    timestamp: new Date().toISOString(),
  });
  if (!jsonl) return undefined;
  const path = `${SKILL_SANDBOX_HOME}/transcript/${params.conversationId}.jsonl`;
  await skillSandboxRuntimeService.uploadFile({
    sandboxId: asSandboxId(sandboxId),
    path,
    data: Buffer.from(jsonl, "utf8"),
  });
  return path;
}

/** Persisted conversation history as `ChatMessage[]` (the stored UIMessage JSON). */
async function loadConversationMessages(
  conversationId: string,
): Promise<ChatMessage[]> {
  const rows = await MessageModel.findByConversation(conversationId);
  return rows.map((row) => row.content as ChatMessage);
}
