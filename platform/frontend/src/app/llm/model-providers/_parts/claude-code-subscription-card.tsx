"use client";

import { E2eTestId } from "@archestra/shared";
import { Info } from "lucide-react";
import { useState } from "react";
import {
  ClaudeCodeAccountDialog,
  shouldStartClaudeCodeSignIn,
} from "@/components/claude-code-account";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
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
      : "Connect your Claude account to use your subscription.";

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
        notice={
          <InlineNotice variant="warning" plain role="note">
            <Info className="mt-0.5" aria-hidden="true" />
            <InlineNoticeText>
              This subscription works only with Claude Code agent runtimes.
            </InlineNoticeText>
          </InlineNotice>
        }
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
        description="Disconnecting stops new runs from using this account. Active runs keep their token until revoked in Claude."
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
