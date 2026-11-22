import {
  AgentRuntimeAccountsViewSchema,
  SubscriptionCredentialKindSchema,
} from "@archestra/shared";
import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import agentRuntimeUserAccountsTable from "@/database/agent-runtime-user-accounts";
import { AgentRuntimeAccountLockSchema } from "./agent-runtime";

export const AgentRuntimeAccountAuthenticationSchema = z.enum([
  "provider",
  "subscription",
]);
export type AgentRuntimeAccountAuthentication = z.infer<
  typeof AgentRuntimeAccountAuthenticationSchema
>;

export const SelectAgentRuntimeUserAccountSchema = createSelectSchema(
  agentRuntimeUserAccountsTable,
  { authentication: AgentRuntimeAccountAuthenticationSchema },
);
export type AgentRuntimeUserAccount = z.infer<
  typeof SelectAgentRuntimeUserAccountSchema
>;

const AccountSelectionSchema = z.object({
  authentication: AgentRuntimeAccountAuthenticationSchema,
  llmApiKeyId: z.string().uuid().nullable(),
  modelId: z.string().uuid().nullable(),
});

/**
 * A person's choice: their own subscription, with the model of it they want,
 * or the company API key, with the connection and the model of it that the
 * agent and its runtime leave to each person.
 */
const AccountChoiceSchema = z.object({
  authentication: AgentRuntimeAccountAuthenticationSchema,
  /** The connection they picked for the company API key. */
  llmApiKeyId: z.string().uuid().nullable(),
  modelId: z.string().uuid().nullable(),
  /** The model of their own Claude subscription, as Claude Code names it. */
  claudeModel: z.string().nullable(),
});

/**
 * Who sets a part of the company API key for everyone below: the agent's
 * runtime, or the agent. Null leaves that part to each person.
 */
// A union, not `.nullable()`, so the generated client keeps the null.
const AccountFixedBySchema = z.union([z.enum(["runtime", "agent"]), z.null()]);

/**
 * The company API key as the caller's runs resolve it right now: its
 * connection and its model, each set by the agent's runtime, else by the
 * agent, else chosen by the caller, else the organization's default.
 */
const CompanyAccountSchema = z.object({
  /**
   * The connection in effect; `id` is null when none resolves. The name is
   * given also to a caller who may not read the connection.
   */
  connection: z.object({
    id: z.string().uuid().nullable(),
    name: z.string().nullable(),
    provider: z.string().nullable(),
    fixedBy: AccountFixedBySchema,
  }),
  /** The model in effect; `id` is null when none resolves. */
  model: z.object({
    id: z.string().uuid().nullable(),
    name: z.string().nullable(),
    fixedBy: AccountFixedBySchema,
  }),
  /**
   * With the connection set for the caller and the model left to them: the
   * connection's models that run on the runtime, which they may be unable
   * to list themselves.
   */
  models: AgentRuntimeAccountsViewSchema.shape.models,
  /**
   * Nothing is set or chosen, so the organization's default is what the
   * caller's runs on the company API key resolve to.
   */
  usesOrganizationDefault: z.boolean(),
});

/** What the caller's runs of an agent use, and what they may choose. */
export const AgentRuntimeAccountSchema = z.object({
  /**
   * The agent's own account: the default when the person chose nothing. Its
   * connection and model are the ones set for everyone, by the agent or its
   * runtime.
   */
  agentAccount: AccountSelectionSchema,
  /**
   * Whether the caller can run on the company API key: a usable connection
   * and model resolve for them.
   */
  companyKey: z.boolean(),
  companyAccount: CompanyAccountSchema,
  /** The caller's own choice for this agent, as stored. */
  choice: AccountChoiceSchema.nullable(),
  /**
   * Why the stored choice is not used today: its connection or model is
   * gone or no longer theirs to use (their runs are refused until they
   * choose again), or the agent's account lock sets it aside (their runs
   * use the agent's).
   */
  choiceError: z.string().nullable(),
  /** The account every person's runs of this agent are locked to, if any. */
  // A union, not `.nullable()`, so the generated client keeps the null.
  lock: z.union([AgentRuntimeAccountLockSchema, z.null()]),
  /** The personal subscription the caller's runs of this agent can use. */
  subscription: z
    .object({
      kind: z.union([z.literal("claude"), SubscriptionCredentialKindSchema]),
      label: z.string(),
      connected: z.boolean(),
      /**
       * The caller's own connection for it, whose models they can pick from.
       * Null while not connected, and for Claude, which keeps its own account.
       */
      keyId: z.string().uuid().nullable(),
    })
    .nullable(),
});
export type AgentRuntimeAccount = z.infer<typeof AgentRuntimeAccountSchema>;

export const UpdateAgentRuntimeAccountSchema = z.object({
  authentication: AgentRuntimeAccountAuthenticationSchema,
  /**
   * The connection for the company API key, where neither the agent nor its
   * runtime sets one: one the person may use for an agent of their own.
   */
  llmApiKeyId: z.string().uuid().nullable().optional(),
  /**
   * A model of the person's own subscription, or of the company API key's
   * connection where neither the agent nor its runtime sets the model.
   */
  modelId: z.string().uuid().nullable().optional(),
  /**
   * A model of the person's own Claude subscription, as Claude Code names it
   * ("opus", "default"): only with a Claude subscription.
   */
  claudeModel: z.string().trim().min(1).max(256).nullable().optional(),
});
