import {
  ARCHESTRA_TOOL_GROUP_BY_SHORT_NAME,
  type ArchestraToolShortName,
  isAgentTool,
  isSkillTool,
  isYellToolShortName,
  TOOL_ASK_USER_SHORT_NAME,
  TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
  TOOL_GET_REMEDY_PLANS_SHORT_NAME,
  TOOL_LIST_PEER_MESSAGES_SHORT_NAME,
  TOOL_PROPOSE_TUNER_SUGGESTION_SHORT_NAME,
  TOOL_READ_PEER_MESSAGE_SHORT_NAME,
} from "@archestra/shared";
import { ToolModel } from "@/models";
import { hasTunerAccess } from "@/services/tuners/access";
import { findTunerRun, type TunerRunScope } from "@/services/tuners/tuner-run";
import { archestraMcpBranding } from "./branding";
import { errorResult } from "./helpers";
import type { ArchestraContext } from "./types";

/**
 * Keeps a tuner run propose-only: the agent may call the tools assigned to it
 * and `propose_tuner_suggestion`, nothing that delegates, dispatches, asks a
 * person, or writes through an implicit built-in, and nothing at all once the
 * user it runs as loses tuner rights. Outside tuner runs
 * `propose_tuner_suggestion` does not exist and nothing else changes.
 * Returns the refusal, or null to continue.
 */
export async function admitTunerRunToolCall(params: {
  toolName: string;
  context: ArchestraContext;
}): Promise<{ refusal: ReturnType<typeof errorResult> } | null> {
  const { toolName, context } = params;
  const shortName = archestraMcpBranding.getToolShortName(toolName);
  const run = await findTunerRun(context.scheduleTriggerRunId);
  if (!run) {
    if (shortName === TOOL_PROPOSE_TUNER_SUGGESTION_SHORT_NAME) {
      throw { code: -32601, message: `No tool named "${toolName}" exists.` };
    }
    return null;
  }
  if (!(await executesWithTunerRights(run, context.userId))) {
    return { refusal: errorResult(TUNER_RIGHTS_REVOKED) };
  }
  const allowed = await tunerRunToolFilter(context.agent.id);
  return allowed(toolName)
    ? null
    : {
        refusal: errorResult(
          `"${toolName}" is not available in a tuner run. Use the tools listed for this run and propose_tuner_suggestion.`,
        ),
      };
}

/**
 * The refusal for a tool outside the built-in server (whose calls pass
 * {@link admitTunerRunToolCall}) in a tuner run whose user lost tuner rights,
 * or null to continue.
 */
export async function refuseRevokedTunerRunCall(params: {
  scheduleTriggerRunId: string | undefined;
  userId: string | undefined;
}): Promise<string | null> {
  const run = await findTunerRun(params.scheduleTriggerRunId);
  if (!run || (await executesWithTunerRights(run, params.userId))) return null;
  return TUNER_RIGHTS_REVOKED;
}

/** Whether a tool may be listed for, and called in, the agent's tuner run. */
export async function tunerRunToolFilter(
  agentId: string,
): Promise<(toolName: string) => boolean> {
  const assigned = new Set(
    (await ToolModel.getMcpToolsByAgent(agentId)).map((tool) =>
      archestraMcpBranding.getToolShortName(tool.name),
    ),
  );
  return (toolName) => {
    if (isAgentTool(toolName) || isSkillTool(toolName)) return false;
    const shortName = archestraMcpBranding.getToolShortName(toolName);
    if (!shortName) return true;
    if (TUNER_RUN_IMPLICIT_SHORT_NAMES.has(shortName)) return true;
    if (isForbiddenInTunerRun(shortName)) return false;
    return assigned.has(shortName);
  };
}

/**
 * Checks the user the call executes as, not the trigger's current actor:
 * enabling the tuner again moves the actor without touching a started run.
 */
async function executesWithTunerRights(
  run: TunerRunScope,
  userId: string | undefined,
): Promise<boolean> {
  return (
    !!userId &&
    hasTunerAccess({
      userId,
      organizationId: run.organizationId,
      access: "update",
    })
  );
}

const TUNER_RIGHTS_REVOKED =
  "The user this tuner runs as no longer holds tuner:update and log:admin.";

function isForbiddenInTunerRun(shortName: ArchestraToolShortName): boolean {
  switch (ARCHESTRA_TOOL_GROUP_BY_SHORT_NAME[shortName]) {
    case "meta":
    case "tasks":
      return true;
    default:
      return (
        isYellToolShortName(shortName) ||
        TUNER_RUN_FORBIDDEN_SHORT_NAMES.has(shortName)
      );
  }
}

/**
 * Never assigned, always allowed: the run's own sink, and the remedy pair the
 * proxy requires every governed session to declare.
 */
const TUNER_RUN_IMPLICIT_SHORT_NAMES = new Set<ArchestraToolShortName>([
  TOOL_PROPOSE_TUNER_SUGGESTION_SHORT_NAME,
  TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
  TOOL_GET_REMEDY_PLANS_SHORT_NAME,
]);

const TUNER_RUN_FORBIDDEN_SHORT_NAMES = new Set<ArchestraToolShortName>([
  TOOL_ASK_USER_SHORT_NAME,
  TOOL_LIST_PEER_MESSAGES_SHORT_NAME,
  TOOL_READ_PEER_MESSAGE_SHORT_NAME,
]);
