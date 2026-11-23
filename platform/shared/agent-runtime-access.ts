import { z } from "zod";
import {
  type AgentCatalogId,
  agentCatalogIdForImage,
  resolveAgentCatalogId,
  runtimeSupportsClaudeSubscription,
} from "./agent-catalog-images";
import { isCopilotRuntimeCommand } from "./model-constants";
import { subscriptionKindForRuntimeCommand } from "./subscription-credentials";

/**
 * The settings an Agent Runtime decides for an Agent whose builder may use the
 * runtime but not configure it: the launch command, the model protocol, how
 * follow-ups reach a run, and the size and limits of its runs. The image is
 * what makes an Agent of that type, so it is not listed here. Credentials,
 * environment values, ports and host access stay per Agent. Its `claudeCode`
 * decides nothing for an existing Agent: it declares that the image runs
 * Claude Code and is the Claude account a new Agent starts on.
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
 * The account rule in a runtime's settings, as it is stored and written. It
 * applies at once to every agent on the runtime, for every person, whatever
 * the agent stores, and is never written onto an agent: a named kind is the
 * account lock of each of them, and a fixed connection and model are what
 * their company option runs on. On a custom runtime it sits beside the
 * template's runtime; on a maintained one, in its settings. Absent, the
 * runtime leaves all of it to each agent.
 */
export const AgentRuntimeAccountsSchema = z.object({
  /**
   * The one account kind the runtime names, where its agents have two (see
   * `agentRuntimeCanNameAccountKind`). Absent leaves the kind to each agent.
   */
  kind: z.enum(["subscription", "key"]).optional(),
  /**
   * The company connection (`agents.llm_api_key_id`) every agent of the
   * runtime runs on. Absent, each agent's own.
   */
  llmApiKeyId: z.string().uuid().optional(),
  /**
   * The model (`agents.model_id`) of that connection every agent of the
   * runtime runs. Absent, each agent's own, which must be one of the
   * connection's models.
   */
  modelId: z.string().uuid().optional(),
  /**
   * Where the runtime sets no connection: the model each company connection
   * runs on every agent of the runtime, by connection id. A connection that
   * is not listed leaves its model to each agent.
   */
  connectionModels: z
    .record(z.string().uuid(), z.string().uuid())
    .refine((models) => Object.keys(models).length <= 50, {
      message: "At most 50 connections can have a model set.",
    })
    .optional(),
});

/**
 * The rule as the API returns it to someone who may use or configure the
 * runtime: with the names of the connection and the model, whether they
 * still work, and the models to pick from. The server fills these for a
 * reader who may not read the connection themselves too.
 */
export const AgentRuntimeAccountsViewSchema = AgentRuntimeAccountsSchema.extend(
  {
    keyName: z.string().optional(),
    keyProvider: z.string().optional(),
    modelName: z.string().optional(),
    /**
     * The connection was deleted, became someone's own or no longer serves
     * the runtime: its agents' company option is refused until an
     * administrator chooses another.
     */
    keyMissing: z.boolean().optional(),
    /** The same for the model: deleted, or no longer one of the connection's. */
    modelMissing: z.boolean().optional(),
    /**
     * The names of the models in `connectionModels`, by connection id, for
     * a reader who may not list the connection's models themselves.
     */
    connectionModelNames: z.record(z.string(), z.string()).optional(),
    /**
     * With a connection fixed and no model: the connection's models that
     * run on this runtime, for whoever builds an agent to pick from.
     */
    models: z
      .array(
        z.object({
          /** The model's id, as an agent stores it in `modelId`. */
          id: z.string(),
          /** The model's name at its provider. */
          modelId: z.string(),
          displayName: z.string(),
          provider: z.string(),
        }),
      )
      .optional(),
  },
);
/** A runtime's account rule as its settings store it. Its view adds names. */
export type AgentRuntimeAccounts = z.infer<typeof AgentRuntimeAccountsSchema>;

