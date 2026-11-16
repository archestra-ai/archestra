import {
  type AgentCatalogId,
  agentCatalogIdForImage,
  resolveAgentCatalogId,
} from "./agent-catalog-images";

/**
 * The settings an Agent Runtime decides for an Agent whose builder may use the
 * runtime but not configure it: the launch command, the model protocol, how
 * follow-ups reach a run, the size and limits of its runs, and whose Claude
 * account runs Claude Code. The image is what makes an Agent of that type, so
 * it is not listed here. Credentials, environment values, ports and host
 * access stay per Agent.
 */
export type TemplatedAgentRuntime = {
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
    TemplatedAgentRuntime,
    "tier" | "maxTier" | "ttlHours" | "maxCostUsd" | "idleTimeoutMinutes"
  >
> & { claudeCode?: { authentication: "provider" | "subscription" } };

/** A maintained template's runtime with the organization's defaults applied. */
export function withAgentRuntimeDefaults<
  Runtime extends TemplatedAgentRuntime,
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
 * maintained wrapper. That order keeps an agent on a maintained image on its
 * built-in runtime whatever command it sets.
 */
export function resolveAgentRuntimeTemplate(params: {
  runtime: Pick<TemplatedAgentRuntime, "image" | "command">;
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

/**
 * The permission scope of an Agent Runtime: a custom runtime's own id, or a
 * fixed id per maintained runtime, since permission scopes are UUIDs.
 */
export function agentRuntimePermissionScope(
  ref: AgentRuntimeTemplateRef,
): string {
  return ref.kind === "custom" ? ref.id : BUILT_IN_AGENT_RUNTIME_SCOPES[ref.id];
}

/** The maintained runtime a permission scope names, if any. */
export function builtInAgentRuntimeForScope(
  scope: string,
): AgentCatalogId | null {
  return (
    (Object.entries(BUILT_IN_AGENT_RUNTIME_SCOPES).find(
      ([, id]) => id === scope,
    )?.[0] as AgentCatalogId | undefined) ?? null
  );
}

/** The runtime with its Agent Runtime's own settings applied. */
export function withAgentRuntimeTemplateSettings<
  Runtime extends TemplatedAgentRuntime,
>(params: { runtime: Runtime; template: TemplatedAgentRuntime }): Runtime {
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

const BUILT_IN_AGENT_RUNTIME_SCOPES: Record<AgentCatalogId, string> = {
  "claude-code": "00000000-0000-4000-8000-0000a7000001",
  codex: "00000000-0000-4000-8000-0000a7000002",
  opencode: "00000000-0000-4000-8000-0000a7000003",
  hermes: "00000000-0000-4000-8000-0000a7000004",
  openclaw: "00000000-0000-4000-8000-0000a7000005",
  grok: "00000000-0000-4000-8000-0000a7000006",
  kimi: "00000000-0000-4000-8000-0000a7000007",
  copilot: "00000000-0000-4000-8000-0000a7000008",
};
