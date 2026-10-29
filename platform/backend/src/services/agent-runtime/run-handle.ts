import {
  TOOL_GET_AGENT_RUN_SHORT_NAME,
  TOOL_STEER_AGENT_RUN_SHORT_NAME,
} from "@archestra/shared";
import config from "@/config";

/** The run page for a run's stable id. */
export function agentRunUrl(runId: string): string {
  return `${config.frontendBaseUrl}/chat/runs/${runId}`;
}

/**
 * What the model should do after starting a background run. Shared by the
 * gateway's result and the proxy's text for a governed launch.
 */
export function submittedRunNextStep(params: {
  reportsToThread: boolean;
}): string {
  return [
    "The run is working in the background. Tell the user it started and give them run_url.",
    `Don't call ${TOOL_GET_AGENT_RUN_SHORT_NAME} again this turn.`,
    `Send follow-ups with ${TOOL_STEER_AGENT_RUN_SHORT_NAME} and this run_id.`,
    ...(params.reportsToThread
      ? ["Its result will be posted to this thread."]
      : []),
  ].join(" ");
}
