"use client";

import { isClaudeCodeRuntimeCommand } from "@archestra/shared";
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
 * The same cards say which accounts a Claude runtime gives its agents, in the
 * runtime's own settings: there with no connection to pick, since each agent
 * picks its own, and with each agent as the one that chooses.
 */
export function ClaudeCodeInferenceSettings({
  lock,
  noWaySelected = false,
  onLockChange,
  onNoWaySelected,
  waysReadOnly = false,
  lockProblem,
  connectionPickers,
  runtimeCommand = "archestra-claude-code",
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
  /**
   * First element of `runtime.command`. Any other command than the maintained
   * Claude Code entrypoint is a custom image, which must pass the Claude
   * account variables through for a subscription to work.
   */
  runtimeCommand?: string | null;
  /** Who chooses while both ways are open: each person, unless said. */
  chooser?: AccountChooser;
}) {
  const appName = useAppName();
  const customImage = !isClaudeCodeRuntimeCommand(runtimeCommand);
  return (
    <AgentAccountWays
      label="Credentials to use"
      subscription={{
        ...CLAUDE_SUBSCRIPTION_CARD,
        // Each person's own sign-in and model are theirs to set, on the
        // agent's page. Here the option only says the way is allowed.
        children: customImage ? (
          <p className="text-xs text-muted-foreground">
            <CustomImageSubscriptionHint />
          </p>
        ) : null,
      }}
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

/** When a custom image can use personal Claude subscriptions. */
function CustomImageSubscriptionHint() {
  return (
    <span>
      Choose a personal subscription only for an image that runs Claude Code.
    </span>
  );
}
