import { isDeepStrictEqual } from "node:util";
import {
  buildAgentCatalogRuntime,
  hasLockedAgentRuntimeSettings,
  type LockableAgentRuntime,
  resolveAgentRuntimeTemplate,
  withAgentRuntimeDefaults,
  withLockedAgentRuntimeSettings,
} from "@archestra/shared";
import config from "@/config";
import type { Transaction } from "@/database";
import { AgentModel } from "@/models";
import AgentRuntimeTemplateModel from "@/models/agent-runtime-template";
import type { AgentRuntime } from "@/types";
import { ApiError } from "@/types";
import type { RuntimeTemplateSettings } from "@/types/agent-runtime-template";
import { assertAgentRuntimeModelCompatibility } from "./agent-config-validation";

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise

/**
 * A runtime with its Agent Runtime's locked settings applied. Every Agent of a
 * locked runtime's type runs with that runtime's settings, whoever saves it,
 * so the agent forms show them read-only and the agent tools take them as given.
 */
export async function applyAgentRuntimeLock<
  Runtime extends AgentRuntime | null | undefined,
>(params: { organizationId: string; runtime: Runtime }): Promise<Runtime> {
  if (!params.runtime) return params.runtime;
  const template = lockedTemplateFor({
    runtime: params.runtime,
    settings: await AgentRuntimeTemplateModel.getSettings(
      params.organizationId,
    ),
  });
  return template
    ? withLockedAgentRuntimeSettings({ runtime: params.runtime, template })
    : params.runtime;
}

/**
 * Refuse runtime settings that, once locked, would stop an existing Agent of
 * their type working with its model, naming those Agents.
 */
export async function assertLockedRuntimesFitAgents(params: {
  organizationId: string;
  userId: string;
  settings: RuntimeTemplateSettings;
}): Promise<void> {
  const changes = lockedRuntimeChanges({
    agents: await AgentModel.findWithRuntime(params),
    settings: params.settings,
  });
  const incompatible: string[] = [];
  for (const { agent, runtime } of changes) {
    // Only the settings that choose a model API can break an Agent's model.
    if (isDeepStrictEqual(modelSettings(runtime), modelSettings(agent.runtime)))
      continue;
    try {
      await assertAgentRuntimeModelCompatibility({
        runtime,
        agent,
        organizationId: params.organizationId,
        userId: params.userId,
        selectsModel: false,
      });
    } catch (error) {
      if (!(error instanceof ApiError) || error.statusCode !== 409) throw error;
      incompatible.push(agent.name);
    }
  }
  if (incompatible.length > 0) {
    throw new ApiError(
      409,
      `These locked settings don't work with the model of: ${incompatible.join(", ")}. Change those agents' model first, or unlock the runtime.`,
    );
  }
}

/**
 * Give every existing Agent of a locked runtime's type that runtime's
 * settings, in the transaction that saves them.
 */
export async function applyLockedRuntimesToAgents(params: {
  organizationId: string;
  settings: RuntimeTemplateSettings;
  tx: Transaction;
}): Promise<void> {
  const changes = lockedRuntimeChanges({
    agents: await AgentModel.findWithRuntime(params),
    settings: params.settings,
  });
  for (const { agent, runtime } of changes) {
    await AgentModel.setRuntime({ id: agent.id, runtime, tx: params.tx });
  }
}

// ===================================================================
// Internal
// ===================================================================

function modelSettings(runtime: AgentRuntime) {
  return [
    runtime.command,
    runtime.inferenceProtocol,
    runtime.claudeCode?.authentication,
  ];
}

/** The Agents whose runtime differs from their locked runtime's settings. */
function lockedRuntimeChanges<Agent extends { runtime: AgentRuntime }>(params: {
  agents: Agent[];
  settings: RuntimeTemplateSettings;
}) {
  return params.agents.flatMap((agent) => {
    const template = lockedTemplateFor({
      runtime: agent.runtime,
      settings: params.settings,
    });
    return template &&
      !hasLockedAgentRuntimeSettings({ runtime: agent.runtime, template })
      ? [
          {
            agent,
            runtime: withLockedAgentRuntimeSettings({
              runtime: agent.runtime,
              template,
            }),
          },
        ]
      : [];
  });
}

/** The settings of the locked Agent Runtime a runtime is an Agent of, if any. */
function lockedTemplateFor(params: {
  runtime: LockableAgentRuntime;
  settings: RuntimeTemplateSettings;
}): LockableAgentRuntime | null {
  const ref = resolveAgentRuntimeTemplate({
    runtime: params.runtime,
    catalogImages: config.agentRuntime.catalogImages,
    customTemplates: params.settings.templates.map(({ id, runtime }) => ({
      id,
      image: runtime.image,
    })),
  });
  if (!ref) return null;
  if (ref.kind === "custom") {
    const template = params.settings.templates.find(({ id }) => id === ref.id);
    return template?.locked ? template.runtime : null;
  }
  const builtIn = params.settings.builtIns[ref.id];
  if (!builtIn?.locked) return null;
  return withAgentRuntimeDefaults({
    runtime: buildAgentCatalogRuntime({
      id: ref.id,
      image: config.agentRuntime.catalogImages[ref.id],
    }),
    defaults: builtIn.settings,
  });
}
// SPDX-SnippetEnd
