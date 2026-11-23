"use client";

import {
  COMPANY_ACCOUNT_WORDS,
  type CompanyAccountWords,
} from "@archestra/shared";
import { AlertTriangle, CircleCheck, Lock } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import type { AccountWay } from "@/components/agent-account-ways-field";
import { ClaudeCodeAccount } from "@/components/claude-code-account";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Label } from "@/components/ui/label";
import {
  RadioGroup,
  RadioGroupItem,
  radioCardClass,
} from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type AgentRuntimeAccountChoice as AccountChoiceBody,
  type AgentRuntimeAccount,
  type AgentRuntimeAccountLock,
  accountLockDescription,
  type CompanyAccount,
  useAgentRuntimeAccount,
} from "@/lib/agent-runtime-account.query";
import { cn } from "@/lib/utils/tailwind";

type Option = AccountWay;

/**
 * Which account the viewer's own runs of an agent use: their own
 * subscription or the agent's company key, with the agent's own setting as
 * the default. Others who use the agent keep their own choice.
 */
export function AgentRuntimeAccountChoice({
  agentId,
  form,
  saving,
  savingChoice,
  saveError,
  onPendingChange,
}: {
  agentId: string;
  /** The setup dialog's form; it owns the selection and the save. */
  form: UseFormReturn<AccountFormValues>;
  saving: boolean;
  /** The account choice's own save is in flight. */
  savingChoice: boolean;
  /** Why the last account save failed, shown in this section. */
  saveError: string | null;
  /** Told what the dialog's one Save has to store for the account. */
  onPendingChange: (change: PendingAccountChange | null) => void;
}) {
  const account = useAgentRuntimeAccount(agentId);
  // The form mounts once per stored choice and starts on it. A save shows
  // its choice at once and puts the stored one back if it fails, so the
  // form stays mounted while that save is in flight: a failed save keeps
  // the person's selection, and a saved one becomes the new start as soon
  // as it settles, whatever else the dialog still saves.
  const storedChoice = account.data
    ? JSON.stringify(account.data.choice)
    : null;
  const [formKey, setFormKey] = useState(storedChoice);
  if (!savingChoice && storedChoice !== formKey) setFormKey(storedChoice);
  if (!account.data) {
    return account.isError ? (
      <InlineNotice variant="error">
        <AlertTriangle />
        <span className="font-medium">Can&apos;t load your account</span>
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="ml-auto shrink-0"
          onClick={() => void account.refetch()}
        >
          Retry
        </Button>
      </InlineNotice>
    ) : (
      <output aria-label="Loading your account" className="grid gap-2.5">
        <Skeleton className="h-[68px] w-full rounded-[10px]" />
        <Skeleton className="h-[68px] w-full rounded-[10px]" />
      </output>
    );
  }
  // A lock leaves nothing to choose.
  if (account.data.lock) {
    return (
      <AccountLockLine lock={account.data.lock} words={COMPANY_ACCOUNT_WORDS} />
    );
  }
  return (
    <AccountChoiceForm
      key={formKey ?? ""}
      agentId={agentId}
      account={account.data}
      form={form}
      saving={saving}
      saveError={saveError}
      onPendingChange={onPendingChange}
    />
  );
}

/** The account part of the setup dialog's form values. */
export type AccountFormValues = {
  account: { option: Option | null };
};

/**
 * The account selection, as the dialog's one Save needs it: whether it
 * differs from what is in effect, why it cannot be saved yet, and what to
 * store (null clears the choice back to the agent's default).
 */
export type PendingAccountChange = {
  pending: boolean;
  /** Nothing selected yet: the dialog's Save waits. */
  blocked: boolean;
  choice: AccountChoiceBody | null;
  /** The option to focus once the save lands. */
  option: Option | null;
};

/**
 * One line on what the viewer's runs of an agent use: their own subscription,
 * or a company API key (the agent's own, or the organization's default where
 * the agent has none).
 */
export function agentRuntimeAccountSummary(
  account: AgentRuntimeAccount,
): string {
  return accountWayInUse(account) === "subscription"
    ? "Uses your personal subscription"
    : `Uses ${COMPANY_ACCOUNT_WORDS.companys}`;
}

/**
 * The viewer's own subscription, when their runs of the agent use it: what
 * the card shows the sign-in of. Null while their runs are on a company key.
 */
export function subscriptionInUse(
  account: AgentRuntimeAccount,
): AgentRuntimeAccount["subscription"] {
  return accountWayInUse(account) === "subscription"
    ? account.subscription
    : null;
}

/**
 * The company option as the viewer's runs resolve it, when their runs use
 * it: what the card shows the pickers of, for the parts left to them. Null
 * while their runs are on their own subscription.
 */
export function companyAccountInUse(
  account: AgentRuntimeAccount,
): CompanyAccount | null {
  return accountWayInUse(account) === "subscription"
    ? null
    : account.companyAccount;
}

