import type { PluginSkillDetail, PluginSkillListItem } from "@/types";
import { escapeXmlAttr, neutralizeFrameTags } from "./skill-activation";

export function formatPluginSkillName(
  skill: Pick<
    PluginSkillListItem,
    "pluginName" | "scope" | "pluginId" | "skillPath" | "name"
  >,
): string {
  return escapePluginMetadata(
    `${skill.pluginName} [plugin:${skill.pluginId}:${skill.skillPath || "."}] / ${skill.name}`,
  );
}

export function formatPluginSkillActivation(
  skill: PluginSkillDetail,
  activationName = formatPluginSkillName(skill),
): string {
  const name = neutralizeFrameTags(activationName);
  const files = skill.files.map((file) => file.path).sort();
  return [
    `<skill_content name="${escapeXmlAttr(name)}" source="plugin" live="true">`,
    neutralizeFrameTags(skill.content),
    "</skill_content>",
    files.length > 0
      ? `<skill_files>${files.map((path) => `\n- ${neutralizeFrameTags(path)}`).join("")}\n</skill_files>`
      : "",
    "This skill is read from its plugin source; load it again to pick up source changes.",
  ]
    .filter(Boolean)
    .join("\n");
}

function escapePluginMetadata(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
