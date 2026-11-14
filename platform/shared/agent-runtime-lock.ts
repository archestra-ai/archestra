import {
  type AgentCatalogId,
  agentCatalogIdForImage,
  resolveAgentCatalogId,
} from "./agent-catalog-images";

/**
 * The runtime settings a locked Agent Runtime decides for every Agent of its
 * type: the launch command, the model protocol, how follow-ups reach a run,
 * the size and limits of its runs, and whose Claude account runs Claude Code.
 * The image is what makes an Agent of that type, so it is not listed here.
 * Credentials, environment values, ports and host access stay per Agent.
 */
export type LockableAgentRuntime = {
  image: string;
  command: string[] | null;
  inferenceProtocol: "openai_responses" | "openai_chat" | "anthropic";
  steerMode: "pipe" | "tmux_keys";
  tier?: string | null;
  maxTier?: string | null;
  ttlHours: number | null;
  maxCostUsd?: number | null;
  idleTimeoutMinutes: number | null;
  claudeCode?: {
    authentication: "provider" | "subscription";
    model?: string;
  };
};

/**
 * The settings an administrator chose for a maintained Agent Runtime, laid
 * over the catalog's own. Absent fields keep the catalog value.
 */
export type AgentRuntimeDefaults = Partial<
  Pick<
    LockableAgentRuntime,
    "tier" | "maxTier" | "ttlHours" | "maxCostUsd" | "idleTimeoutMinutes"
  >
> & { claudeCode?: { authentication: "provider" | "subscription" } };

/** A maintained template's runtime with the organization's defaults applied. */
export function withAgentRuntimeDefaults<
  Runtime extends LockableAgentRuntime,
>(params: {
  runtime: Runtime;
  defaults: AgentRuntimeDefaults | null | undefined;
}): Runtime {
  const { claudeCode, ...defaults } = params.defaults ?? {};
  return {
    ...params.runtime,
    ...defaults,
    ...(claudeCode &&
      params.runtime.claudeCode && {
        claudeCode: {
          ...params.runtime.claudeCode,
          authentication: claudeCode.authentication,
        },
      }),
  };
}

/** Which Agent Runtime a saved runtime belongs to. */
export type AgentRuntimeTemplateRef =
  | { kind: "built-in"; id: AgentCatalogId }
  | { kind: "custom"; id: string };

/**
 * The Agent Runtime a saved runtime is an Agent of. A runtime stores no
 * template id, so it is recognised by its image, then by its wrapper command:
 * a maintained catalog image, then a custom runtime's image, then a
 * maintained wrapper. That order keeps a locked runtime's image locked
 * whatever command an agent sets.
 */
export function resolveAgentRuntimeTemplate(params: {
  runtime: Pick<LockableAgentRuntime, "image" | "command">;
  catalogImages: Record<AgentCatalogId, string>;
  customTemplates: readonly { id: string; image: string }[];
}): AgentRuntimeTemplateRef | null {
  const catalogImage = agentCatalogIdForImage({
    image: params.runtime.image,
    catalogImages: params.catalogImages,
  });
  if (catalogImage) return { kind: "built-in", id: catalogImage };
  const custom = params.customTemplates.find(
    (template) => template.image.trim() === params.runtime.image.trim(),
  );
  if (custom) return { kind: "custom", id: custom.id };
  const wrapper = resolveAgentCatalogId(params.runtime);
  return wrapper ? { kind: "built-in", id: wrapper } : null;
}

/** The runtime with its locked template's settings applied. */
export function withLockedAgentRuntimeSettings<
  Runtime extends LockableAgentRuntime,
>(params: { runtime: Runtime; template: LockableAgentRuntime }): Runtime {
  const { runtime, template } = params;
  return {
    ...runtime,
    command: template.command,
    inferenceProtocol: template.inferenceProtocol,
    steerMode: template.steerMode,
    tier: template.tier ?? null,
    maxTier: template.maxTier ?? null,
    ttlHours: template.ttlHours,
    maxCostUsd: template.maxCostUsd ?? null,
    idleTimeoutMinutes: template.idleTimeoutMinutes,
    // A runtime that sets no Claude account leaves the agent's own.
    ...(template.claudeCode && {
      claudeCode: {
        ...runtime.claudeCode,
        authentication: template.claudeCode.authentication,
      },
    }),
  };
}
