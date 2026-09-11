"use client";

import { CheckCircle2, ExternalLink, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ModelSelector } from "@/components/chat/model-selector";
import { QueryLoadError } from "@/components/query-load-error";
import { RuntimeCredentialIcon } from "@/components/runtime-credential-icon";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import {
  useClaudeCodeAccount,
  useClaudeCodeModels,
  useClaudeCodeSignIn,
  useDisconnectClaudeCodeAccount,
} from "@/lib/claude-code-account.query";
import type { LlmModel } from "@/lib/llm-models.query";

export function ClaudeCodeAccount({
  agentId,
  model,
  onModelChange,
}: {
  agentId: string;
  model?: string;
  onModelChange?: (model: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const account = useClaudeCodeAccount(agentId, open);
  const connected = account.data?.state === "connected";
  const discoveredModels = useClaudeCodeModels(
    agentId,
    connected && Boolean(onModelChange),
  );
  const signIn = useClaudeCodeSignIn(agentId);
  const disconnect = useDisconnectClaudeCodeAccount(agentId);
  const models = useMemo<LlmModel[]>(
    () =>
      (discoveredModels.data ?? []).map((entry) => ({
        id: entry.value,
        dbId: entry.value,
        displayName: entry.displayName,
        provider: "anthropic",
        isFree: false,
      })),
    [discoveredModels.data],
  );
  useEffect(() => {
    if (submitted && connected) {
      setOpen(false);
      setSubmitted(false);
      setCode("");
    }
  }, [submitted, connected]);

  if (!agentId)
    return (
      <p className="text-sm text-muted-foreground">
        Save this agent to connect your Claude Code account.
      </p>
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2.5">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background">
          <RuntimeCredentialIcon icon="logo:anthropic" className="size-4" />
        </div>
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-sm font-medium">Claude Code</p>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {connected && <CheckCircle2 className="size-3.5 text-green-500" />}
            <span>
              {account.isPending
                ? "Checking connection…"
                : account.isError
                  ? "Could not check connection"
                  : connected
                    ? "Signed in for you"
                    : "Sign in to use this agent."}
            </span>
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 shrink-0 gap-1.5 px-2.5 text-xs"
          onClick={() => setOpen(true)}
          disabled={account.isPending}
        >
          <span>{connected ? "Manage" : "Sign in"}</span>
          <ExternalLink className="size-3" />
        </Button>
      </div>
      {connected && onModelChange && (
        <div className="space-y-2">
          <Label>Model</Label>
          {discoveredModels.isPending ? (
            <p className="text-sm text-muted-foreground">
              Loading models from Claude Code…
            </p>
          ) : discoveredModels.isError ? (
            <QueryLoadError
              title="Could not load Claude Code models"
              onRetry={() => void discoveredModels.refetch()}
            />
          ) : (
            <div>
              <ModelSelector
                models={models}
                selectedModel={model ?? "default"}
                onModelChange={(value) => {
                  if (value) onModelChange(value);
                }}
                variant="outline"
                suppressAutoSelect
              />
            </div>
          )}
        </div>
      )}
      <StandardDialog
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (!value) setCode("");
        }}
        title={connected ? "Claude Code account" : "Connect Claude Code"}
        description="Use your personal Claude Pro or Max subscription in this Claude Code runtime. Each person connects their own account."
        size="small"
        className="sm:max-w-xl"
        footer={
          <>
            <DialogCancelButton>Cancel</DialogCancelButton>
            {account.data?.state === "awaiting_code" && (
              <Button
                type="button"
                disabled={!code.trim() || signIn.isPending}
                onClick={() => {
                  if (!account.data?.flowId) return;
                  setSubmitted(true);
                  signIn.mutate(
                    { flowId: account.data.flowId, code: code.trim() },
                    { onSuccess: () => setCode("") },
                  );
                }}
              >
                <span>Complete sign-in</span>
              </Button>
            )}
          </>
        }
      >
        {account.isError ? (
          <QueryLoadError
            title="Could not check Claude Code"
            onRetry={() => void account.refetch()}
          />
        ) : connected ? (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-md border border-green-500/40 bg-green-500/10 p-3 text-sm">
              <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-green-500" />
              <div>
                <p className="font-medium text-green-600 dark:text-green-400">
                  Connected for you
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Only you can use this account. Other users sign in separately.
                </p>
              </div>
            </div>
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
        ) : account.data?.state === "awaiting_code" ? (
          <div className="space-y-4">
            <Button variant="outline" size="sm" asChild>
              <a
                href={account.data.authorizationUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <RuntimeCredentialIcon
                  icon="logo:anthropic"
                  className="size-4"
                />
                <span>Open Claude sign-in</span>
                <ExternalLink className="size-3.5" />
              </a>
            </Button>
            <div className="space-y-2">
              <Label htmlFor="claude-authorization-code">
                Authorization code
              </Label>
              <Input
                id="claude-authorization-code"
                type="password"
                autoComplete="off"
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                After signing in, paste the code Claude shows you.
              </p>
            </div>
          </div>
        ) : signIn.isPending ||
          account.data?.state === "starting" ||
          account.data?.state === "connecting" ? (
          <output className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            <span>
              {account.data?.state === "connecting"
                ? "Completing sign-in…"
                : "Preparing Claude Code…"}
            </span>
          </output>
        ) : (
          <div className="space-y-2">
            {account.data?.state === "failed" && (
              <p role="alert" className="text-sm text-destructive">
                Sign-in did not complete. Please try again.
              </p>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => signIn.mutate(undefined)}
            >
              <RuntimeCredentialIcon icon="logo:anthropic" className="size-4" />
              <span>Sign in with Claude</span>
            </Button>
          </div>
        )}
      </StandardDialog>
    </div>
  );
}
