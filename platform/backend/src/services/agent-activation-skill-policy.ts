import { clearChatMcpClient } from "@/clients/chat-mcp-client";
import { withDbTransaction } from "@/database";
import {
  AgentActivationSkillRuleModel,
  AgentModel,
  AgentVersionModel,
} from "@/models";
import type {
  AgentActivationSkillPolicyRule,
  AgentActivationSkillPolicySnapshot,
} from "@/models/agent-activation-skill-rule";
import {
  getAvailableAgentSkillReference,
  listPolicyIndependentAvailableAgentSkills,
} from "@/services/agent-activation-skill-candidates";
import { projectPolicyIndependentAvailableAgentSkills } from "@/services/agent-activation-skill-projection";
import type {
  AgentActivationSkill,
  AgentActivationSkillMode,
  AgentActivationSkillPolicyOperation,
  AgentActivationSkillPolicyResponse,
  AgentActivationSkillReference,
  AgentActivationSkillRuleDisposition,
  CreateAgentActivationSkillPolicy,
  PatchAgentActivationSkillPolicy,
} from "@/types";
import { ApiError } from "@/types";

export type AgentActivationSkillPolicyEvaluator = {
  isReferenceAllowed(reference: AgentActivationSkillReference): boolean;
};

/**
 * Restrictive, per-internal-agent skill policy. Runtime policy evaluation is
 * independent of source visibility and RBAC; callers intersect its
 * stable-reference decision with their independently resolved eligible set.
 * This service also owns validation, revisioned persistence, runtime cache
 * invalidation, and version capture for policy changes.
 */
class AgentActivationSkillPolicyService {
  async getEvaluator(
    agentId: string,
  ): Promise<AgentActivationSkillPolicyEvaluator> {
    const snapshot =
      await AgentActivationSkillRuleModel.findPolicySnapshot(agentId);
    // A stale execution context naming a removed agent must not gain access.
    if (!snapshot) return { isReferenceAllowed: () => false };
    return evaluatorForSnapshot(snapshot);
  }

  async getEvaluators(
    agentIds: string[],
  ): Promise<Map<string, AgentActivationSkillPolicyEvaluator>> {
    const snapshots =
      await AgentActivationSkillRuleModel.findPolicySnapshots(agentIds);
    return new Map(
      agentIds.map((agentId) => {
        const snapshot = snapshots.get(agentId);
        return [
          agentId,
          snapshot
            ? evaluatorForSnapshot(snapshot)
            : { isReferenceAllowed: () => false },
        ] as const;
      }),
    );
  }

  async isReferenceAllowed(params: {
    agentId: string;
    reference: AgentActivationSkillReference;
  }): Promise<boolean> {
    const evaluator = await this.getEvaluator(params.agentId);
    return evaluator.isReferenceAllowed(params.reference);
  }

  async getPolicy(params: {
    agentId: string;
    organizationId: string;
    userId: string;
  }): Promise<AgentActivationSkillPolicyResponse> {
    const [snapshot, candidates] = await Promise.all([
      AgentActivationSkillRuleModel.findPolicySnapshot(params.agentId),
      listPolicyIndependentAvailableAgentSkills(params),
    ]);
    if (!snapshot) throw new ApiError(404, "Agent not found");
    return buildEditorResponse({
      state: snapshot,
      rules: snapshot.rules,
      skills: projectPolicyIndependentAvailableAgentSkills(candidates),
    });
  }

