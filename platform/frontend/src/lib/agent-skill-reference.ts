import type { AgentActivationSkill } from "@/lib/agent-skills.query";

export type AgentActivationSkillReference = AgentActivationSkill["reference"];

export function agentActivationSkillReferenceKey(
  reference: AgentActivationSkillReference,
) {
  switch (reference.source) {
    case "native":
      return `native:${reference.skillId}`;
    case "external_mcp":
      return `external:${reference.mcpServerId}:${reference.uri}`;
    case "plugin":
      return `plugin:${reference.pluginId}:${reference.skillPath}`;
  }
}
