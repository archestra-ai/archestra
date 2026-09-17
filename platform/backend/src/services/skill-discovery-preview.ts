import {
  SKILL_TOOL_PREFIX,
  TOOL_LIST_SKILLS_SHORT_NAME,
  TOOL_LOAD_SKILL_SHORT_NAME,
} from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { isArchestraToolAvailableToAgent } from "@/archestra-mcp-server/dynamic-tools";
import { filterToolNamesByPermission } from "@/archestra-mcp-server/rbac";
import { escapeXmlAttr } from "@/skills/skill-activation";
import { SKILL_CATALOG_UNTRUSTED_NOTE } from "@/skills/skill-catalog-prompt";
import { listAvailableAgentSkills } from "./agent-activation-skills";

/** Bounded, caller-scoped discovery hints for MCP clients and runtime prompts. */
export async function buildSkillDiscoveryPreview(params: {
  agentId: string;
  organizationId: string;
  userId?: string;
}): Promise<string | null> {
  const loadTool = archestraMcpBranding.getToolName(TOOL_LOAD_SKILL_SHORT_NAME);
  const permitted = await filterToolNamesByPermission(
    [loadTool],
    params.userId,
    params.organizationId,
  );
  if (
    !permitted.has(loadTool) ||
    !(await isArchestraToolAvailableToAgent({ ...params, toolName: loadTool }))
  ) {
    return null;
  }

  // Keep precedence, environment, policy and plugin/external activation names
  // identical to list_skills. Never cache this across calling principals.
  const skills = (await listAvailableAgentSkills(params)).sort((a, b) =>
    a.activationName.localeCompare(b.activationName),
  );
  if (skills.length === 0) return null;

  const lines: string[] = [];
  let length = 0;
  for (const available of skills) {
    if (lines.length === MAX_SKILLS) break;
    // Live source names are already projected to the exact wire name accepted
    // by load_skill. Escape for this frame without truncating that identity.
    const name =
      available.source === "native"
        ? available.activationName
        : available.wireName;
    const description = compactDescription(available.skill.description ?? "");
    const agentName =
      available.source === "native" ? available.skill.agentName : null;
    const agentAttr = agentName ? ` agent="${escapeXmlAttr(agentName)}"` : "";
    const line = `<skill name="${escapeXmlAttr(name)}"${agentAttr}>${escapeXmlAttr(description)}</skill>`;
    if (length + line.length + 1 > MAX_CATALOG_LENGTH) continue;
    lines.push(line);
    length += line.length + 1;
  }

  const listTool = archestraMcpBranding.getToolName(
    TOOL_LIST_SKILLS_SHORT_NAME,
  );
  return [
    `Skill preview (${lines.length} of ${skills.length} available):`,
    '<available_skills trust="untrusted">',
    ...lines,
    "</available_skills>",
    SKILL_CATALOG_UNTRUSTED_NOTE,
    ...(skills.some((item) => item.source === "native" && item.skill.agentName)
      ? [
          `A skill with an agent attribute runs in that subagent: call its ${SKILL_TOOL_PREFIX}<name> tool with your task as message instead of loading it.`,
        ]
      : []),
    `When a skill matches the task, call ${loadTool} with its exact name before doing the work. Call ${listTool} for the complete, current catalog, including skills omitted from this preview. Availability is rechecked when loading.`,
  ].join("\n");
}

// === Internal helpers ===

const MAX_SKILLS = 20;
const MAX_CATALOG_LENGTH = 6_000;
const MAX_DESCRIPTION_LENGTH = 240;

function compactDescription(value: string): string {
  const clean = value.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
  return clean.length > MAX_DESCRIPTION_LENGTH
    ? `${clean.slice(0, MAX_DESCRIPTION_LENGTH - 1)}…`
    : clean;
}