  async patchPolicy(params: {
    agentId: string;
    organizationId: string;
    userId: string;
    patch: PatchAgentActivationSkillPolicy;
  }): Promise<{
    policy: AgentActivationSkillPolicyResponse;
    changed: boolean;
  }> {
    const candidates = await listPolicyIndependentAvailableAgentSkills(params);
    const visibleKeys = new Set(
      candidates.map((candidate) =>
        referenceKey(getAvailableAgentSkillReference(candidate)),
      ),
    );
    for (const operation of params.patch.operations) {
      // Removing a stored rule only narrows or preserves access, and must stay
      // possible after the skill becomes unavailable (for example after an
      // environment change). Only additions need current-visibility proof.
      if (
        operation.op === "add" &&
        !visibleKeys.has(referenceKey(operation.reference))
      ) {
        throw new ApiError(
          422,
          "A referenced skill is not currently available",
        );
      }
    }

    const changed = await withDbTransaction(async (tx) => {
      await AgentModel.lockRowForUpdate(params.agentId, tx);
      const snapshot = await AgentActivationSkillRuleModel.findPolicySnapshot(
        params.agentId,
        tx,
      );
      if (!snapshot) throw new ApiError(404, "Agent not found");
      if (snapshot.revision !== params.patch.expectedRevision) {
        throw new ApiError(409, "Activation skill policy was modified");
      }

      const stored = snapshot.rules;
      const operations = normalizeOperations(params.patch.operations);
      const discard = new Set(params.patch.discardUnavailable);
      const targetByKey = new Map(
        stored
          .filter(
            (rule) =>
              !discard.has(rule.disposition) ||
              visibleKeys.has(referenceKey(rule.reference)),
          )
          .map((rule) => [ruleKey(rule), rule]),
      );
      for (const operation of operations) {
        const key = ruleKey(operation);
        if (operation.op === "add") {
          targetByKey.set(key, {
            disposition: operation.disposition,
            reference: operation.reference,
          });
        } else {
          targetByKey.delete(key);
        }
      }
      const target = [...targetByKey.values()];
      assertRuleLimits(target);
      const mode = params.patch.mode ?? snapshot.mode;
      const storedKeys = new Set(stored.map(ruleKey));
      const targetKeys = new Set(target.map(ruleKey));
      if (
        mode === snapshot.mode &&
        storedKeys.size === targetKeys.size &&
        [...storedKeys].every((key) => targetKeys.has(key))
      ) {
        return false;
      }
      await AgentActivationSkillRuleModel.replaceRules({
        agentId: params.agentId,
        rules: target,
        tx,
      });
      await AgentModel.setActivationSkillPolicyState({
        id: params.agentId,
        mode,
        revision: snapshot.revision + 1,
        tx,
      });
      return true;
    });

    if (changed) {
      await clearChatMcpClient(params.agentId);
      await AgentVersionModel.forkIfChangedBestEffort(params.agentId);
    }
    return { policy: await this.getPolicy(params), changed };
  }

  async initializePolicy(params: {
    agentId: string;
    organizationId: string;
    userId: string;
    policy: CreateAgentActivationSkillPolicy;
  }): Promise<void> {
    const candidates = await listPolicyIndependentAvailableAgentSkills(params);
    const visibleKeys = new Set(
      candidates.map((candidate) =>
        referenceKey(getAvailableAgentSkillReference(candidate)),
      ),
    );
    const rules = deduplicateRules([
      ...params.policy.allowedReferences.map((reference) => ({
        disposition: "allow" as const,
        reference,
      })),
      ...params.policy.excludedReferences.map((reference) => ({
        disposition: "exclude" as const,
        reference,
      })),
    ]);
    assertRuleLimits(rules);
    for (const rule of rules) {
      if (!visibleKeys.has(referenceKey(rule.reference))) {
        throw new ApiError(
          422,
          "A referenced skill is not currently available",
        );
      }
    }
    await withDbTransaction(async (tx) => {
      await AgentModel.lockRowForUpdate(params.agentId, tx);
      const state = await AgentModel.findActivationSkillPolicyState(
        params.agentId,
        tx,
      );
      if (!state || state.revision !== 0) {
        throw new ApiError(409, "Activation skill policy was modified");
      }
      await AgentActivationSkillRuleModel.addRules({
        agentId: params.agentId,
        rules,
        tx,
      });
      await AgentModel.setActivationSkillPolicyState({
        id: params.agentId,
        mode: params.policy.mode,
        revision: 1,
        tx,
      });
    });
  }

  async validatePolicyForDraft(params: {
    organizationId: string;
    userId: string;
    environmentId: string | null;
    policy: CreateAgentActivationSkillPolicy;
  }): Promise<void> {
    const candidates = await listPolicyIndependentAvailableAgentSkills(params);
    const visibleKeys = new Set(
      candidates.map((candidate) =>
        referenceKey(getAvailableAgentSkillReference(candidate)),
      ),
    );
    for (const reference of [
      ...params.policy.allowedReferences,
      ...params.policy.excludedReferences,
    ]) {
      if (!visibleKeys.has(referenceKey(reference))) {
        throw new ApiError(
          422,
          "A referenced skill is not currently available",
        );
      }
    }
  }

  async replacePolicyForRestore(params: {
    agentId: string;
    mode: AgentActivationSkillMode;
    rules: AgentActivationSkillPolicyRule[];
  }): Promise<void> {
    await withDbTransaction(async (tx) => {
      await AgentModel.lockRowForUpdate(params.agentId, tx);
      const state = await AgentModel.findActivationSkillPolicyState(
        params.agentId,
        tx,
      );
      if (!state) throw new ApiError(404, "Agent not found");
      await AgentActivationSkillRuleModel.replaceRules({
        agentId: params.agentId,
        rules: params.rules,
        tx,
      });
      await AgentModel.setActivationSkillPolicyState({
        id: params.agentId,
        mode: params.mode,
        revision: state.revision + 1,
        tx,
      });
    });
    await clearChatMcpClient(params.agentId);
  }
}

