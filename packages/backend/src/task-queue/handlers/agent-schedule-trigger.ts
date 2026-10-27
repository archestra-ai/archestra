// ============================================================================
// archestra-ai/archestra Issue #3378 — Agent Schedule Triggers ($500 Bounty)
// Target File in Repo: packages/backend/src/task-queue/handlers/agent-schedule-trigger.ts
// Bounty: $500 via Algora (https://github.com/archestra-ai/archestra/issues/3378)
//
// Key Requirements:
// 1. `execute_agent_schedule_trigger` handler that processes periodic agent runs.
// 2. `condition_tool_id`: Evaluates lightweight condition tool before spinning up
//    the full agent run to save 100% of LLM tokens when no new data exists.
// 3. `requires_approval`: Stores interaction with status `awaiting_approval`
//    for human confirmation before executing external actions (email, Slack).
// 4. `update_next_run(timestamp)`: Tool interceptor allowing dynamic cadence shifts.
// ============================================================================

export interface ScheduleTriggerPayload {
  trigger_id: string;
  agent_id: string;
  cron_expression: string;
  condition_tool_id?: string;
  requires_approval?: boolean;
  input_prompt: string;
}

export interface ExecutionResult {
  run_id: string;
  status: 'completed' | 'skipped_no_data' | 'awaiting_approval' | 'failed';
  tokens_saved?: boolean;
  output?: Record<string, unknown>;
  error?: string;
}

export async function handleAgentScheduleTrigger(
  payload: ScheduleTriggerPayload,
  dependencies: {
    evaluateConditionTool: (toolId: string) => Promise<boolean>;
    executeAgentRun: (agentId: string, prompt: string) => Promise<{ output: Record<string, unknown>; nextRunOverride?: string }>;
    saveInteractionForApproval: (triggerId: string, output: Record<string, unknown>) => Promise<string>;
    recordRunStatus: (runId: string, status: string, metadata: Record<string, unknown>) => Promise<void>;
  }
): Promise<ExecutionResult> {
  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // 1. Lightweight pre-check: Save 100% of LLM tokens if condition tool returns false
  if (payload.condition_tool_id) {
    const hasData = await dependencies.evaluateConditionTool(payload.condition_tool_id);
    if (!hasData) {
      await dependencies.recordRunStatus(runId, 'skipped_no_data', { trigger_id: payload.trigger_id });
      return { runId, status: 'skipped_no_data', tokens_saved: true };
    }
  }

  // 2. Execute main agent run
  try {
    const agentResult = await dependencies.executeAgentRun(payload.agent_id, payload.input_prompt);

    // 3. Human-in-the-loop: Hold in approval inbox if requires_approval is true
    if (payload.requires_approval) {
      const interactionId = await dependencies.saveInteractionForApproval(payload.trigger_id, agentResult.output);
      await dependencies.recordRunStatus(runId, 'awaiting_approval', { interaction_id: interactionId });
      return { runId, status: 'awaiting_approval', output: agentResult.output };
    }

    await dependencies.recordRunStatus(runId, 'completed', { output: agentResult.output });
    return { runId, status: 'completed', output: agentResult.output };
  } catch (err: any) {
    await dependencies.recordRunStatus(runId, 'failed', { error: err?.message });
    return { runId, status: 'failed', error: err?.message };
  }
}
