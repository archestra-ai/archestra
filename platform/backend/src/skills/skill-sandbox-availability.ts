import {
  ARCHESTRA_MCP_CATALOG_ID,
  type ArchestraToolShortName,
  TOOL_DOWNLOAD_FILE_SHORT_NAME,
  TOOL_RUN_COMMAND_SHORT_NAME,
  TOOL_UPLOAD_FILE_SHORT_NAME,
} from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { dynamicAccessContext } from "@/archestra-mcp-server/dynamic-tools";
import { userHasPermission } from "@/auth/utils";
import config from "@/config";
import { ToolModel } from "@/models";
import {
  agentToolExclusionsService,
  isToolIdentityExcluded,
} from "@/services/agent-tool-exclusions";

/**
 * Whether the code execution sandbox is genuinely usable for a given agent:
 *   1. the feature is enabled on this deployment,
 *   2. the caller holds `sandbox:execute`, and
 *   3. the agent can actually invoke the sandbox tools — either they are
 *      assigned to it, or it has `accessAllTools` on (which lets a real user
 *      discover and run them dynamically, see `dynamicAccessContext`).
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

  const required: ArchestraToolShortName[] = [
    TOOL_RUN_COMMAND_SHORT_NAME,
    TOOL_UPLOAD_FILE_SHORT_NAME,
    TOOL_DOWNLOAD_FILE_SHORT_NAME,
  ];

  // `accessAllTools` agents run the sandbox tools via dynamic dispatch without a
  // manual assignment; `dynamicAccessContext` is the canonical gate for that
  // path (real authenticated user, agent opt-in), so reuse it rather than
  // re-deriving the rule here. But a per-agent exclusion revokes the dynamic
  // relaxation for that tool, so an excluded sandbox tool would be refused at
  // dispatch. Advertising the sandbox (activation prompt, attachment staging)
  // while a call it steers the model toward fails strands the model, so require
  // that none of the sandbox tools are excluded — matching the all-or-nothing
  // group semantics the assignment branch below already applies.
  const dynamicAccess = await dynamicAccessContext({
    agentId: params.agentId,
    userId: params.userId,
    organizationId: params.organizationId,
  });
  if (dynamicAccess) {
    const exclusionSets = await agentToolExclusionsService.getExclusionSets(
      params.agentId,
    );
    return required.every(
      (shortName) =>
        !isToolIdentityExcluded(
          {
            catalogId: ARCHESTRA_MCP_CATALOG_ID,
            name: archestraMcpBranding.getToolName(shortName),
          },
          exclusionSets,
        ),
    );
  }

  const assigned = new Set(
    (await ToolModel.getMcpToolsByAgent(params.agentId)).map((t) => t.name),
  );
  return required.every((shortName) =>
    assigned.has(archestraMcpBranding.getToolName(shortName)),
  );
}
