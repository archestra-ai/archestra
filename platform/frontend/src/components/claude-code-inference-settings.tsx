"use client";

import type { SupportedProvider } from "@archestra/shared";
import { type ReactNode, useId } from "react";
import { ClaudeCodeAccount } from "@/components/claude-code-account";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";

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
}) {
  const id = useId();
  return (
    <div className="space-y-2">
      <RadioGroup
        aria-label="Authentication"
        value={authentication}
        onValueChange={(value) =>
          onAuthenticationChange(value as "provider" | "subscription")
        }
        className="grid-cols-1 gap-0 overflow-hidden rounded-lg border sm:grid-cols-2"
      >
        {(
          [
            [
              "provider",
              "API key or cloud provider",
              "Billed to the selected provider connection.",
            ],
            [
              "subscription",
              "Personal Claude subscription",
              "Use your own Claude Pro or Max account.",
            ],
          ] as const
        ).map(([value, title, description], index) => (
          <Label
            key={value}
            htmlFor={`${id}-${value}`}
            className={cn(
              "flex cursor-pointer items-center gap-2.5 px-3 py-2 font-normal transition-colors",
              index === 1 && "border-t sm:border-l sm:border-t-0",
              authentication === value ? "bg-primary/10" : "hover:bg-muted/50",
            )}
          >
            <RadioGroupItem id={`${id}-${value}`} value={value} />
            <span className="space-y-0.5">
              <span className="block text-[13px] leading-5 font-medium">
                {title}
              </span>
              <span className="block text-xs leading-4 text-muted-foreground">
                {description}
              </span>
            </span>
          </Label>
        ))}
      </RadioGroup>
      <p className="text-xs text-muted-foreground">
        {authentication === "subscription"
          ? "Each person using this agent must sign in to their own Claude Code account before they can run it. Your subscription is never shared."
          : provider === "bedrock"
            ? "Uses Amazon Bedrock billing."
            : provider === "anthropic" && vertexEnabled
              ? "Uses Google Cloud (Vertex AI) billing."
              : "Uses the selected API connection for usage-based billing."}
      </p>
      {authentication === "subscription" ? (
        <div className="pt-2">
          <ClaudeCodeAccount
            agentId={agentId}
            model={model}
            onModelChange={onModelChange}
          />
        </div>
      ) : (
        <div className="space-y-2 pt-2">
          <Label>Provider and model</Label>
          <div className="flex flex-wrap items-center gap-2">
            {apiKeySelector}
            {modelSelector}
          </div>
        </div>
      )}
    </div>
  );
}