/**
 * Whether a runtime's settings may name one account kind in `accounts.kind`:
 * its agents run on a personal subscription or on a company option. That is
 * Codex, Grok Build and the Copilot CLI, with a subscription of their own,
 * and a Claude runtime: the maintained Claude Code runtime, or a custom
 * image that declares Claude Code. Every other runtime has the company
 * option only.
 */
export function agentRuntimeCanNameAccountKind(runtime: {
  command?: readonly string[] | null;
  claudeCode?: { authentication: "provider" | "subscription" } | null;
}): boolean {
  return (
    subscriptionKindForRuntimeCommand(runtime.command?.[0]) !== null ||
    runtimeSupportsClaudeSubscription(runtime)
  );
}

/**
 * What a runtime's company account is called. Most runtimes run it on a
 * provider API key, through a connection. The GitHub Copilot CLI has no
 * provider API key: its company account is an enterprise plan the
 * organization connected. Every text that names the company account takes
 * its words from here, so the server's messages and the web app's labels
 * say the same thing.
 */
export type CompanyAccountWords = {
  /** The company account is an enterprise plan, not an API key. */
  plan: boolean;
  /** As one of two accounts: "a company API key". */
  a: string;
  /** As the one the agent has: "the company API key". */
  the: string;
  /** After "Uses": "company's API key". */
  companys: string;
  /** In a button: "API key". */
  short: string;
  /** What is chosen for it: "connection". */
  connection: string;
  /** The same with its article: "a connection". */
  aConnection: string;
};

const API_KEY_WORDS: CompanyAccountWords = {
  plan: false,
  a: "a company API key",
  the: "the company API key",
  companys: "company's API key",
  short: "API key",
  connection: "connection",
  aConnection: "a connection",
};

const ENTERPRISE_PLAN_WORDS: CompanyAccountWords = {
  plan: true,
  a: "the company's enterprise plan",
  the: "the company's enterprise plan",
  companys: "company's enterprise plan",
  short: "enterprise plan",
  connection: "plan",
  aConnection: "a plan",
};

export function companyAccountWords(
  runtimeCommand: string | null | undefined,
): CompanyAccountWords {
  return isCopilotRuntimeCommand(runtimeCommand)
    ? ENTERPRISE_PLAN_WORDS
    : API_KEY_WORDS;
}

/**
 * The settings an administrator chose for a maintained Agent Runtime, laid
 * over the catalog's own. Absent fields keep the catalog value.
 */
export type AgentRuntimeDefaults = Partial<
  Pick<
    TemplatedAgentRuntime,
    "tier" | "maxTier" | "ttlHours" | "maxCostUsd" | "idleTimeoutMinutes"
  >
> & {
  /**
   * The Claude account a new agent starts on when it names none. It is not
   * a rule and restricts nothing: `accounts.kind` is the rule.
   */
  claudeCode?: { authentication: "provider" | "subscription" };
  accounts?: AgentRuntimeAccounts;
};

/**
 * A maintained template's runtime with the organization's defaults applied.
 * A Claude runtime that names an account kind starts its agents on the
 * Claude account of that kind.
 */
export function withAgentRuntimeDefaults<
  Runtime extends TemplatedAgentRuntime,
>(params: {
  runtime: Runtime;
  defaults: AgentRuntimeDefaults | null | undefined;
}): Runtime {
  // The account rule says what the runtime decides for its agents; it is
  // never part of an agent's own runtime.
  const { claudeCode, accounts, ...defaults } = params.defaults ?? {};
  const authentication = accounts?.kind
    ? accounts.kind === "subscription"
      ? ("subscription" as const)
      : ("provider" as const)
    : claudeCode?.authentication;
  return {
    ...params.runtime,
    ...defaults,
    ...(authentication &&
      params.runtime.claudeCode && {
        claudeCode: { ...params.runtime.claudeCode, authentication },
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

/**
 * The runtime with its Agent Runtime's own settings applied. The agent's
 * Claude account is not one of them: a Claude account in a runtime's
 * settings only starts new agents, and is never laid over an agent's own.
 */
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
