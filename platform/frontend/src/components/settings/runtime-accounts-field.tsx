"use client";

import {
  isCopilotRuntimeCommand,
  isSupportedProvider,
  type SupportedProvider,
} from "@archestra/shared";
import { useCallback } from "react";
import {
  AccountSectionError,
  type AgentAccountLock,
  AgentAccountOptions,
  AgentAccountWays,
  accountWays,
  accountWaysMeaning,
} from "@/components/agent-account-ways-field";
import type { AgentRuntimeConfig } from "@/components/agent-runtime-fields";
import { ClaudeCodeInferenceSettings } from "@/components/claude-code-inference-settings";
import { CompanyAccountFields } from "@/components/company-account-fields";
import {
  type CopilotPlansOpen,
  companyAccountName,
  companyApiKeyCard,
  copilotAccountsFor,
  copilotPlansAfterClick,
  copilotPlansOpen,
  enterprisePlanCard,
  personalSubscriptionCard,
  planModelsAfterClick,
  runtimeCompanyProviderFits,
  runtimeModelFits,
  runtimeSubscriptionKind,
  withPlanModel,
} from "@/components/runtime-account-cards";
import type { RuntimeAccounts } from "@/lib/agent-runtime-templates.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { type LlmModel, useLlmModels } from "@/lib/llm-models.query";
import { useAvailableLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { isOrganizationSubscription } from "@/lib/organization-subscription";

/**
 * What the cards of a runtime's settings say after a change: the one kind of
 * account its rule names (null for both, which leaves the kind to each
 * agent), and the company connection and model it fixes for its agents.
 * `none` is every card unticked, which no setting says: the editor holds it
 * until one is ticked again.
 */
export type RuntimeAccountsChange =
  | { lock: "none" }
  | {
      lock: AgentAccountLock | null;
      llmApiKeyId?: string;
      modelId?: string;
      /** The model set for each plan, where no plan is fixed. */
      connectionModels?: Record<string, string>;
    };

/**
 * The account rule a runtime sets for its agents, in the runtime's own
 * settings: the cards an agent on it shows under the same heading, from the
 * same components. One card ticked names that kind of account for every
 * agent. Both leave it to each agent. The company card's connection and
 * model are optional here: set, they are fixed for every agent; left empty,
 * each agent picks its own. The rule holds for every agent on the runtime as
 * soon as it is saved.
 */
export function RuntimeAccountsField({
  runtime,
  claude,
  lock,
  noneSelected,
  accounts,
  onChange,
}: {
  runtime: Pick<AgentRuntimeConfig, "command" | "inferenceProtocol">;
  /** The runtime runs Claude Code: its cards are the Claude ones. */
  claude: boolean;
  /** The one kind of account the runtime names; null for none of them. */
  lock: AgentAccountLock | null;
  /** Every card is unticked; the runtime cannot be saved like this. */
  noneSelected: boolean;
  /** The connection and model the runtime fixes, with their names. */
  accounts: RuntimeAccounts | undefined;
  onChange: (change: RuntimeAccountsChange) => void;
}) {
  const appName = useAppName();
  const command = runtime.command?.[0] ?? null;
  const subscriptionKind = claude ? null : runtimeSubscriptionKind(command);
  const copilot = !claude && isCopilotRuntimeCommand(command);
  const { data: keys = [] } = useAvailableLlmProviderApiKeys({
    toastOnError: false,
  });
  const llmApiKeyId = accounts?.llmApiKeyId;
  const modelId = llmApiKeyId ? accounts?.modelId : undefined;
  const models = useLlmModels({
    apiKeyId: llmApiKeyId,
    enabled: !!llmApiKeyId,
  });
  const model = models.data?.find((item) => item.dbId === modelId);
  // The server's names stand in until the lists answer, and for a model the
  // reader's list does not hold.
  const modelName = modelId
    ? (model?.displayName ?? accounts?.modelName ?? null)
    : null;
  const modelProvider: SupportedProvider | null =
    model?.provider ??
    (isSupportedProvider(accounts?.keyProvider) ? accounts.keyProvider : null);
  const { inferenceProtocol } = runtime;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the runtime is read by what decides the answer, its command and protocol
  const runsOn = useCallback(
    (provider: SupportedProvider) =>
      runtimeCompanyProviderFits(runtime, provider),
    [command, inferenceProtocol],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: the same
  const modelFits = useCallback(
    (item: LlmModel) => runtimeModelFits(runtime, item),
    [command, inferenceProtocol],
  );
  const ways = noneSelected
    ? { subscription: false, provider: false }
    : accountWays(lock);

  /**
   * The company card's two fields, and what they amount to for agents: the
   * fields an agent's own settings show for the level below it.
   */
  const connectionFields = (
    <CompanyAccountFields
      level="runtime"
      keys={keys}
      apiKeyId={llmApiKeyId ?? null}
      // The server's name, for a connection the reader's list lacks.
      apiKeyName={accounts?.keyName}
      runsOn={runsOn}
      // Every agent of the runtime runs on the connection fixed here, so
      // only a shared one can be: a personal key is refused on save.
      sharedOnly
      claude={claude}
      modelId={modelId ?? null}
      modelName={modelName}
      modelProvider={modelProvider}
      modelFilter={modelFits}
      between={<MissingError accounts={accounts} />}
      onChange={(next) => onChange({ lock, ...next })}
    />
  );
  /** The kind the two cards name; a subscription alone fixes no connection. */
  const changeLock = (next: AgentAccountLock | null) =>
    onChange(
      next === "subscription"
        ? { lock: next }
        : { lock: next, llmApiKeyId, modelId },
    );
  const noneNow = () => onChange({ lock: "none" });

  if (claude) {
    return (
      <ClaudeCodeInferenceSettings
        lock={lock}
        noWaySelected={noneSelected}
        onLockChange={changeLock}
        onNoWaySelected={noneNow}
        connectionPickers={connectionFields}
        runtimeCommand={command}
        chooser="agent"
      />
    );
  }

  if (copilot) {
    const plans = keys.filter(
      (key) =>
        key.provider === "github-copilot" && isOrganizationSubscription(key),
    );
    const subscription = {
      id: "subscription",
      // The Copilot CLI always has its subscription kind.
      ...personalSubscriptionCard(subscriptionKind ?? "github-copilot"),
    };
    if (plans.length === 0) {
      // No plan is connected: each person's own Copilot is the one account.
      return (
        <AgentAccountOptions
          label={LABEL}
          options={[{ ...subscription, checked: true, onToggle: () => {} }]}
        />
      );
    }
    // The company's way is open on every plan, or on the one the runtime
    // fixes. A set of several plans short of all of them is not something a
    // runtime can say, so a click that would leave one settles on one plan.
    // The company's way is open on every plan, or on the one the runtime
    // fixes.
    const fixedPlan = plans.find((plan) => plan.id === llmApiKeyId)?.id;
    const open = copilotPlansOpen({
      companyWayOpen: ways.provider,
      fixedPlanId: fixedPlan,
    });
    const planModels = accounts?.connectionModels;
    const set = (subscriptionOn: boolean, next: CopilotPlansOpen) => {
      const change = copilotAccountsFor({
        subscription: subscriptionOn,
        open: next,
        fixedPlanId: fixedPlan,
        modelId,
      });
      if (change.lock === "none") return onChange(change);
      // A plan's model stays with it: the one set for a plan that is now
      // fixed is the runtime's own, and the fixed plan's own becomes the
      // one set for it once every plan is open.
      onChange({
        ...change,
        modelId:
          change.modelId ??
          (change.llmApiKeyId ? planModels?.[change.llmApiKeyId] : undefined),
        connectionModels: planModelsAfterClick({
          models: planModels,
          open: next,
          fixedPlanId: fixedPlan,
          fixedModelId: modelId,
        }),
      });
    };
    const togglePlan = (planId: string) =>
      set(
        ways.subscription,
        copilotPlansAfterClick({
          planIds: plans.map((plan) => plan.id),
          open,
          planId,
        }),
      );
    return (
      <AgentAccountOptions
        label={LABEL}
        meaning={accountWaysMeaning(ways, companyAccountName(command), "agent")}
        // A fixed plan that was disconnected since has no card to say so.
        problem={
          accounts?.keyMissing && llmApiKeyId && !fixedPlan
            ? "The enterprise plan this runtime fixed no longer exists. Choose another."
            : undefined
        }
        options={[
          {
            ...subscription,
            checked: ways.subscription,
            onToggle: () => set(!ways.subscription, open),
          },
          ...plans.map((plan) => {
            const checked = open === "all" || open === plan.id;
            // The plan is the connection, so only its model is picked here,
            // and only where the card stands for one plan.
            const holdsModel =
              checked && (fixedPlan === plan.id || plans.length === 1);
            return {
              id: plan.id,
              ...enterprisePlanCard(plan),
              checked,
              onToggle: () => togglePlan(plan.id),
              children: !checked ? undefined : !holdsModel ? (
                // Several plans are left to each agent: each holds the
                // model set for it.
                <PlanModelFields
                  planId={plan.id}
                  keys={keys}
                  modelId={planModels?.[plan.id] ?? null}
                  storedName={accounts?.connectionModelNames?.[plan.id]}
                  runsOn={runsOn}
                  modelFits={modelFits}
                  onChange={(next) =>
                    onChange({
                      lock,
                      connectionModels:
                        withPlanModel(
                          { connectionModels: planModels },
                          plan.id,
                          next,
                        ).connectionModels ?? {},
                    })
                  }
                />
              ) : (
                <CompanyAccountFields
                  level="runtime"
                  keys={keys}
                  apiKeyId={plan.id}
                  runsOn={runsOn}
                  connectionFixed
                  modelId={modelId ?? null}
                  modelName={modelName}
                  modelProvider={modelProvider}
                  modelFilter={modelFits}
                  between={<MissingError accounts={accounts} />}
                  // A model needs its connection named, so picking one
                  // fixes the plan with it. Clearing it leaves the plan as
                  // it was: fixed, or one of all.
                  onChange={(next) =>
                    onChange({
                      lock,
                      llmApiKeyId: next.modelId ? plan.id : fixedPlan,
                      modelId: next.modelId,
                    })
                  }
                />
              ),
            };
          }),
        ]}
      />
    );
  }

  const company = { ...companyApiKeyCard(appName), children: connectionFields };
  if (!subscriptionKind) {
    // The company key is the runtime's one account: always on, nothing to
    // tick.
    return (
      <AgentAccountOptions
        label={LABEL}
        options={[
          { id: "provider", ...company, checked: true, onToggle: () => {} },
        ]}
      />
    );
  }
  return (
    <AgentAccountWays
      label={LABEL}
      subscription={personalSubscriptionCard(subscriptionKind)}
      provider={company}
      lock={lock}
      noneSelected={noneSelected}
      onLockChange={changeLock}
      onNoneSelected={noneNow}
      chooser="agent"
    />
  );
}

/**
 * A runtime's account rule after a change of its cards. `namesKind` is
 * whether the rule can name one kind of account: a runtime with one account
 * has none to name. The server's names and marks stay with the connection
 * and model they describe.
 */
export function runtimeAccountsAfter(params: {
  previous: RuntimeAccounts | undefined;
  change: Exclude<RuntimeAccountsChange, { lock: "none" }>;
  namesKind: boolean;
}): RuntimeAccounts | undefined {
  const { previous, change } = params;
  const sameKey =
    !!change.llmApiKeyId && change.llmApiKeyId === previous?.llmApiKeyId;
  const modelId = change.llmApiKeyId ? change.modelId : undefined;
  const sameModel = sameKey && !!modelId && modelId === previous?.modelId;
  // A model per plan is held only where no plan is fixed. Its name stays
  // while the model does.
  const planModels = change.llmApiKeyId ? {} : (change.connectionModels ?? {});
  const planModelNames = Object.fromEntries(
    Object.entries(previous?.connectionModelNames ?? {}).filter(
      ([id]) =>
        planModels[id] && planModels[id] === previous?.connectionModels?.[id],
    ),
  );
  const next: RuntimeAccounts = {
    ...(params.namesKind && change.lock && { kind: change.lock }),
    ...(change.llmApiKeyId && { llmApiKeyId: change.llmApiKeyId }),
    ...(modelId && { modelId }),
    ...(Object.keys(planModels).length > 0 && {
      connectionModels: planModels,
    }),
    ...(Object.keys(planModelNames).length > 0 && {
      connectionModelNames: planModelNames,
    }),
    ...(sameKey && previous?.keyName && { keyName: previous.keyName }),
    ...(sameKey &&
      previous?.keyProvider && { keyProvider: previous.keyProvider }),
    ...(sameKey && previous?.keyMissing && { keyMissing: true }),
    ...(sameModel && previous?.modelName && { modelName: previous.modelName }),
    ...(sameModel && previous?.modelMissing && { modelMissing: true }),
  };
  return Object.keys(next).length > 0 ? next : undefined;
}

// ===

const LABEL = "Accounts that can run it";

/**
 * The model set for one plan among several the runtime leaves to each
 * agent. The server's name stands in until the plan's models answer.
 */
function PlanModelFields({
  planId,
  keys,
  modelId,
  storedName,
  runsOn,
  modelFits,
  onChange,
}: {
  planId: string;
  keys: React.ComponentProps<typeof CompanyAccountFields>["keys"];
  modelId: string | null;
  storedName: string | undefined;
  runsOn: (provider: SupportedProvider) => boolean;
  modelFits: (model: LlmModel) => boolean;
  onChange: (modelId: string | null) => void;
}) {
  const models = useLlmModels({ apiKeyId: planId, enabled: !!modelId });
  const model = models.data?.find((item) => item.dbId === modelId);
  return (
    <CompanyAccountFields
      level="runtime"
      amongSeveral
      keys={keys}
      apiKeyId={planId}
      runsOn={runsOn}
      connectionFixed
      modelId={modelId}
      modelName={modelId ? (model?.displayName ?? storedName ?? null) : null}
      modelProvider={model?.provider ?? "github-copilot"}
      modelFilter={modelFits}
      onChange={(next) => onChange(next.modelId ?? null)}
    />
  );
}

/**
 * The fixed connection or model was deleted since it was saved: said in the
 * section's error style, with what to do about it.
 */
function MissingError({ accounts }: { accounts: RuntimeAccounts | undefined }) {
  if (!accounts?.llmApiKeyId) return null;
  if (accounts.keyMissing) {
    return (
      <AccountSectionError>
        This connection no longer exists. Choose another or clear it.
      </AccountSectionError>
    );
  }
  if (accounts.modelId && accounts.modelMissing) {
    return (
      <AccountSectionError>
        This model no longer exists. Choose another or clear it.
      </AccountSectionError>
    );
  }
  return null;
}
