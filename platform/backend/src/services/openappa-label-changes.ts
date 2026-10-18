import { McpToolCallModel, OpenappaLabelChangeModel } from "@/models";
import { openappaCoverageService } from "@/openappa/coverage";
import { withoutTrajectoryStamp } from "@/openappa/trajectory-stamp";
import type { CoverageRule } from "@/types/openappa-coverage";
import type { LabelChange } from "@/types/openappa-label-changes";

/** A recorded label change, with the tool and the policy rule behind it. */
export type LabelChangeView = LabelChange & {
  /** The full tool name, from the record or the logged tool call. */
  tool: string | null;
  /**
   * The rule the current policy applies to that tool, with its TOML. The
   * engine does not record which rule matched a call, so this is the rule
   * that names the tool now (or the catch-all), not a stored fact.
   */
  rule: {
    source: CoverageRule["source"];
    battery: string | null;
    batteryEntry: string | null;
    line: number | null;
    text: string | null;
  } | null;
};

/**
 * Every recorded label change of an LLM session, oldest first. A viewer
 * without `callerId` access to everyone's sessions reads only their own.
 */
export async function listSessionLabelChanges(params: {
  organizationId: string;
  llmSessionId: string;
  callerId: string | undefined;
}): Promise<LabelChangeView[]> {
  const { organizationId, llmSessionId } = params;
  const changes = await OpenappaLabelChangeModel.findByLlmSession({
    organizationId,
    llmSessionId,
    callerId: params.callerId,
  });
  if (changes.length === 0) return [];

  // A result's dispatch carries no tool name; the logged call it was for does.
  const needsTool = changes.some((change) => !change.tool && change.callId);
  const toolByCallId = new Map<string, string>();
  if (needsTool) {
    const calls = await McpToolCallModel.findModelCallIdsBySession({
      organizationId,
      sessionId: llmSessionId,
    });
    for (const call of calls)
      if (call.toolName)
        toolByCallId.set(
          withoutTrajectoryStamp(call.llmToolCallId),
          call.toolName,
        );
  }
  const withTools = changes.map((change) => ({
    ...change,
    tool:
      change.tool ??
      (change.callId
        ? (toolByCallId.get(change.callId.replace(/^call:/, "")) ?? null)
        : null),
  }));

  const rules = await openappaCoverageService.rulesForTools({
    organizationId,
    toolNames: withTools.flatMap((change) =>
      change.tool && change.event !== "session_start" ? [change.tool] : [],
    ),
  });
  return withTools.map((change) => {
    const matched = change.tool ? rules.get(change.tool) : null;
    return {
      ...change,
      rule: matched
        ? {
            source: matched.rule.source,
            battery: matched.rule.battery,
            batteryEntry: matched.rule.batteryEntry,
            line: matched.rule.line,
            text: matched.text,
          }
        : null,
    };
  });
}
