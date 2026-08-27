"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { KeyRound } from "lucide-react";
import { ModelSelectorLogo } from "@/components/ai-elements/model-selector";
import type { OverviewFact } from "@/components/overview-summary";
import {
  useAgentSkillExclusions,
  useAgentSkills,
} from "@/lib/agent-skills.query";
import { useAgentToolExclusions } from "@/lib/agent-tool-exclusions.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useEnvironments } from "@/lib/environment.query";
import { useOrganizationDefaultModel } from "@/lib/hooks/use-organization-default-model";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import { useAvailableLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { useDefaultEnvironment } from "@/lib/organization.query";
import { providerToLogoProvider } from "@/lib/provider-logos";
import type { AgentPageKind } from "./agent-page-config";

type Agent = archestraApiTypes.GetAgentResponses["200"];

/**
 * The key configuration of an agent-shaped record, as one row of facts for
 * the detail page's Overview.
 *
 * This used to be a read-only mirror of every step of the record's edit
 * wizard — one card per step, each listing its servers, subagents and skills
 * by name — behind a collapsed section. It answered a click with a second
 * copy of the form the header's Edit already opens, so what it added over
 * that link was the handful of values below. The named lists live in the
 * wizard, which is where they can also be changed.
 */
export function useAgentOverviewFacts({
  kind,
  agent,
}: {
  kind: AgentPageKind;
  agent: Agent;
}): OverviewFact[] {
  const isBuiltIn = !!agent.builtIn;
  // The model is a chat agent's business — built-in ones included, as on the
  // form; gateways answer with whatever the caller sends.
  const showsModel = kind === "agent";
  // Gateways carry their environment as a header badge, so repeating it here
  // would be the same value twice on one screen.
  const showsEnvironment = kind === "agent" && !isBuiltIn;
  const showsTools = !isBuiltIn;
  // Publishing skills over `skill://` is a gateway surface — an agent has no
  // MCP client to serve them to — so the fact belongs on the gateway pages
  // only. Legacy `profile` rows render under `mcp_gateway`, so they keep it.
  const showsSkills = kind === "mcp_gateway" && !isBuiltIn;

  const model = useModelFact({ agent, enabled: showsModel });
  const environment = useEnvironmentFact({ agent, enabled: showsEnvironment });
  const tools = useToolsFact({ agent, enabled: showsTools });
  const skills = useSkillsFact({ agent, enabled: showsSkills });

  return [...model, ...environment, ...tools, ...skills];
}

// ===========================================================================
// One fact each. Every hook runs unconditionally and takes `enabled` instead
// of being called conditionally, so the hook order is the same on every
// render; a fact that does not apply to this record answers with [].
// ===========================================================================

/**
 * The model and the provider key, as the form's two pickers show them: the
 * model with its provider's logo, and the key — "Organization default" when
 * none is picked. A record without a model of its own names the model the
 * organization default currently points at.
 */
function useModelFact({
  agent,
  enabled,
}: {
  agent: Agent;
  enabled: boolean;
}): OverviewFact[] {
  const providerCatalog = useModelProviderCatalog();
  const hasOwnModel = !!(agent.resolvedLlmModelName || agent.modelId);
  const { data: canReadKeys } = useHasPermissions({
    llmProviderApiKey: ["read"],
  });
  const { data: keys } = useAvailableLlmProviderApiKeys({
    includeKeyId: agent.llmApiKeyId ?? undefined,
    enabled: enabled && !!agent.llmApiKeyId && !!canReadKeys,
  });
  const organizationDefault = useOrganizationDefaultModel({
    enabled: enabled && !hasOwnModel,
  });

  if (!enabled) return [];

  const key = agent.llmApiKeyId
    ? keys?.find((candidate) => candidate.id === agent.llmApiKeyId)
    : undefined;
  const provider = hasOwnModel
    ? (agent.resolvedLlmProvider ?? null)
    : (organizationDefault.model?.provider ?? null);
  const modelName = hasOwnModel
    ? [
        agent.resolvedLlmProvider
          ? providerCatalog.label(agent.resolvedLlmProvider)
          : null,
        agent.resolvedLlmModelName ?? agent.modelId,
      ]
        .filter(Boolean)
        .join(" · ")
    : organizationDefault.label;

  return [
    {
      label: "Model",
      value: (
        <span className="flex min-w-0 items-center gap-1.5">
          {provider && (
            <ModelSelectorLogo
              provider={providerToLogoProvider[provider]}
              className="size-3.5 shrink-0"
            />
          )}
          <span>{modelName || "Best available model"}</span>
        </span>
      ),
    },
    {
      label: "API key",
      value: (
        <span className="flex items-center gap-1.5">
          <KeyRound aria-hidden className="size-3 shrink-0" />
          <span>
            {agent.llmApiKeyId
              ? (key?.name ?? "Provider key")
              : "Organization default"}
          </span>
        </span>
      ),
    },
  ];
}

function useEnvironmentFact({
  agent,
  enabled,
}: {
  agent: Agent;
  enabled: boolean;
}): OverviewFact[] {
  const { data: environmentsData } = useEnvironments();
  const defaultEnvironment = useDefaultEnvironment();

  if (!enabled) return [];

  const environmentName = agent.environmentId
    ? (environmentsData?.environments.find((e) => e.id === agent.environmentId)
        ?.name ?? null)
    : defaultEnvironment.name;

  return [
    {
      label: "Environment",
      value: environmentName ? (
        <span>{environmentName}</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
    },
  ];
}

/**
 * Auto or Custom, and how much of each. `agent.tools` carries the delegation
 * rows too (one per subagent); counting them here would inflate the tool
 * count the list pages show for the same record.
 */
function useToolsFact({
  agent,
  enabled,
}: {
  agent: Agent;
  enabled: boolean;
}): OverviewFact[] {
  const { data: exclusions } = useAgentToolExclusions(
    enabled && agent.accessAllTools ? agent.id : undefined,
  );

  if (!enabled) return [];

  if (agent.accessAllTools) {
    const excluded = exclusions?.excludedToolIds.length ?? 0;
    return [
      {
        label: "Tools",
        value: (
          <span>
            {excluded > 0
              ? `Auto — all tools, ${excluded} disabled`
              : "Auto — all tools"}
          </span>
        ),
      },
    ];
  }

  const assigned = agent.tools.filter((tool) => !tool.delegateToAgentId);
  const servers = new Set(assigned.map((tool) => tool.catalogId ?? "")).size;
  return [
    {
      label: "Tools",
      value: (
        <span>
          {assigned.length === 0
            ? "None assigned"
            : `${assigned.length} from ${servers} ${servers === 1 ? "server" : "servers"}`}
        </span>
      ),
    },
  ];
}

function useSkillsFact({
  agent,
  enabled,
}: {
  agent: Agent;
  enabled: boolean;
}): OverviewFact[] {
  const skillsEnabled = useFeature("mcpGatewaySkillsEnabled") === true;
  const { data: canReadSkills } = useHasPermissions({ skill: ["read"] });
  const reads = enabled && skillsEnabled && !!canReadSkills;
  const { data: assignments } = useAgentSkills(reads ? agent.id : undefined);
  const { data: exclusions } = useAgentSkillExclusions(
    reads ? agent.id : undefined,
  );

  // Nothing to say until the published set has actually loaded: a zero here
  // would read as "publishes nothing", which is a real setting.
  if (!reads || !assignments) return [];

  if (assignments.accessAllSkills) {
    const excluded = exclusions?.skills.length ?? 0;
    return [
      {
        label: "Published skills",
        value: (
          <span>
            {excluded > 0
              ? `Auto — all skills, ${excluded} excluded`
              : "Auto — all skills"}
          </span>
        ),
      },
    ];
  }

  const published = assignments.skills ?? [];
  return [
    {
      label: "Published skills",
      value: (
        <span>
          {published.length === 0 ? "None published" : `${published.length}`}
        </span>
      ),
    },
  ];
}
