import {
  getAvailableAgentSkillReference,
  type PolicyIndependentAvailableAgentSkill,
} from "@/services/agent-activation-skill-candidates";
import { formatExternalSkillName } from "@/skills/external-skill-activation";
import { formatPluginSkillName } from "@/skills/plugin-skill-activation";
import { escapeXmlAttr } from "@/skills/skill-activation";
import type {
  AgentActivationSkill,
  ExternalMcpSkillListItem,
  PluginSkillListItem,
} from "@/types";

export type ProjectedPluginSkill = {
  source: "plugin";
  wireName: string;
  activationName: string;
  skill: PluginSkillListItem;
};

export type ProjectedExternalSkill = {
  source: "external";
  wireName: string;
  activationName: string;
  skill: ExternalMcpSkillListItem;
};

type ProjectedLiveSkill = ProjectedPluginSkill | ProjectedExternalSkill;

type ProjectableAgentSkill =
  | {
      source: "native";
      activationName: string;
      skill: Extract<
        PolicyIndependentAvailableAgentSkill,
        { source: "native" }
      >["skill"];
    }
  | ProjectedLiveSkill;

/**
 * Project raw policy-editor candidates into stable identities and
 * collision-safe cross-source activation names without applying policy.
 * Native duplicates are deliberately preserved: the editor must be able to
 * select an exact lower-precedence skill, after which runtime policy filtering
 * happens before native precedence chooses the effective skill.
 */
export function projectPolicyIndependentAvailableAgentSkills(
  candidates: PolicyIndependentAvailableAgentSkill[],
): AgentActivationSkill[] {
  const nativeSkills = candidates
    .filter((candidate) => candidate.source === "native")
    .map((candidate) => candidate.skill);
  const projected = projectLiveSkillNames({
    nativeNames: nativeSkills.map((skill) => skill.name),
    pluginSkills: candidates
      .filter((candidate) => candidate.source === "plugin")
      .map((candidate) => candidate.skill),
    externalSkills: candidates
      .filter((candidate) => candidate.source === "external")
      .map((candidate) => candidate.skill),
  });
  return [
    ...nativeSkills.map((skill) => ({
      source: "native" as const,
      activationName: skill.name,
      skill,
    })),
    ...projected,
  ]
    .map(toAgentActivationSkill)
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        referenceKey(left).localeCompare(referenceKey(right)),
    );
}

export function toAgentActivationSkill(
  available: ProjectableAgentSkill,
): AgentActivationSkill {
  if (available.source === "native") {
    return {
      reference: getAvailableAgentSkillReference(available),
      name: available.skill.name,
      activationName: available.activationName,
      description: available.skill.description,
      scope: available.skill.scope,
      providerName: null,
    };
  }
  if (available.source === "plugin") {
    return {
      reference: getAvailableAgentSkillReference(available),
      name: available.skill.name,
      activationName: available.wireName,
      description: available.skill.description,
      scope: available.skill.scope,
      providerName: available.skill.pluginName,
    };
  }
  return {
    reference: getAvailableAgentSkillReference(available),
    name: available.skill.name,
    activationName: available.wireName,
    description: available.skill.description,
    scope: available.skill.scope,
    providerName: available.skill.serverName,
  };
}

export function projectLiveSkillNames(params: {
  nativeNames: string[];
  pluginSkills: PluginSkillListItem[];
  externalSkills: ExternalMcpSkillListItem[];
}): ProjectedLiveSkill[] {
  const liveSkills: ProjectedLiveSkill[] = [
    ...params.pluginSkills.map((skill) => ({
      source: "plugin" as const,
      wireName: skill.name,
      activationName: skill.name,
      skill,
    })),
    ...params.externalSkills.map((skill) => ({
      source: "external" as const,
      wireName: skill.name,
      activationName: skill.name,
      skill,
    })),
  ];
  const legacyNames = new Set([
    ...params.pluginSkills.map(formatPluginSkillName),
    ...params.externalSkills.map(formatExternalSkillName),
  ]);
  const reservedWireNames = new Set([
    ...params.nativeNames.map(escapeXmlAttr),
    ...liveSkills.map((projected) => escapeXmlAttr(projected.skill.name)),
    ...legacyNames,
  ]);
  const nameCounts = new Map<string, number>();
  for (const name of params.nativeNames) nameCounts.set(name, 1);
  for (const projected of liveSkills) {
    nameCounts.set(
      projected.skill.name,
      (nameCounts.get(projected.skill.name) ?? 0) + 1,
    );
  }

  const assignedWireNames = new Set<string>();
  const namesBySkillKey = new Map<
    string,
    { wireName: string; activationName: string }
  >();
  const skillsByStableIdentity = [...liveSkills].sort((left, right) =>
    projectedSkillKey(left).localeCompare(projectedSkillKey(right)),
  );
  for (const projected of skillsByStableIdentity) {
    const declaredName = projected.skill.name;
    const declaredWireName = escapeXmlAttr(declaredName);
    if (
      nameCounts.get(declaredName) === 1 &&
      !legacyNames.has(declaredWireName)
    ) {
      assignedWireNames.add(declaredWireName);
      namesBySkillKey.set(projectedSkillKey(projected), {
        wireName: declaredWireName,
        activationName: declaredName,
      });
      continue;
    }

    const suffix = projected.source === "plugin" ? "plugin" : "mcp";
    const baseName = `${declaredName}-from-${suffix}`;
    let name = baseName;
    let index = 2;
    while (
      reservedWireNames.has(escapeXmlAttr(name)) ||
      assignedWireNames.has(escapeXmlAttr(name))
    ) {
      name = `${baseName}-${index}`;
      index += 1;
    }
    const wireName = escapeXmlAttr(name);
    assignedWireNames.add(wireName);
    namesBySkillKey.set(projectedSkillKey(projected), {
      wireName,
      activationName: name,
    });
  }

  return liveSkills.map((projected) => {
    const names = namesBySkillKey.get(projectedSkillKey(projected));
    if (names === undefined) throw new Error("Projected skill name is missing");
    return { ...projected, ...names };
  });
}

function projectedSkillKey(skill: ProjectedLiveSkill): string {
  return skill.source === "plugin"
    ? `plugin:${skill.skill.pluginId}:${skill.skill.skillPath}`
    : `external:${skill.skill.mcpServerId}:${skill.skill.id}`;
}

function referenceKey(skill: AgentActivationSkill): string {
  const reference = skill.reference;
  switch (reference.source) {
    case "native":
      return `native:${reference.skillId}`;
    case "external_mcp":
      return `external:${reference.mcpServerId}:${reference.uri}`;
    case "plugin":
      return `plugin:${reference.pluginId}:${reference.skillPath}`;
  }
}
