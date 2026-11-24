"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { CheckCircle2, ExternalLink, Loader2, Unplug } from "lucide-react";
import { useEffect, useState } from "react";
import { ClaudeCodeSignInSteps } from "@/components/claude-code-sign-in-steps";
import { QueryLoadError } from "@/components/query-load-error";
import { RuntimeCredentialIcon } from "@/components/runtime-credential-icon";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import {
  useClaudeCodeAccount,
  useClaudeCodeSignIn,
  useDisconnectClaudeCodeAccount,
} from "@/lib/claude-code-account.query";

type ClaudeCodeAccountQuery = {
  data: archestraApiTypes.GetClaudeCodeAccountResponses["200"] | undefined;
  isError: boolean;
  error: unknown;
  refetch: () => unknown;
};

type ClaudeCodeSignInMutation = {
  mutate: (
    body:
      | archestraApiTypes.CompleteClaudeCodeSignInData["body"]
      | archestraApiTypes.StartClaudeCodeSignInData["body"]
      | undefined,
    options?: { onSuccess?: () => void },
  ) => void;
  reset: () => void;
  isPending: boolean;
  isError: boolean;
};

type ClaudeCodeDisconnectMutation = {
  mutate: () => void;
  isPending: boolean;
};

/**
 * Shared sign-in and connection-management dialog for a user's personal Claude
 * Code subscription, used both on agent pages and on Model Providers.
 */
export function ClaudeCodeAccountDialog({
  open,
  onOpenChange,
  account,
  signIn,
  disconnect,
  submitted,
  onSubmittedChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: ClaudeCodeAccountQuery;
  signIn: ClaudeCodeSignInMutation;
  disconnect: ClaudeCodeDisconnectMutation;
  submitted: boolean;
  onSubmittedChange: (value: boolean) => void;
}) {
  const [code, setCode] = useState("");
  const [vaultReference, setVaultReference] = useState("");
  const connected = account.data?.state === "connected";

  useEffect(() => {
    if (submitted && connected) {
      onOpenChange(false);
      onSubmittedChange(false);
      setCode("");
      setVaultReference("");
    }
  }, [submitted, connected, onOpenChange, onSubmittedChange]);

  const {
    mutate: finishSignIn,
    isPending: finishing,
    isError: signInFailed,
  } = signIn;
  const flowId = account.data?.flowId;
  const state = account.data?.state;
  useEffect(() => {
    if (!open || state !== "connecting" || !flowId || finishing || signInFailed)
      return;
    const timer = setTimeout(() => {
      onSubmittedChange(true);
      finishSignIn({ flowId });
    }, 2000);
    return () => clearTimeout(timer);
  }, [
    open,
    state,
    flowId,
    finishing,
    signInFailed,
    finishSignIn,
    onSubmittedChange,
  ]);

  const completeSignIn = () => {
    if (!account.data?.flowId) return;
    onSubmittedChange(true);
    signIn.mutate(
      { flowId: account.data.flowId, code: code.trim() },
      { onSuccess: () => setCode("") },
    );
  };

  return (
    <StandardDialog
      open={open}
      onOpenChange={(value) => {
        onOpenChange(value);
        if (!value) setCode("");
      }}
      title={connected ? "Claude Code account" : "Connect Claude Code"}
      description="Connect your Claude account to use your subscription."
      size="small"
      className="sm:max-w-xl"
      footer={
        <>
          <DialogCancelButton>Cancel</DialogCancelButton>
          {account.data?.state === "awaiting_code" && (
            <Button
              type="button"
              disabled={!code.trim() || signIn.isPending}
              onClick={completeSignIn}
            >
              <span>Complete sign-in</span>
            </Button>
          )}
        </>
      }
    >
      <ClaudeCodeAccountFlow
        account={account}
        signIn={signIn}
        disconnect={disconnect}
        code={code}
        onCodeChange={setCode}
        vaultReference={vaultReference}
        onVaultReferenceChange={setVaultReference}
        onStartSignIn={() => {
          onSubmittedChange(true);
          signIn.mutate(
            account.data?.requiresVaultReference
              ? { vaultReference: vaultReference.trim() }
              : undefined,
          );
        }}
        onCompleteSignIn={completeSignIn}
      />
    </StandardDialog>
  );
}

