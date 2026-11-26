"use client";

import { isSupportedProvider, type SupportedProvider } from "@archestra/shared";
import { useCallback } from "react";
import {
  AccountSectionError,
  type AgentAccountLock,
  AgentAccountOptions,
  AgentAccountWays,
} from "@/components/agent-account-ways-field";
import type { AgentRuntimeConfig } from "@/components/agent-runtime-fields";
import { ClaudeCodeInferenceSettings } from "@/components/claude-code-inference-settings";
import { CompanyAccountFields } from "@/components/company-account-fields";
import {
  companyApiKeyCard,
  personalSubscriptionCard,
  runtimeCompanyProviderFits,
  runtimeModelFits,
  runtimeSubscriptionKind,
} from "@/components/runtime-account-cards";
import type { RuntimeAccounts } from "@/lib/agent-runtime-templates.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { type LlmModel, useLlmModels } from "@/lib/llm-models.query";
import { useAvailableLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";

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
        chooser="agent"
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
  const next: RuntimeAccounts = {
    ...(params.namesKind && change.lock && { kind: change.lock }),
    ...(change.llmApiKeyId && { llmApiKeyId: change.llmApiKeyId }),
    ...(modelId && { modelId }),
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

const LABEL = "Credentials to use";

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
