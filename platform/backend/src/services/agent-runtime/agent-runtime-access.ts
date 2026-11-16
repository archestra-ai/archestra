import { isDeepStrictEqual } from "node:util";
import {
  AGENT_CATALOG_NAMES,
  agentRuntimePermissionScope,
  buildAgentCatalogRuntime,
  hasScopedPermission,
  PopularAgentIdSchema,
  resolveAgentRuntimeTemplate,
  type TemplatedAgentRuntime,
  withAgentRuntimeDefaults,
  withAgentRuntimeTemplateSettings,
} from "@archestra/shared";
import config from "@/config";
import { withDbTransaction } from "@/database";
import { AgentModel } from "@/models";
import AgentRuntimeTemplateModel from "@/models/agent-runtime-template";
import { ResourcePermissions } from "@/services/resource-permissions";
import type { AgentRuntime } from "@/types";
import { ApiError } from "@/types";
import type { RuntimeTemplateSettings } from "@/types/agent-runtime-template";
import { assertAgentRuntimeModelCompatibility } from "./agent-config-validation";

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise

/**
 * The runtime an agent save may store. Putting an agent on an Agent Runtime,
 * or changing the runtime of an agent already on one, needs `use` on that
 * runtime. Without `configure` on it the agent takes the runtime's own
 * settings; its environment, credentials and ports stay its own. A runtime
 * that is none of the organization's runtimes is free-form, so it needs
 * `configure` on every runtime.
 */
export async function applyAgentRuntimeAccess<
  Runtime extends AgentRuntime | null | undefined,
>(params: {
  organizationId: string;
  userId: string;
  runtime: Runtime;
  /** The agent's saved runtime, when it has one. */
  previous?: AgentRuntime | null;
}): Promise<Runtime> {
  // An omitted or unchanged runtime keeps what is saved, so ordinary edits
  // still work after someone loses access to the agent's runtime.
  if (
    params.runtime === undefined ||
    isDeepStrictEqual(params.runtime, params.previous ?? null)
  )
    return params.runtime;
  const settings = await AgentRuntimeTemplateModel.getSettings(
    params.organizationId,
  );
  if (params.previous) {
    const left = agentRuntimeFor({ runtime: params.previous, settings });
    await requireRuntimeAction({
      ...params,
      runtime: left,
      action: left ? "use" : "configure",
    });
  }
  if (params.runtime === null) return params.runtime;
  const target = agentRuntimeFor({ runtime: params.runtime, settings });
  if (!target) {
    await requireRuntimeAction({
      ...params,
      runtime: null,
      action: "configure",
    });
    return params.runtime;
  }
  const { configure } = await requireRuntimeAction({
    ...params,
    runtime: target,
    action: "use",
  });
  return configure
    ? params.runtime
    : (withRuntimeSettings({ runtime: params.runtime, target }) as Runtime);
}

/** Copying an agent needs `use` on its runtime; the copy keeps its settings. */
export async function assertCanUseAgentRuntime(params: {
  organizationId: string;
  userId: string;
  runtime: AgentRuntime | null;
}): Promise<void> {
  if (!params.runtime) return;
  const settings = await AgentRuntimeTemplateModel.getSettings(
    params.organizationId,
  );
  const target = agentRuntimeFor({ runtime: params.runtime, settings });
  await requireRuntimeAction({
    ...params,
    runtime: target,
    action: target ? "use" : "configure",
  });
}

/**
 * Which Agent Runtimes the caller may put agents on and configure, and
 * whether they may run an image that is none of them.
 */
export async function listAgentRuntimeAccess(params: {
  organizationId: string;
  userId: string;
}): Promise<{
  runtimes: { id: string; canUse: boolean; canConfigure: boolean }[];
  canConfigureAny: boolean;
}> {
  const { templates } = await AgentRuntimeTemplateModel.getSettings(
    params.organizationId,
  );
  const runtimes = [
    ...PopularAgentIdSchema.options.map((id) => ({
      id,
      scope: agentRuntimePermissionScope({ kind: "built-in", id }),
    })),
    ...templates.map(({ id }) => ({ id, scope: id })),
  ];
  const scopes = runtimes.map(({ scope }) => scope);
  const [usable, configurable, any] = await Promise.all([
    ResourcePermissions.getPermittedIds({
      ...params,
      resource: "agentRuntime",
      scopes,
      action: "use",
    }),
    ResourcePermissions.getPermittedIds({
      ...params,
      resource: "agentRuntime",
      scopes,
      action: "configure",
    }),
    runtimeActions({ ...params, scope: "*" }),
  ]);
  return {
    runtimes: runtimes.map(({ id, scope }) => ({
      id,
      canUse: usable.has(scope),
      canConfigure: configurable.has(scope),
    })),
    canConfigureAny: any.configure,
  };
}

/** How many existing agents of one Agent Runtime differ from its settings. */
export async function countAgentsBehindRuntime(params: {
  organizationId: string;
  runtimeId: string;
}): Promise<number> {
  const settings = await AgentRuntimeTemplateModel.getSettings(
    params.organizationId,
  );
  const target = runtimeById({ id: params.runtimeId, settings });
  if (!target) throw new ApiError(404, "Agent Runtime not found");
  return runtimeChanges({
    agents: await AgentModel.findWithRuntime({
      organizationId: params.organizationId,
    }),
    settings,
    target,
  }).length;
}

/**
 * Give every existing agent of one Agent Runtime that runtime's current
 * settings. Refuses, naming them, when the new settings would stop agents
 * working with their model.
 */