/**
 * The other way a person can run an agent, next to the one their runs use
 * now: none when the agent is locked to one way, or nothing else is open to
 * them. Switching needs nothing more from them: `clear` drops their choice
 * for the agent's default, the others store that way as their choice.
 */
export function alternativeLabels(): readonly [
  subscription: string,
  company: string,
] {
  return [
    "Use personal subscription instead",
    `Use ${COMPANY_ACCOUNT_WORDS.short} instead`,
  ];
}

export function accountAlternative(account: AgentRuntimeAccount): {
  way: AccountWay;
  label: string;
  store: "clear" | AccountWay;
} | null {
  if (account.lock) return null;
  const agentWay = agentDefault(account);
  const current = account.choice?.authentication ?? agentWay;
  if (current !== "subscription" && account.subscription) {
    return {
      way: "subscription",
      label: alternativeLabels()[0],
      store: agentWay === "subscription" ? "clear" : "subscription",
    };
  }
  // Back to company billing: the company option as a choice where the agent
  // starts on subscriptions, otherwise by dropping the person's choice, which
  // also covers an agent that runs on the organization's default.
  if (
    current !== "provider" &&
    (companyOptionOffered(account) ||
      (!!account.choice && agentWay !== "subscription"))
  ) {
    return {
      way: "provider",
      label: alternativeLabels()[1],
      store: agentWay === "subscription" ? "provider" : "clear",
    };
  }
  return null;
}

// ===

const COMPANY_API_KEY = "A company API key";
const COMPANY_ENTERPRISE_PLAN = "The company's enterprise plan";

/** The way the viewer's runs use: the lock's, their choice, or the default. */
function accountWayInUse(account: AgentRuntimeAccount): Option | null {
  if (account.lock === "subscription") return "subscription";
  if (account.lock === "key") return "provider";
  return account.choice?.authentication ?? agentDefault(account);
}