/** Whether opening the Claude Code dialog should start a fresh OAuth flow. */
export function shouldStartClaudeCodeSignIn(params: {
  connected: boolean;
  requiresVaultReference?: boolean;
  signInPending: boolean;
  state:
    | archestraApiTypes.GetClaudeCodeAccountResponses["200"]["state"]
    | undefined;
}): boolean {
  if (params.connected || params.requiresVaultReference || params.signInPending)
    return false;
  return !(
    params.state &&
    ["starting", "connecting", "awaiting_code"].includes(params.state)
  );
}

export function ClaudeCodeAccount({
  agentId,
  variant,
}: {
  agentId: string;
  /**
   * `row` is a line of a list, `compact` a notice. `button` renders only the
   * sign-in button, and nothing once connected or before that is known.
   * `disconnect` renders only an icon that disconnects a connected account.
   * `inline` signs in right where it sits, inside another dialog, rather than
   * opening a dialog of its own.
   */
  variant: "row" | "compact" | "button" | "disconnect" | "inline";
}) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [vaultReference, setVaultReference] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const account = useClaudeCodeAccount(agentId, open);
  const connected = account.data?.state === "connected";
  const signIn = useClaudeCodeSignIn(agentId);
  const disconnect = useDisconnectClaudeCodeAccount(agentId);
  const state = account.data?.state;

  // Inline variant renders without ClaudeCodeAccountDialog, so keep its own
  // completion effects scoped to inline.
  useEffect(() => {
    if (variant !== "inline") return;
    if (submitted && connected) {
      setOpen(false);
      setSubmitted(false);
      setCode("");
    }
  }, [variant, submitted, connected]);

  const {
    mutate: finishSignIn,
    isPending: finishing,
    isError: signInFailed,
  } = signIn;
  const flowId = account.data?.flowId;
  useEffect(() => {
    if (variant !== "inline") return;
    if (!open || state !== "connecting" || !flowId || finishing || signInFailed)
      return;
    const timer = setTimeout(() => {
      setSubmitted(true);
      finishSignIn({ flowId });
    }, 2000);
    return () => clearTimeout(timer);
  }, [variant, open, state, flowId, finishing, signInFailed, finishSignIn]);

  // Opening the dialog to sign in is asking to sign in, so the flow starts
  // straight away instead of behind a second "Sign in with Claude" button.
  // A Vault reference has to be entered first, and a flow already under way
  // is picked up where it is.
  const openAccount = () => {
    setOpen(true);
    if (
      !shouldStartClaudeCodeSignIn({
        connected,
        requiresVaultReference: account.data?.requiresVaultReference,
        signInPending: signIn.isPending,
        state,
      })
    )
      return;
    setSubmitted(true);
    signIn.reset();
    signIn.mutate(undefined);
  };

  const completeSignIn = () => {
    if (!account.data?.flowId) return;
    setSubmitted(true);
    signIn.mutate(
      { flowId: account.data.flowId, code: code.trim() },
      { onSuccess: () => setCode("") },
    );
  };

  const statusText = account.isPending
    ? "Checking connection…"
    : account.isError
      ? "Could not check connection"
      : connected
        ? "Signed in for you"
        : account.data?.state === "expired"
          ? "Connection expired. Sign in again."
          : variant === "row"
            ? "Sign in once for all your Claude Code agents."
            : "Sign in to use this agent.";

  if (!agentId)
    return (
      <p className="text-sm text-muted-foreground">
        Save this agent to connect your Claude Code account.
      </p>
    );

  if (variant === "inline") {
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
          <RuntimeCredentialIcon
            icon="logo:anthropic"
            className="size-4 shrink-0"
            size={16}
          />
          <span className="text-sm font-medium">Claude subscription</span>
          {connected ? (
            <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
              <CheckCircle2 className="size-3.5 text-green-500" aria-hidden />
              <span>Signed in for you</span>
            </span>
          ) : (
            !open && (
              <Button
                type="button"
                size="sm"
                className="ml-auto"
                onClick={openAccount}
                disabled={account.isPending}
              >
                Sign in with Claude
              </Button>
            )
          )}
        </div>
        {open && !connected && (
          <ClaudeCodeAccountFlow
            account={account}
            signIn={signIn}
            disconnect={disconnect}
            code={code}
            onCodeChange={setCode}
            vaultReference={vaultReference}
            onVaultReferenceChange={setVaultReference}
            onStartSignIn={() => {
              setSubmitted(true);
              signIn.mutate(
                account.data?.requiresVaultReference
                  ? { vaultReference: vaultReference.trim() }
                  : undefined,
              );
            }}
            onCompleteSignIn={completeSignIn}
            submitLabel="Connect"
          />
        )}
      </div>
    );
  }

  return (
    <div
      className={
        variant === "button" || variant === "disconnect"
          ? "contents"
          : "space-y-4"
      }
    >
      {variant === "disconnect" ? (
        // Disconnects at once: the click is the decision, and signing in
        // again is one button away. In the card's text colour: it sits beside
        // the model, not where the eye should land first.
        connected && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Disconnect"
                  disabled={disconnect.isPending}
                  onClick={() => disconnect.mutate()}
                >
                  <Unplug />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Disconnect your Claude account</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )
      ) : variant === "button" ? (
        // Nothing until the account has answered: a connected person never
        // sees a sign-in flash by.
        !account.isPending &&
        !connected && (
          <Button type="button" size="sm" onClick={openAccount}>
            <span>Sign in</span>
          </Button>
        )
      ) : variant === "compact" ? (
        <InlineNotice
          variant={connected ? "success" : "warning"}
          role={connected ? "status" : "alert"}
        >
          <RuntimeCredentialIcon icon="logo:anthropic" className="size-3.5" />
          <span className="font-medium">Claude Code</span>
          <InlineNoticeText>{statusText}</InlineNoticeText>
          {connected && <CheckCircle2 aria-label="Connected" />}
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="ml-auto shrink-0 bg-background"
            onClick={openAccount}
            disabled={account.isPending}
          >
            <span>{connected ? "Manage" : "Sign in"}</span>
            <ExternalLink className="size-3" />
          </Button>
        </InlineNotice>
      ) : (
        <div className="flex flex-wrap items-center gap-3 p-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background">
            <RuntimeCredentialIcon icon="logo:anthropic" className="size-4" />
          </div>
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="text-sm font-medium">Claude Code</p>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {connected && (
                <CheckCircle2 className="size-3.5 text-green-500" />
              )}
              <span>{statusText}</span>
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="shrink-0"
            onClick={openAccount}
            disabled={account.isPending}
          >
            <span>{connected ? "Manage" : "Sign in"}</span>
            <ExternalLink className="size-3" />
          </Button>
        </div>
      )}
      <ClaudeCodeAccountDialog
        open={open}
        onOpenChange={setOpen}
        account={account}
        signIn={signIn}
        disconnect={disconnect}
        submitted={submitted}
        onSubmittedChange={setSubmitted}
      />
    </div>
  );
}

