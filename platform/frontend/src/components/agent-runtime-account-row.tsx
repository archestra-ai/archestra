"use client";

import {
  getAgentRuntimeModelCompatibility,
  isSupportedProvider,
  type SupportedProvider,
} from "@archestra/shared";
import { useMemo, useState } from "react";
import {
  SubscriptionDisconnectButton,
  SubscriptionSignInButton,
} from "@/components/account-subscription-controls";
import {
  accountAlternative,
  agentRuntimeAccountSummary,
  alternativeLabels,
  companyAccountInUse,
  companyAccountWordsOf,
  subscriptionInUse,
} from "@/components/agent-runtime-account-choice";
import { AgentRuntimeCredentialsDialog } from "@/components/agent-runtime-credentials-dialog";
import type { AgentRuntimeConfig } from "@/components/agent-runtime-fields";
import { ClaudeCodeAccount } from "@/components/claude-code-account";
import {
  ClaudeSubscriptionModelPicker,
  CompanyConnectionPickers,
  SubscriptionModelPicker,
} from "@/components/claude-connection-pickers";
import {
  LOCKED_IN,
  runtimeCompanyProviderFits,
} from "@/components/runtime-account-cards";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type AgentRuntimeAccount,
  type AgentRuntimeAccountChoice,
  type CompanyAccount,
  useAgentRuntimeAccount,
  useSaveAgentRuntimeAccount,
} from "@/lib/agent-runtime-account.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { type LlmModel, useLlmModels } from "@/lib/llm-models.query";
import { useAvailableLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { cn } from "@/lib/utils/tailwind";

/**
 * A strip under "Give it work" on the agent's page: what the viewer's runs
 * use, their own sign-in when the runs wait on it, and the other way to run
 * the agent when one is open to them.
 */
export function AgentRuntimeAccountRow({
  agentId,
  runtime,
  agentClaudeModel,
  declarations,
  canEditAgent,
}: {
  agentId: string;
  /** What the agent runs on: it decides which models a person may pick. */
  runtime: Pick<AgentRuntimeConfig, "command" | "inferenceProtocol">;
  /** The model the agent sets for Claude subscriptions, until a person picks. */
  agentClaudeModel?: string;
  declarations: NonNullable<AgentRuntimeConfig["credentials"]>;
  canEditAgent: boolean;
}) {
  const [open, setOpen] = useState(false);
  const account = useAgentRuntimeAccount(agentId);
  const save = useSaveAgentRuntimeAccount(agentId);
  // The company option's fields show whether its parts are the viewer's to
  // pick or locked above them. A locked connection shows only to whoever may
  // see it: it is one of the connections they can list. Only someone who
  // may read connections asks for that list, and the card waits for it, so
  // a locked connection never flashes by for anyone else.
  const companyInUse = account.data ? companyAccountInUse(account.data) : null;
  const connectionLocked =
    !!companyInUse && companyInUse.connection.fixedBy !== null;
  const { data: canReadConnections } = useHasPermissions({
    llmProviderApiKey: ["read"],
  });
  const connections = useAvailableLlmProviderApiKeys({
    toastOnError: false,
    enabled:
      !!companyInUse && (!connectionLocked || canReadConnections === true),
  });
  const connectionsSettled =
    !connectionLocked ||
    canReadConnections === false ||
    connections.isSuccess ||
    connections.isError;
  // The card is there in every state: a placeholder of its height while the
  // account loads, and a way to ask again when it could not be read.
  if (!account.data || (!account.isError && !connectionsSettled)) {
    return (
      <div className={CARD}>
        {account.isError ? (
          <>
            <p className="min-w-0 flex-1 text-sm text-muted-foreground">
              Could not load the account for your runs.
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={account.isFetching}
              onClick={() => void account.refetch()}
            >
              <span>Retry</span>
            </Button>
          </>
        ) : (
          <output aria-label="Loading your account" className="flex-1">
            <Skeleton className="h-5 w-56 max-w-full" />
          </output>
        )}
      </div>
    );
  }
  const alternative = accountAlternative(account.data);
  // The subscription the viewer's runs use, read from the account so its
  // controls show in the same step as the line beside them.
  const subscription = subscriptionInUse(account.data);
  // The company option, while their runs use it: the parts neither the
  // runtime nor the agent fixes are theirs to pick on this card, and the
  // parts they fix show there, locked.
  const company = companyInUse;
  const lockedConnectionShown =
    connectionLocked &&
    !!company?.connection.id &&
    (connections.data ?? []).some((key) => key.id === company.connection.id);
  const { choice } = account.data;
  const picksCompanyAccount =
    !!company &&
    (company.connection.fixedBy === null || company.model.fixedBy === null);
  // Why a stored choice no longer runs, where choosing again can fix it. A
  // lock sets a choice aside and leaves the person no way to choose, but a
  // lock to the company API key still runs the parts of it they picked
  // themselves: one of those that stopped working is theirs to pick again,
  // in the fields here.
  const pickedCompanyParts =
    picksCompanyAccount && choice?.authentication === "provider";
  const choiceError =
    account.data.lock && !pickedCompanyParts ? null : account.data.choiceError;
  const modelFits = (model: LlmModel) =>
    getAgentRuntimeModelCompatibility({
      inferenceProtocol: runtime.inferenceProtocol,
      runtimeCommand: runtime.command,
      provider: model.provider,
      modelId: model.id,
      supportedEndpoints: model.capabilities?.supportedEndpoints,
    }).compatible;
  // One save at a time: a pick or a click made while another is being stored
  // waits for it, so two answers cannot land in the wrong order.
  const store = (choice: Parameters<typeof save.mutate>[0]) => {
    if (save.isPending) return;
    save.mutate(choice);
  };
  return (
    // The surface of the cards it sits above, so it reads as one of them.
    <div className={CARD}>
      {/* The left side holds the text alone, whichever way the runs use. It
          keeps its width, so the controls on the right go under it before
          they squeeze it. */}
      <div className="min-w-0 flex-auto space-y-0.5">
        <p className="text-sm font-medium">
          {agentRuntimeAccountSummary(account.data, {
            connectionShown:
              !!company && (!connectionLocked || lockedConnectionShown),
          })}
        </p>
        {choiceError && (
          <p className="text-[13px] text-muted-foreground">{choiceError}</p>
        )}
      </div>
      {/* Every control keeps to the right edge of the card, on the line's
          row and on a row of their own once they no longer fit beside it:
          what the way in use needs first, then the button that leaves it. */}
      <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2">
        {/* The company key's own fields: the card's controls for this way. */}
        {company && (
          <span className={WAY_CONTROLS}>
            <OwnCompanyAccountPickers
              runtime={runtime}
              company={company}
              keys={connections.data ?? []}
              lockedConnectionShown={lockedConnectionShown}
              plan={companyAccountWordsOf(account.data).plan}
              choice={choice}
              modelFits={modelFits}
              onPick={(pick) => store({ authentication: "provider", ...pick })}
            />
          </span>
        )}
        {/* The subscription's own controls: its sign-in, or once signed in
            the way out of it and then the model its runs use. */}
        {subscription && (
          <span className={WAY_CONTROLS}>
            {subscription.kind === "claude" ? (
              <>
                {/* One of the two shows: the first once connected, the
                    second until then. */}
                <ClaudeCodeAccount agentId={agentId} variant="disconnect" />
                <ClaudeCodeAccount agentId={agentId} variant="button" />
                {/* Their own model, from what their account offers, stored
                    with their choice of the subscription. */}
                <ClaudeSubscriptionModelPicker
                  agentId={agentId}
                  model={account.data.choice?.claudeModel ?? agentClaudeModel}
                  onModelChange={(claudeModel) =>
                    store({ authentication: "subscription", claudeModel })
                  }
                />
              </>
            ) : subscription.keyId ? (
              <>
                <SubscriptionDisconnectButton
                  keyId={subscription.keyId}
                  label={subscription.label}
                />
                {/* Their own model, from what their connection offers that
                    the agent's runtime can run. */}
                <SubscriptionModelPicker
                  keyId={subscription.keyId}
                  modelId={
                    account.data.choice?.modelId ??
                    account.data.agentAccount.modelId
                  }
                  modelFilter={modelFits}
                  onModelChange={(modelId) =>
                    store({ authentication: "subscription", modelId })
                  }
                />
              </>
            ) : (
              <SubscriptionSignInButton kind={subscription.kind} />
            )}
          </span>
        )}
        {/* Under a lock there is no way to choose: the fields are the fix. */}
        {choiceError && !account.data.lock && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setOpen(true)}
          >
            <span>Choose account</span>
          </Button>
        )}
        {alternative && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            // The button is not dimmed while the switch is stored: the card
            // already shows it.
            onClick={() =>
              store(
                alternative.store === "clear"
                  ? null
                  : { authentication: alternative.store },
              )
            }
          >
            {/* Both labels share one cell, so the button keeps the width of
                the longer one and does not move under the pointer. */}
            <span className="grid">
              {alternativeLabels(account.data).map((label) => (
                <span
                  key={label}
                  aria-hidden={label !== alternative.label}
                  className={cn(
                    "col-start-1 row-start-1",
                    label !== alternative.label && "invisible",
                  )}
                >
                  {label}
                </span>
              ))}
            </span>
          </Button>
        )}
      </div>
      {open && (
        <AgentRuntimeCredentialsDialog
          agentId={agentId}
          declarations={declarations}
          canEditAgent={canEditAgent}
          forAccount
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * The connection and model of the company option, on one line: the fields
 * the agent's settings show. The parts neither the runtime's settings nor
 * the agent's fix are the viewer's own to pick. A part fixed above shows
 * locked, with its value and where it is set; a fixed connection only to
 * someone who may see it. A fixed part is never sent with a pick: the API
 * refuses a choice that names it, even by the value it already has.
 */
function OwnCompanyAccountPickers({
  runtime,
  company,
  keys,
  lockedConnectionShown,
  plan,
  choice,
  modelFits,
  onPick,
}: {
  runtime: Pick<AgentRuntimeConfig, "command" | "inferenceProtocol">;
  company: CompanyAccount;
  /** The connections the viewer can list. */
  keys: Parameters<typeof CompanyConnectionPickers>[0]["keys"];
  /** A fixed connection is one the viewer may see: it shows, locked. */
  lockedConnectionShown: boolean;
  /** The company account is an enterprise plan: the fields say "plan". */
  plan: boolean;
  choice: AgentRuntimeAccount["choice"];
  modelFits: (model: LlmModel) => boolean;
  onPick: (
    pick: Pick<AgentRuntimeAccountChoice, "llmApiKeyId" | "modelId">,
  ) => void;
}) {
  const connectionOpen = company.connection.fixedBy === null;
  const modelOpen = company.model.fixedBy === null;
  // A part that is theirs holds their own pick only where the account
  // resolves to it. Without one, what resolves is the organization's
  // default: the field then reads as the default, and asks for a pick where
  // nothing resolves, or where a pick of theirs no longer works.
  const own = choice?.authentication === "provider" ? choice : null;
  const pickedConnectionId =
    connectionOpen &&
    company.connection.id &&
    own?.llmApiKeyId === company.connection.id
      ? company.connection.id
      : null;
  const pickedModelId =
    modelOpen && company.model.id && own?.modelId === company.model.id
      ? company.model.id
      : null;
  // The connection the model field lists the models of: their own pick, or
  // the one fixed above. A model waits for one of the two.
  const connectionId = connectionOpen
    ? pickedConnectionId
    : company.connection.id;
  // Under a connection fixed above, its models come with the account: the
  // viewer may not be able to list them. The account names a model as an
  // agent stores it (`id`) and as its provider does (`modelId`); the model
  // lists here call those `dbId` and `id`.
  const fixedConnectionModels = useMemo<LlmModel[] | undefined>(
    () =>
      connectionOpen
        ? undefined
        : (company.models ?? []).flatMap((model) =>
            isSupportedProvider(model.provider)
              ? [
                  {
                    id: model.modelId,
                    dbId: model.id,
                    displayName: model.displayName,
                    provider: model.provider,
                    isFree: false,
                  },
                ]
              : [],
          ),
    [connectionOpen, company.models],
  );
  // The picked connection's own models, for the picked model's name.
  const listed = useLlmModels({
    apiKeyId: pickedConnectionId ?? undefined,
    enabled: modelOpen && !!pickedConnectionId,
  });
  const model = pickedModelId
    ? (fixedConnectionModels ?? listed.data)?.find(
        (item) => item.dbId === pickedModelId,
      )
    : undefined;
  const provider: SupportedProvider | null =
    model?.provider ??
    (isSupportedProvider(company.connection.provider)
      ? company.connection.provider
      : null);
  // A model set above holds for everyone it reaches, the one set for the
  // connection they picked included: the field shows it, locked.
  const modelLocked = !modelOpen;
  const lockedIn = (level: "agent" | "runtime" | null) =>
    level ? LOCKED_IN[level] : undefined;
  return (
    <CompanyConnectionPickers
      compact
      plan={plan}
      keys={keys}
      apiKeyId={connectionId}
      apiKeyName={company.connection.name}
      runsOn={(candidate) => runtimeCompanyProviderFits(runtime, candidate)}
      // A fixed connection someone may not see has no field at all.
      connectionFixed={!connectionOpen && !lockedConnectionShown}
      lockedConnection={
        !connectionOpen && lockedConnectionShown
          ? {
              name: company.connection.name ?? "",
              reason: lockedIn(company.connection.fixedBy),
            }
          : null
      }
      modelLocked={modelLocked}
      modelLockedReason={lockedIn(company.model.fixedBy)}
      // A choice is stored whole: a new connection is saved with no model,
      // since the old one's is not one of its own.
      onApiKeyChange={(llmApiKeyId) => onPick({ llmApiKeyId })}
      modelId={modelLocked ? company.model.id : pickedModelId}
      modelName={
        modelLocked
          ? company.model.name
          : pickedModelId
            ? (company.model.name ?? model?.displayName ?? null)
            : null
      }
      modelProvider={provider}
      // Their own connection goes with the model, or the save would drop it.
      onModelChange={(modelId) =>
        onPick({
          ...(pickedConnectionId && { llmApiKeyId: pickedConnectionId }),
          modelId,
        })
      }
      modelFilter={modelFits}
      models={fixedConnectionModels}
      emptyConnection={
        company.connection.id
          ? `Default ${plan ? "plan" : "connection"}`
          : `Choose a ${plan ? "plan" : "connection"}`
      }
      emptyModel={company.model.id ? "Default model" : "Choose a model"}
    />
  );
}

// ===

// As tall as its tallest state, the line beside a button, so the page does
// not move when the account arrives or a button comes and goes.
const CARD =
  "flex min-h-[62px] flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border bg-card px-5 py-3.5";

/** The controls of the way in use: one group, which wraps to the right edge. */
const WAY_CONTROLS =
  "fade-in flex min-w-0 animate-in flex-wrap items-center justify-end gap-2 duration-200 motion-reduce:animate-none";
