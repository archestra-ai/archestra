import {
  type ArchestraToolShortName,
  TOOL_DOWNLOAD_FILE_SHORT_NAME,
  TOOL_RUN_COMMAND_SHORT_NAME,
  TOOL_UPLOAD_FILE_SHORT_NAME,
} from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { userHasPermission } from "@/auth/utils";
import config from "@/config";
import { ToolModel } from "@/models";

/**
 * Whether the code execution sandbox is genuinely usable for a given agent:
 *   1. the feature is enabled on this deployment,
 *   2. the caller holds `sandbox:execute`, and
 *   3. the sandbox tools are assigned to the agent.
 *
 * The assignment check mirrors what `tools/list` exposes (it reads the same
 * `getMcpToolsByAgent` source), so we never advertise the sandbox path to a
 * model whose agent cannot call those tools. Assignment is the right signal in
 * both exposure modes: `search_and_run_only` hides assigned tools from
 * `tools/list` but still runs them through `run_tool`. Fail-closed when any
 * input is missing.
 */
export async function isSkillSandboxAvailableForAgent(params: {
  userId: string | undefined;
  organizationId: string;
  agentId: string | undefined;
}): Promise<boolean> {
  if (!config.skillsSandbox.enabled) return false;
  if (!params.userId) return false;
  if (!params.agentId) return false;

  const allowed = await userHasPermission(
    params.userId,
    params.organizationId,
    "sandbox",
    "execute",
  );
  if (!allowed) return false;

  const assigned = new Set(
    (await ToolModel.getMcpToolsByAgent(params.agentId)).map((t) => t.name),
  );
  const required: ArchestraToolShortName[] = [
    TOOL_RUN_COMMAND_SHORT_NAME,
    TOOL_UPLOAD_FILE_SHORT_NAME,
    TOOL_DOWNLOAD_FILE_SHORT_NAME,
  ];
  return required.every((shortName) =>
    assigned.has(archestraMcpBranding.getToolName(shortName)),
  );
}
