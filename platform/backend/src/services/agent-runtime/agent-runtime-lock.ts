import { isDeepStrictEqual } from "node:util";
import {
  AGENT_CATALOG_NAMES,
  buildAgentCatalogRuntime,
  type LockableAgentRuntime,
  resolveAgentRuntimeTemplate,
  withAgentRuntimeDefaults,
  withLockedAgentRuntimeSettings,
} from "@archestra/shared";
import { userHasPermission } from "@/auth/utils";
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
 * locked runtime runs with that runtime's settings, whoever saves it, so the
 * agent forms show them read-only and the agent tools take them as given.
 * Moving an Agent off a locked runtime changes those settings too, so it needs
 * the permission that edits them.
 */
export async function applyAgentRuntimeLock<
  Runtime extends AgentRuntime | null | undefined,
>(params: {
  organizationId: string;
  userId: string;
  runtime: Runtime;
  /** The Agent's saved runtime, when it has one. */
  previous?: AgentRuntime | null;
}): Promise<Runtime> {
  if (!params.runtime) return params.runtime;
  const settings = await AgentRuntimeTemplateModel.getSettings(
    params.organizationId,
  );
  const lock = lockedRuntimeFor({ runtime: params.runtime, settings });
  const left = params.previous
    ? lockedRuntimeFor({ runtime: params.previous, settings })
    : null;
  if (
    left &&
    left.id !== lock?.id &&
    !(await userHasPermission(
      params.userId,
      params.organizationId,
      "organizationSettings",
      "update",
    ))
  ) {
    throw new ApiError(
      403,
      `This agent uses the locked ${left.name} runtime, so only an administrator can move it to another runtime.`,
    );
  }
  return lock
    ? (applyLock({ runtime: params.runtime, lock }) as Runtime)
    : params.runtime;
}

/**
 * Refuse runtime settings that, once locked, would stop an existing Agent of
 * their runtime working with its model, naming those Agents.
 */
export async function assertLockedRuntimesFitAgents(params: {
  organizationId: string;
  userId: string;
  settings: RuntimeTemplateSettings;
  previous: RuntimeTemplateSettings;
}): Promise<void> {
  const changes = lockedRuntimeChanges({
    agents: await AgentModel.findWithRuntime({
      organizationId: params.organizationId,
    }),
    settings: params.settings,
    previous: params.previous,
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
 * Give every existing Agent of a locked runtime that runtime's settings, in
 * the transaction that saves them. An Agent of a custom runtime is found by
 * the image the runtime had before this save too, so changing a locked
 * runtime's image moves its Agents to the new one.
 */
export async function applyLockedRuntimesToAgents(params: {
  organizationId: string;
  settings: RuntimeTemplateSettings;
  previous: RuntimeTemplateSettings;
  tx: Transaction;
}): Promise<void> {
  const changes = lockedRuntimeChanges({
    agents: await AgentModel.findWithRuntime({
      organizationId: params.organizationId,
      tx: params.tx,
    }),
    settings: params.settings,
    previous: params.previous,
  });
  for (const { agent, runtime } of changes) {
    await AgentModel.setRuntime({ id: agent.id, runtime, tx: params.tx });
  }
}

// ===================================================================
// Internal
// ===================================================================

type LockedRuntime = {
  id: string;
  name: string;
  runtime: LockableAgentRuntime;
  /** A custom runtime's image is its own; a maintained one follows the catalog. */
  setsImage: boolean;
};

function applyLock(params: {
  runtime: AgentRuntime;
  lock: LockedRuntime;
}): AgentRuntime {
  const locked = withLockedAgentRuntimeSettings({
    runtime: params.runtime,
    template: params.lock.runtime,
  });
  return params.lock.setsImage
    ? { ...locked, image: params.lock.runtime.image }
    : locked;
}

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
  previous: RuntimeTemplateSettings;
}) {
  return params.agents.flatMap((agent) => {
    const lock = lockedRuntimeFor({
      runtime: agent.runtime,
      settings: params.settings,
      previous: params.previous,
    });
    if (!lock) return [];
    const runtime = applyLock({ runtime: agent.runtime, lock });
    return isDeepStrictEqual(runtime, agent.runtime)
      ? []
      : [{ agent, runtime }];
  });
}

/** The locked Agent Runtime a runtime belongs to, if any. */
function lockedRuntimeFor(params: {
  runtime: LockableAgentRuntime;
  settings: RuntimeTemplateSettings;
  /** Settings being replaced: their custom images still name their runtime. */
  previous?: RuntimeTemplateSettings;
}): LockedRuntime | null {
  const ref = resolveAgentRuntimeTemplate({
    runtime: params.runtime,
    catalogImages: config.agentRuntime.catalogImages,
    customTemplates: [
      ...params.settings.templates,
      ...(params.previous?.templates ?? []),
    ].map(({ id, runtime }) => ({ id, image: runtime.image })),
  });
  if (!ref) return null;
  if (ref.kind === "custom") {
    const template = params.settings.templates.find(({ id }) => id === ref.id);
    return template?.locked
      ? {
          id: template.id,
          name: template.name,
          runtime: template.runtime,
          setsImage: true,
        }
      : null;
  }
  const builtIn = params.settings.builtIns[ref.id];
  if (!builtIn?.locked) return null;
  return {
    id: ref.id,
    name: AGENT_CATALOG_NAMES[ref.id],
    runtime: withAgentRuntimeDefaults({
      runtime: buildAgentCatalogRuntime({
        id: ref.id,
        image: config.agentRuntime.catalogImages[ref.id],
      }),
      defaults: builtIn.settings,
    }),
    setsImage: false,
  };
}
// SPDX-SnippetEnd