function buildEditorResponse(params: {
  state: { mode: AgentActivationSkillMode; revision: number };
  rules: AgentActivationSkillPolicyRule[];
  skills: AgentActivationSkill[];
}): AgentActivationSkillPolicyResponse {
  const skillsByKey = new Map(
    params.skills.map((skill) => [referenceKey(skill.reference), skill]),
  );
  const rules = (disposition: AgentActivationSkillRuleDisposition) =>
    params.rules.filter((rule) => rule.disposition === disposition);
  const visible = (disposition: AgentActivationSkillRuleDisposition) =>
    rules(disposition).filter((rule) =>
      skillsByKey.has(referenceKey(rule.reference)),
    );
  const visibleAllowed = visible("allow");
  const visibleExcluded = visible("exclude");
  return {
    mode: params.state.mode,
    revision: params.state.revision,
    allowedReferences: visibleAllowed.map((rule) => rule.reference),
    excludedReferences: visibleExcluded.map((rule) => rule.reference),
    allowedSkills: displaySkillsForRules(visibleAllowed, skillsByKey),
    excludedSkills: displaySkillsForRules(visibleExcluded, skillsByKey),
    hiddenAllowedCount: rules("allow").length - visibleAllowed.length,
    hiddenExcludedCount: rules("exclude").length - visibleExcluded.length,
  };
}

function displaySkillsForRules(
  rules: AgentActivationSkillPolicyRule[],
  skillsByKey: Map<string, AgentActivationSkill>,
): AgentActivationSkill[] {
  return rules.flatMap((rule) => {
    const skill = skillsByKey.get(referenceKey(rule.reference));
    return skill ? [skill] : [];
  });
}

function normalizeOperations(
  operations: AgentActivationSkillPolicyOperation[],
): AgentActivationSkillPolicyOperation[] {
  const byKey = new Map<string, AgentActivationSkillPolicyOperation>();
  for (const operation of operations) {
    const key = `${operation.disposition}:${referenceKey(operation.reference)}`;
    const previous = byKey.get(key);
    if (previous && previous.op !== operation.op) {
      throw new ApiError(
        422,
        "A skill policy request cannot add and remove the same rule",
      );
    }
    byKey.set(key, operation);
  }
  return [...byKey.values()];
}

function deduplicateRules(
  rules: AgentActivationSkillPolicyRule[],
): AgentActivationSkillPolicyRule[] {
  return [...new Map(rules.map((rule) => [ruleKey(rule), rule])).values()];
}

function assertRuleLimits(rules: AgentActivationSkillPolicyRule[]): void {
  for (const disposition of ["allow", "exclude"] as const) {
    if (
      rules.filter((rule) => rule.disposition === disposition).length > 1000
    ) {
      throw new ApiError(
        422,
        `Activation skill policy cannot contain more than 1000 ${disposition} rules`,
      );
    }
  }
}

function ruleKey(
  rule: Pick<AgentActivationSkillPolicyRule, "disposition" | "reference">,
): string {
  return `${rule.disposition}:${referenceKey(rule.reference)}`;
}

function referenceKey(reference: AgentActivationSkillReference): string {
  switch (reference.source) {
    case "native":
      return JSON.stringify([reference.source, reference.skillId]);
    case "external_mcp":
      return JSON.stringify([
        reference.source,
        reference.mcpServerId,
        reference.uri,
      ]);
    case "plugin":
      return JSON.stringify([
        reference.source,
        reference.pluginId,
        reference.skillPath,
      ]);
  }
}

export const agentActivationSkillPolicyService =
  new AgentActivationSkillPolicyService();

function evaluatorForSnapshot(
  snapshot: AgentActivationSkillPolicySnapshot,
): AgentActivationSkillPolicyEvaluator {
  const activeDisposition = snapshot.mode === "all" ? "exclude" : "allow";
  const activeKeys = new Set(
    snapshot.rules
      .filter((rule) => rule.disposition === activeDisposition)
      .map((rule) => referenceKey(rule.reference)),
  );
  return {
    isReferenceAllowed: (reference) =>
      snapshot.mode === "all"
        ? !activeKeys.has(referenceKey(reference))
        : activeKeys.has(referenceKey(reference)),
  };
}
