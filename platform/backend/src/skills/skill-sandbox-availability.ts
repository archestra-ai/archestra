import {
  type ArchestraToolShortName,
  TOOL_CREATE_SKILL_SANDBOX_SHORT_NAME,
  TOOL_GET_SKILL_SANDBOX_ARTIFACT_SHORT_NAME,
  TOOL_RUN_SKILL_COMMAND_SHORT_NAME,
} from "@shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import type { SkillPermissionChecker } from "@/auth/skill-permissions";
import config from "@/config";
import { ToolModel } from "@/models";

/**
 * Whether the skill sandbox tools are genuinely usable for a given agent:
 *   1. the feature is enabled on this deployment,
 *   2. the caller holds `skill:execute`, and
 *   3. all three sandbox tools are assigned to the agent.
 *
 * All three are required because the activation hint names each of them
 * (create → run → get artifact); a subset would point the model at a tool the
 * agent cannot call.
 *
 * The assignment check mirrors what `tools/list` exposes (it reads the same
 * `getMcpToolsByAgent` source), so we never advertise the sandbox path to a
 * model whose agent cannot call those tools. Assignment is the right signal in
 * both exposure modes: `search_and_run_only` hides assigned tools from
 * `tools/list` but still runs them through `run_tool`. Fail-closed when any
 * input is missing.
 */
export async function isSkillSandboxAvailableForAgent(params: {
  checker: SkillPermissionChecker | null;
  agentId: string | undefined;
}): Promise<boolean> {
  if (!config.skillsSandbox.enabled) return false;
  if (!(params.checker?.canExecute ?? false)) return false;
  if (!params.agentId) return false;

  const assigned = new Set(
    (await ToolModel.getMcpToolsByAgent(params.agentId)).map((t) => t.name),
  );
  const required: ArchestraToolShortName[] = [
    TOOL_CREATE_SKILL_SANDBOX_SHORT_NAME,
    TOOL_RUN_SKILL_COMMAND_SHORT_NAME,
    TOOL_GET_SKILL_SANDBOX_ARTIFACT_SHORT_NAME,
  ];
  return required.every((shortName) =>
    assigned.has(archestraMcpBranding.getToolName(shortName)),
  );
}
