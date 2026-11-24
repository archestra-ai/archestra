"use client";

import { E2eTestId } from "@archestra/shared";
import { useState } from "react";
import {
  ClaudeCodeAccountDialog,
  shouldStartClaudeCodeSignIn,
} from "@/components/claude-code-account";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import {
  useDisconnectMyClaudeCodeAccount,
  useMyClaudeCodeAccount,
  useMyClaudeCodeSignIn,
} from "@/lib/claude-code-account.query";
import {
  SubscriptionCard,
  type SubscriptionCardStatus,
} from "./subscription-provider-cards";

/**
 * Your personal Claude Pro or Max subscription card inside the Personal
 * subscriptions grid on Model Providers. Connects once for every Claude Code
 * agent you run.
 */
export function ClaudeCodeSubscriptionCard({
  canAddAnthropic,
}: {
  /** Whether the organization leaves Anthropic switched on for new connections. */
  canAddAnthropic: boolean;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);

  const account = useMyClaudeCodeAccount(true, dialogOpen);
  const signIn = useMyClaudeCodeSignIn();
  const disconnect = useDisconnectMyClaudeCodeAccount();

  const state = account.data?.state;
  const connected = state === "connected";
  const expired = state === "expired";
  const hasStoredAccount = connected || expired;

  if (!canAddAnthropic && !hasStoredAccount) return null;

  const status: SubscriptionCardStatus = account.isError
    ? "error"
    : connected
      ? "connected"
      : expired
        ? "reconnect"
        : "not-connected";

  const description = account.isError
    ? "Could not check your Claude Code subscription."
    : expired
      ? "Your sign-in expired or was revoked. Sign in again to use this subscription."
      : connected
        ? "Your Claude Pro or Max subscription is linked for all your Claude Code agents."
        : "Connect your Claude Pro or Max subscription for Claude Code agents.";

  const openAccountDialog = () => {
    setDialogOpen(true);
    if (
      !shouldStartClaudeCodeSignIn({
        connected,
        signInPending: signIn.isPending,
        state,
      })
    )
      return;
    setSubmitted(true);
    signIn.reset();
    signIn.mutate(undefined);
  };

  return (
    <>
      <SubscriptionCard
        testId={`${E2eTestId.SubscriptionProviderCard}-claude-code`}
        provider="anthropic"
        name="Claude Code"
        description={description}
        isLoading={account.isPending}
        status={status}
        onRetry={() => void account.refetch()}
        onConnect={canAddAnthropic ? openAccountDialog : undefined}
        manage={
          connected
            ? {
                onClick: () => setDialogOpen(true),
                permissions: {},
              }
            : undefined
        }
        disconnect={
          hasStoredAccount
            ? {
                permissions: {},
                blockedReason: null,
                onClick: () => setDisconnectOpen(true),
              }
            : undefined
        }
      />
      <ClaudeCodeAccountDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        account={account}
        signIn={signIn}
        disconnect={disconnect}
        submitted={submitted}
        onSubmittedChange={setSubmitted}
      />
      <DeleteConfirmDialog
        open={disconnectOpen}
        onOpenChange={setDisconnectOpen}
        title="Disconnect Claude Code"
        description="Disconnect prevents new runs across all your Claude Code agents from using this account. Running sessions keep their token. Revoke the token in Claude to end its access."
        confirmLabel="Disconnect"
        pendingLabel="Disconnecting..."
        isPending={disconnect.isPending}
        onConfirm={() => {
          disconnect.mutate(undefined, {
            onSuccess: () => setDisconnectOpen(false),
          });
        }}
      />
    </>
  );
}
