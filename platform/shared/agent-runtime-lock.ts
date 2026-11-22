import { z } from "zod";
import {
  type AgentCatalogId,
  agentCatalogIdForImage,
  resolveAgentCatalogId,
} from "./agent-catalog-images";
import { runtimeSupportsClaudeSubscription } from "./model-constants";
import { subscriptionKindForRuntimeCommand } from "./subscription-credentials";

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
});

/**
 * The rule as the API returns it to someone who may configure the runtime or
 * build an agent on it: with the names of the connection and the model,
 * whether they still work, and the models to pick from. The server fills
 * these for a reader who may not read the connection themselves too.
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
 * its agents run on a personal subscription or on a company API key. That
 * is Codex, on ChatGPT, and the maintained Claude Code runtime, on Claude.
 * Every other runtime has the company API key only.
 */
export function agentRuntimeCanNameAccountKind(runtime: {
  command?: readonly string[] | null;
}): boolean {
  return (
    subscriptionKindForRuntimeCommand(runtime.command?.[0]) !== null ||
    runtimeSupportsClaudeSubscription(runtime)
  );
}

/**
 * What a runtime's company account is called. Every text that names the
 * company account takes its words from here, so the server's messages and
 * the web app's labels say the same thing.
 */
export type CompanyAccountWords = {
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

export const COMPANY_ACCOUNT_WORDS: CompanyAccountWords = {
  a: "a company API key",
  the: "the company API key",
  companys: "company's API key",
  short: "API key",
  connection: "connection",
  aConnection: "a connection",
};

/**
 * The settings an administrator chose for a maintained Agent Runtime, laid
 * over the catalog's own. Absent fields keep the catalog value.
 */
export type AgentRuntimeDefaults = Partial<
  Pick<LockableAgentRuntime, "ttlHours" | "maxCostUsd" | "idleTimeoutMinutes">
> & {
  /**
   * The Claude account a new agent starts on when it names none, and the one
   * a locked runtime writes onto its agents. `accounts.kind` is the rule.
   */
  claudeCode?: { authentication: "provider" | "subscription" };
  accounts?: AgentRuntimeAccounts;
};

/**
 * A maintained template's runtime with the organization's defaults applied.
 * The account rule is not one of them: it is read live, and never written
 * onto an agent's runtime, a locked runtime's agents included.
 */
export function withAgentRuntimeDefaults<
  Runtime extends LockableAgentRuntime,
>(params: {
  runtime: Runtime;
  defaults: AgentRuntimeDefaults | null | undefined;
}): Runtime {
  const { claudeCode, accounts: _accounts, ...defaults } = params.defaults ?? {};
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