function AccountChoiceForm({
  agentId,
  account,
  form,
  saving,
  saveError,
  onPendingChange,
}: {
  agentId: string;
  account: AgentRuntimeAccount;
  form: UseFormReturn<AccountFormValues>;
  saving: boolean;
  saveError: string | null;
  onPendingChange: (change: PendingAccountChange | null) => void;
}) {
  const id = useId();
  const defaultOption = agentDefault(account);
  // This section mounts once per stored choice: the form starts on it, and
  // a saved choice becomes the new baseline, so the form is not dirty.
  const [start] = useState(() => startingSelection(account, defaultOption));
  // biome-ignore lint/correctness/useExhaustiveDependencies: on mount only
  useEffect(() => {
    form.reset({ ...form.getValues(), account: start });
  }, []);
  const { option } = form.watch("account") ?? start;
  const setOption = (next: Option) =>
    form.setValue("account.option", next, { shouldDirty: true });

  const { subscription } = account;
  const copilot = subscription?.kind === "github-copilot";
  const options: Array<{ value: Option; title: string; description: string }> =
    [
      ...(subscription
        ? [
            {
              value: "subscription" as const,
              title: `My ${subscription.label}`,
              description: subscription.connected
                ? "Runs use your own plan. Nobody else uses it."
                : "Runs use your own plan once you connect it.",
            },
          ]
        : []),
      ...(companyOptionOffered(account) ||
      account.choice?.authentication === "provider"
        ? [
            {
              value: "provider" as const,
              // The Copilot CLI's company account is a plan, not an API key.
              title: copilot ? COMPANY_ENTERPRISE_PLAN : COMPANY_API_KEY,
              description: companyOptionDescription(account, copilot),
            },
          ]
        : []),
    ];

  const selectsDefault = option !== null && option === defaultOption;
  // What runs use today: the stored choice when it works, else the default
  // when nothing is stored.
  const inEffect = account.choice
    ? !account.choiceError && option === account.choice.authentication
    : selectsDefault;
  // A subscription not connected yet is not in use: its sign-in is the status.
  const awaitingSignIn =
    option === "subscription" && !!subscription && !subscription.connected;
  const pendingChoice: AccountChoiceBody | null =
    // The default is not stored: the person follows the agent's setting.
    // A choice is stored whole, so choosing a way names nothing else: the
    // company option then resolves with no pick of theirs, and they pick
    // its open parts on the agent's page.
    selectsDefault || !option ? null : { authentication: option };
  // Nothing selected and nothing in effect still waits for a choice.
  const pending = !inEffect;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the choice follows the option
  useEffect(() => {
    onPendingChange({
      pending,
      blocked: pending && !option,
      choice: pendingChoice,
      option,
    });
  }, [pending, selectsDefault, option, onPendingChange]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: on unmount only
  useEffect(() => () => onPendingChange(null), []);

  return (
    <div className="min-w-0 space-y-3">
      {account.choiceError && (
        <InlineNotice variant="warning">
          <AlertTriangle />
          <span className="font-medium">Choose again</span>
          <InlineNoticeText>{account.choiceError}</InlineNoticeText>
        </InlineNotice>
      )}
      <RadioGroup
        aria-label="What your runs use"
        value={option ?? ""}
        onValueChange={(value) => setOption(value as Option)}
        disabled={saving}
        className="grid-cols-[minmax(0,1fr)] gap-2.5"
      >
        {options.map(({ value, title, description }) => (
          <Label
            key={value}
            htmlFor={`${id}-${value}`}
            className={cn(
              "flex cursor-pointer items-start gap-2.5 rounded-[10px] p-3.5 font-normal",
              radioCardClass({ checked: option === value }),
              option === value && "bg-primary/5",
            )}
          >
            <RadioGroupItem
              id={`${id}-${value}`}
              value={value}
              data-account-option={value}
              className="mt-0.5"
            />
            <span className="min-w-0 flex-1 space-y-0.5">
              <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm font-medium">
                <span>{title}</span>
                {value === defaultOption && (
                  <Badge
                    variant="secondary"
                    className="shrink-0 px-1.5 py-0 text-[10px]"
                  >
                    Agent default
                  </Badge>
                )}
              </span>
              <span className="block text-[13px] leading-[1.45] text-muted-foreground">
                {description}
              </span>
            </span>
          </Label>
        ))}
      </RadioGroup>
      {option === "subscription" &&
        subscription &&
        !subscription.connected &&
        (subscription.kind === "claude" ? (
          <ClaudeCodeAccount agentId={agentId} variant="compact" />
        ) : (
          <Button type="button" size="xs" variant="outline" asChild>
            <Link
              href={`/llm/model-providers?connect=${subscription.kind}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <span>Connect {subscription.label}</span>
            </Link>
          </Button>
        ))}
      {saveError && (
        <InlineNotice variant="error">
          <AlertTriangle />
          <span className="font-medium">Your account was not saved</span>
          <InlineNoticeText>{saveError}</InlineNoticeText>
        </InlineNotice>
      )}
      {inEffect && !awaitingSignIn ? (
        <output
          aria-live="polite"
          className="flex items-center gap-1.5 text-sm text-muted-foreground"
        >
          <CircleCheck
            className="size-4 shrink-0 text-green-600 dark:text-green-400"
            aria-hidden="true"
          />
          <span>
            {selectsDefault
              ? "Your runs use this account. It is the agent's default."
              : "Your runs use this account."}
          </span>
        </output>
      ) : !option ? (
        <p className="text-[13px] text-muted-foreground">
          <span>Choose an account</span>
        </p>
      ) : null}
    </div>
  );
}

/**
 * What the company option runs on, for the person choosing it. The parts the
 * runtime or the agent fixes are the agent's; the rest they pick on the
 * agent's page, where its account card holds the fields.
 */
function companyOptionDescription(
  account: AgentRuntimeAccount,
  copilot: boolean,
): string {
  const company = account.companyAccount;
  const connection = copilot ? "plan" : "connection";
  const connectionOpen = company.connection.fixedBy === null;
  const modelOpen = company.model.fixedBy === null;
  const runsOn = connectionOpen
    ? `A ${connection} and model you pick on the agent's page.`
    : modelOpen
      ? `The agent's ${connection}, with a model you pick on its page.`
      : `The agent's ${connection} and model.`;
  return `${runsOn} Billed to the company.`;
}

/** What the form starts on: the stored choice, else the agent's default. */
function startingSelection(
  account: AgentRuntimeAccount,
  defaultOption: Option | null,
): { option: Option | null } {
  return { option: account.choice?.authentication ?? defaultOption };
}

function AccountLockLine({
  lock,
  words,
}: {
  lock: AgentRuntimeAccountLock;
  words: CompanyAccountWords;
}) {
  return (
    <InlineNotice variant="neutral">
      <Lock />
      <span className="font-medium">Account locked</span>
      <InlineNoticeText>{accountLockDescription(lock, words)}</InlineNoticeText>
    </InlineNotice>
  );
}

/**
 * What the agent's own setting gives a person who chooses nothing: their own
 * subscription, the company option, or nothing usable.
 */
function agentDefault(account: AgentRuntimeAccount): Option | null {
  if (account.agentAccount.authentication === "subscription") {
    return account.subscription ? "subscription" : null;
  }
  return companyOptionOffered(account) ? "provider" : null;
}

/**
 * Whether the company option is there for the viewer: it resolves for them
 * as it is, or a part of it is theirs to pick. Not while everything is set
 * above them and no longer works.
 */
function companyOptionOffered(account: AgentRuntimeAccount): boolean {
  const { connection, model } = account.companyAccount;
  return (
    account.companyKey || connection.fixedBy === null || model.fixedBy === null
  );
}