export async function applyAgentRuntimeToAgents(params: {
  organizationId: string;
  userId: string;
  runtimeId: string;
}): Promise<{ name: string; agents: { id: string; name: string }[] }> {
  const settings = await AgentRuntimeTemplateModel.getSettings(
    params.organizationId,
  );
  const target = runtimeById({ id: params.runtimeId, settings });
  if (!target) throw new ApiError(404, "Agent Runtime not found");
  const changes = runtimeChanges({
    agents: await AgentModel.findWithRuntime({
      organizationId: params.organizationId,
    }),
    settings,
    target,
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
      `These settings don't work with the model of: ${incompatible.join(", ")}. Change those agents' model first.`,
    );
  }
  // Re-read the agents under row locks, so an agent saved meanwhile is
  // updated from what it now holds rather than from the read above.
  return withDbTransaction(async (tx) => {
    const current = runtimeChanges({
      agents: await AgentModel.findWithRuntime({
        organizationId: params.organizationId,
        tx,
      }),
      settings,
      target,
    });
    for (const { agent, runtime } of current) {
      await AgentModel.setRuntime({ id: agent.id, runtime, tx });
    }
    return {
      name: target.name,
      agents: current.map(({ agent }) => ({ id: agent.id, name: agent.name })),
    };
  });
}

// ===================================================================
// Internal
// ===================================================================

type AgentRuntimeTarget = {
  id: string;
  scope: string;
  name: string;
  runtime: TemplatedAgentRuntime;
  /** A custom runtime's image is its own; a maintained one follows the catalog. */
  setsImage: boolean;
};

async function runtimeActions(params: {
  organizationId: string;
  userId: string;
  scope: string;
}): Promise<{ use: boolean; configure: boolean }> {
  const context = {
    userId: params.userId,
    organizationId: params.organizationId,
    resource: "agentRuntime" as const,
    scope: params.scope,
  };
  const grants = await ResourcePermissions.resolve(context);
  return {
    use: hasScopedPermission({
      grants,
      required: { ...context, action: "use" },
    }),
    configure: hasScopedPermission({
      grants,
      required: { ...context, action: "configure" },
    }),
  };
}

async function requireRuntimeAction(params: {
  organizationId: string;
  userId: string;
  /** Null for an image that is none of the organization's runtimes. */
  runtime: AgentRuntimeTarget | null;
  action: "use" | "configure";
}): Promise<{ use: boolean; configure: boolean }> {
  const actions = await runtimeActions({
    ...params,
    scope: params.runtime?.scope ?? "*",
  });
  if (actions[params.action]) return actions;
  throw new ApiError(
    403,
    params.runtime
      ? `You don't have permission to use the ${params.runtime.name} runtime.`
      : "Only people who can configure every Agent Runtime can run an image that isn't one of the organization's runtimes.",
  );
}

function withRuntimeSettings(params: {
  runtime: AgentRuntime;
  target: AgentRuntimeTarget;
}): AgentRuntime {
  const runtime = withAgentRuntimeTemplateSettings({
    runtime: params.runtime,
    template: params.target.runtime,
  });
  return params.target.setsImage
    ? { ...runtime, image: params.target.runtime.image }
    : runtime;
}

function modelSettings(runtime: AgentRuntime) {
  return [
    runtime.command,
    runtime.inferenceProtocol,
    runtime.claudeCode?.authentication,
  ];
}

/** The agents of `target` whose runtime differs from its settings. */
function runtimeChanges<Agent extends { runtime: AgentRuntime }>(params: {
  agents: Agent[];
  settings: RuntimeTemplateSettings;
  target: AgentRuntimeTarget;
}) {
  return params.agents.flatMap((agent) => {
    if (
      agentRuntimeFor({ runtime: agent.runtime, settings: params.settings })
        ?.id !== params.target.id
    )
      return [];
    const runtime = withRuntimeSettings({
      runtime: agent.runtime,
      target: params.target,
    });
    return isDeepStrictEqual(runtime, agent.runtime)
      ? []
      : [{ agent, runtime }];
  });
}

/** The Agent Runtime a saved runtime belongs to, if any. */
function agentRuntimeFor(params: {
  runtime: TemplatedAgentRuntime;
  settings: RuntimeTemplateSettings;
}): AgentRuntimeTarget | null {
  const ref = resolveAgentRuntimeTemplate({
    runtime: params.runtime,
    catalogImages: config.agentRuntime.catalogImages,
    customTemplates: params.settings.templates.map(({ id, runtime }) => ({
      id,
      image: runtime.image,
    })),
  });
  return ref ? runtimeById({ id: ref.id, settings: params.settings }) : null;
}

function runtimeById(params: {
  id: string;
  settings: RuntimeTemplateSettings;
}): AgentRuntimeTarget | null {
  const builtIn = PopularAgentIdSchema.safeParse(params.id);
  if (builtIn.success) {
    const id = builtIn.data;
    return {
      id,
      scope: agentRuntimePermissionScope({ kind: "built-in", id }),
      name: AGENT_CATALOG_NAMES[id],
      runtime: withAgentRuntimeDefaults({
        runtime: buildAgentCatalogRuntime({
          id,
          image: config.agentRuntime.catalogImages[id],
        }),
        defaults: params.settings.builtIns[id]?.settings,
      }),
      setsImage: false,
    };
  }
  const template = params.settings.templates.find(({ id }) => id === params.id);
  return template
    ? {
        id: template.id,
        scope: template.id,
        name: template.name,
        runtime: template.runtime,
        setsImage: true,
      }
    : null;
}
// SPDX-SnippetEnd
