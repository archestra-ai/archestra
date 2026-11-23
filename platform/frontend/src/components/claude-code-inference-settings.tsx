"use client";

import type { ReactNode } from "react";
import {
  type AccountChooser,
  type AgentAccountLock,
  AgentAccountWays,
} from "@/components/agent-account-ways-field";
import {
  CLAUDE_SUBSCRIPTION_CARD,
  companyApiKeyCard,
} from "@/components/runtime-account-cards";
import { useAppName } from "@/lib/hooks/use-app-name";

/**
 * Which accounts may run a Claude Code agent: each person's subscription, a
 * company API key, or either, with the company key's connection and model.
 * The same cards say which accounts the Claude Code runtime gives its
 * agents, in the runtime's own settings: there with no connection to pick,
 * since each agent picks its own, and with each agent as the one that
 * chooses. Only the maintained Claude Code runtime runs on a personal Claude
 * subscription.
 */
export function ClaudeCodeInferenceSettings({
  lock,
  noWaySelected = false,
  onLockChange,
  onNoWaySelected,
  waysReadOnly = false,
  lockProblem,
  connectionPickers,
  chooser,
}: {
  /** Which ways are open: no lock leaves both to each person. */
  lock: AgentAccountLock | null;
  /** Neither way is ticked; the form cannot be saved like this. */
  noWaySelected?: boolean;
  onLockChange: (lock: AgentAccountLock | null) => void;
  /** The last ticked way was unticked. */
  onNoWaySelected: () => void;
  /** The viewer may not change which ways are open. */
  waysReadOnly?: boolean;
  /** Why the ticked ways cannot be saved yet. */
  lockProblem?: string | null;
  /** The fields that choose the company connection and its model, if any. */
  connectionPickers?: ReactNode;
  /** Who chooses while both ways are open: each person, unless said. */
  chooser?: AccountChooser;
}) {
  const appName = useAppName();
  return (
    <AgentAccountWays
      label="Accounts that can run it"
      // Each person's own sign-in and model are theirs to set, on the
      // agent's page. Here the option only says the way is allowed.
      subscription={CLAUDE_SUBSCRIPTION_CARD}
      provider={{
        ...companyApiKeyCard(appName),
        children: connectionPickers,
      }}
      lock={lock}
      noneSelected={noWaySelected}
      onLockChange={onLockChange}
      onNoneSelected={onNoWaySelected}
      readOnly={waysReadOnly}
      problem={lockProblem}
      chooser={chooser}
    />
  );
}
