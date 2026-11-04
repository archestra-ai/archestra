"use client";

import type { SupportedProvider } from "@archestra/shared";
import Link from "next/link";
import { type ReactNode, useId } from "react";
import { ClaudeCodeAccount } from "@/components/claude-code-account";
import { Label } from "@/components/ui/label";
import {
  RadioGroup,
  RadioGroupItem,
  radioCardClass,
} from "@/components/ui/radio-group";
import { useAppName } from "@/lib/hooks/use-app-name";
import { cn } from "@/lib/utils/tailwind";

export function ClaudeCodeInferenceSettings({
  agentId,
  authentication,
  onAuthenticationChange,
  model,
  onModelChange,
  provider,
  vertexEnabled,
  apiKeySelector,
  modelSelector,
  showModelSelector = true,
  runtimeCommand = "archestra-claude-code",
  disabled = false,
}: {
  agentId: string;
  authentication: "provider" | "subscription";
  onAuthenticationChange: (value: "provider" | "subscription") => void;
  model?: string;
  onModelChange: (value: string) => void;
  provider: SupportedProvider | null;
  vertexEnabled: boolean;
  apiKeySelector: ReactNode;
  modelSelector: ReactNode;
  /** False when no connection can run Claude: there is no model to pick. */
  showModelSelector?: boolean;
  /**
   * First element of `runtime.command`. Personal Claude subscriptions require
   * the `archestra-claude-code` entrypoint; any other command disables the
   * subscription option and explains how to re-enable it.
   */
  runtimeCommand?: string | null;
  /** Disables the runtime-owned authentication radio cards without disabling `apiKeySelector`/`modelSelector`. */
  disabled?: boolean;
}) {
  const id = useId();
  const appName = useAppName();
  const subscriptionSupported = runtimeCommand === "archestra-claude-code";
  const trimmedCommand = runtimeCommand?.trim() || null;
  const customCommand =
    trimmedCommand && trimmedCommand !== "archestra-claude-code"
      ? trimmedCommand
      : null;
  const effectiveAuthentication = subscriptionSupported
    ? authentication
    : "provider";
  return (
    <div className="space-y-2">
      <RadioGroup
        aria-label="Authentication"
        disabled={disabled}
        value={effectiveAuthentication}
        onValueChange={(value) =>
          onAuthenticationChange(value as "provider" | "subscription")
        }
        className="grid-cols-1 gap-2.5 sm:grid-cols-2"
      >
        {(
          [
            [
              "subscription",
              "Each person's Claude subscription",
              "Pro or Max. Everyone who uses the agent signs in once. Not billed to the company, no cost limits.",
            ],
            [
              "provider",
              "A company API key",
              `An LLM provider connection set up in ${appName}. Billed to the company; cost limits apply.`,
            ],
          ] as const
        ).map(([value, title, description]) => {
          const cardDisabled =
            disabled || (value === "subscription" && !subscriptionSupported);
          return (
            <Label
              key={value}
              htmlFor={`${id}-${value}`}
              className={cn(
                "flex cursor-pointer items-start gap-2.5 rounded-[10px] p-3.5 font-normal",
                radioCardClass({
                  checked: effectiveAuthentication === value,
                  disabled: cardDisabled,
                }),
                effectiveAuthentication === value && "bg-primary/5",
              )}
            >
              <RadioGroupItem
                id={`${id}-${value}`}
                value={value}
                disabled={cardDisabled}
                className="mt-0.5"
              />
              <span className="space-y-0.5">
                <span className="block text-sm font-medium">{title}</span>
                <span className="block text-[13px] leading-[1.45] text-muted-foreground">
                  {description}
                </span>
              </span>
            </Label>
          );
        })}
      </RadioGroup>
      {!subscriptionSupported ? (
        <p key="unsupported" className="text-xs text-muted-foreground">
          {customCommand
            ? `To use personal Claude subscriptions, change Dedicated runtime → Container → Command to archestra-claude-code. Any custom logic in the current ${customCommand} entrypoint will be lost.`
            : "To use personal Claude subscriptions, change Dedicated runtime → Container → Command to archestra-claude-code. Any custom logic in the current entrypoint will be lost."}
        </p>
      ) : effectiveAuthentication === "subscription" ? (
        <p key="subscription" className="text-xs text-muted-foreground">
          {agentId
            ? "Each person connects their own Claude account once. A run's container only gets a short-lived key."
            : "You connect your Claude account right after creating. A run's container only gets a short-lived key."}
        </p>
      ) : null}
      {effectiveAuthentication === "subscription" ? (
        // Before the agent exists there is nothing to sign in to; the hint
        // above already says when that happens.
        agentId ? (
          <ClaudeCodeAccount
            agentId={agentId}
            variant="compact"
            showDisconnectedNotice={false}
            model={model}
            onModelChange={onModelChange}
          />
        ) : null
      ) : (
        <div className="space-y-4 pt-1">
          <div className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <Label>Which connection pays</Label>
              <Link
                href="/llm/model-providers"
                className="text-[13px] text-primary underline-offset-4 hover:underline"
              >
                Manage LLM providers
              </Link>
            </div>
            {apiKeySelector}
          </div>
          {showModelSelector && (
            <div className="space-y-2">
              <Label>Model</Label>
              <div>{modelSelector}</div>
            </div>
          )}
          <p className="text-[13px] text-muted-foreground">
            {provider === "bedrock"
              ? `Billed through Amazon Bedrock. Each run gets a short-lived virtual key; the real credentials stay in ${appName}.`
              : provider === "anthropic" && vertexEnabled
                ? `Billed through Google Cloud (Vertex AI). Each run gets a short-lived virtual key; the real credentials stay in ${appName}.`
                : `Each run gets a short-lived virtual key. The real key stays in ${appName}.`}
          </p>
        </div>
      )}
    </div>
  );
}