// ===

function ClaudeCodeAccountFlow({
  account,
  signIn,
  disconnect,
  code,
  onCodeChange,
  vaultReference,
  onVaultReferenceChange,
  onStartSignIn,
  onCompleteSignIn,
  submitLabel,
}: {
  account: ClaudeCodeAccountQuery;
  signIn: ClaudeCodeSignInMutation;
  disconnect: ClaudeCodeDisconnectMutation;
  code: string;
  onCodeChange: (value: string) => void;
  vaultReference: string;
  onVaultReferenceChange: (value: string) => void;
  onStartSignIn: () => void;
  onCompleteSignIn: () => void;
  submitLabel?: string;
}) {
  const connected = account.data?.state === "connected";

  if (account.isError) {
    return (
      <QueryLoadError
        title="Could not check Claude Code"
        error={account.error}
        onRetry={() => void account.refetch()}
      />
    );
  }

  if (connected) {
    return (
      <div className="space-y-3">
        <div className="flex items-start gap-2 rounded-md border border-green-500/40 bg-green-500/10 p-3 text-sm">
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-green-500" />
          <div>
            <p className="font-medium text-green-600 dark:text-green-400">
              Connected for you
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Available to all your Claude Code agents.
            </p>
          </div>
        </div>
        {account.data?.expiresAt && (
          <p className="text-xs text-muted-foreground">
            Reconnect by {new Date(account.data.expiresAt).toLocaleDateString()}
            .
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Disconnecting stops new runs from using this account. Active runs keep
          their token until revoked in Claude.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disconnect.isPending}
          onClick={() => disconnect.mutate()}
        >
          <span>Disconnect</span>
        </Button>
      </div>
    );
  }

  if (signIn.isError) {
    return (
      <div className="space-y-2">
        <p role="alert" className="text-sm text-destructive">
          Could not complete sign-in. Please try again.
        </p>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            signIn.reset();
            signIn.mutate(vaultReference ? { vaultReference } : undefined);
          }}
        >
          Try again
        </Button>
      </div>
    );
  }

  if (account.data?.state === "awaiting_code") {
    return (
      <ClaudeCodeSignInSteps
        authorizationUrl={account.data.authorizationUrl}
        code={code}
        onCodeChange={onCodeChange}
        onSubmit={onCompleteSignIn}
        submitting={signIn.isPending}
        submitLabel={submitLabel}
      />
    );
  }

  if (
    signIn.isPending ||
    account.data?.state === "starting" ||
    account.data?.state === "connecting"
  ) {
    return (
      <div className="space-y-2">
        <output className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          <span>
            {account.data?.state === "connecting"
              ? "Completing sign-in…"
              : "Preparing Claude sign-in…"}
          </span>
        </output>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {account.data?.state === "failed" && (
        <p role="alert" className="text-sm text-destructive">
          Sign-in did not complete. Please try again.
        </p>
      )}
      {account.data?.state === "expired" && (
        <p className="text-sm text-muted-foreground">
          Your connection expired. Sign in again to start new runs.
        </p>
      )}

      {/* SPDX-SnippetBegin */}
      {/* SPDX-SnippetCopyrightText: 2026 Archestra Inc. */}
      {/* SPDX-License-Identifier: LicenseRef-Archestra-Enterprise */}
      {account.data?.requiresVaultReference && (
        <div className="space-y-2">
          <Label htmlFor="claude-vault-reference">Vault reference</Label>
          <Input
            id="claude-vault-reference"
            autoComplete="off"
            placeholder="path/to/secret#key"
            value={vaultReference}
            onChange={(event) => onVaultReferenceChange(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Generate a token with <code>claude setup-token</code>, store it in
            Vault, then enter its path#key reference.
          </p>
        </div>
      )}
      {/* SPDX-SnippetEnd */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={
          account.data?.requiresVaultReference && !vaultReference.trim()
        }
        onClick={onStartSignIn}
      >
        <RuntimeCredentialIcon icon="logo:anthropic" className="size-4" />
        <span>
          {account.data?.requiresVaultReference
            ? "Connect Vault credential"
            : "Sign in with Claude"}
        </span>
      </Button>
    </div>
  );
}
