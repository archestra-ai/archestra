import type { ExternalMcpSkillDetail, ExternalMcpSkillListItem } from "@/types";
import { escapeXmlAttr, neutralizeFrameTags } from "./skill-activation";

export function formatExternalSkillName(
  skill: Pick<
    ExternalMcpSkillListItem,
    "serverName" | "scope" | "mcpServerId" | "name"
  >,
): string {
  return escapeExternalMetadata(
    `${skill.serverName} [${skill.scope}:${skill.mcpServerId.slice(0, 8)}] / ${skill.name}`,
  );
}

export function formatExternalSkillActivation(
  skill: ExternalMcpSkillDetail,
  activationName = formatExternalSkillName(skill),
): string {
  const name = neutralizeFrameTags(activationName);
  const files = skill.files.map((file) => file.path).sort();
  return [
    `<skill_content name="${escapeXmlAttr(name)}" source="mcp" live="true">`,
    neutralizeFrameTags(skill.content),
    "</skill_content>",
    files.length > 0
      ? `<skill_files>${files.map((path) => `\n- ${neutralizeFrameTags(path)}`).join("")}\n</skill_files>`
      : "",
    "This skill is read live from its MCP server; load it again to pick up source changes.",
  ]
    .filter(Boolean)
    .join("\n");
}

function escapeExternalMetadata(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
