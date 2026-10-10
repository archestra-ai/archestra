"use client";

import type { SupportedProvider } from "@archestra/shared";
import { Key } from "lucide-react";
import Image from "next/image";
import { useId } from "react";
import { PROVIDER_CONFIG } from "@/components/llm-provider-api-key-form";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import { isPersonalSubscription } from "@/lib/llm-key-subscription";
import type { LlmProviderApiKey } from "@/lib/llm-provider-api-keys.query";
import { cn } from "@/lib/utils/tailwind";

type ConnectionKey = Pick<LlmProviderApiKey, "id" | "name" | "provider"> &
  Partial<Pick<LlmProviderApiKey, "scope" | "teamName" | "subscriptionKind">>;

/**
 * Which company connection pays for a Claude Code agent, as a short list of
 * the connections that can run Claude rather than a dropdown of every key.
 * The rest are counted, so the reader knows why theirs is missing.
 */
export function ClaudeProviderConnections({
  keys,
  selectedKeyId,
  onSelect,
  canRunClaude,
  onAddApiKey,
  onUseSubscription,
  disabled = false,
}: {
  keys: ConnectionKey[];
  selectedKeyId: string | null;
  onSelect: (keyId: string) => void;
  canRunClaude: (provider: SupportedProvider) => boolean;
  onAddApiKey?: () => void;
  onUseSubscription: () => void;
  disabled?: boolean;
}) {
  const id = useId();
  const providers = useModelProviderCatalog();
  const companyKeys = keys.filter((key) => !isPersonalSubscription(key));
  const compatible = companyKeys.filter((key) => canRunClaude(key.provider));
  const hiddenCount = companyKeys.length - compatible.length;

  if (!compatible.length) {
    return (
      <div className="flex flex-col items-center gap-2.5 rounded-xl border border-dashed px-4 py-6 text-center">
        <p className="text-sm font-medium">No connection here can run Claude</p>
        <p className="max-w-md text-[13px] leading-normal text-muted-foreground">
          Claude Code needs an Anthropic API key, Amazon Bedrock, or Vertex AI
          with Anthropic models.
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          {onAddApiKey && (
            <Button
              type="button"
              size="sm"
              onClick={onAddApiKey}
              disabled={disabled}
            >
              Add an Anthropic key
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onUseSubscription}
            disabled={disabled}
          >
            Use each person&apos;s subscription
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <RadioGroup
        aria-label="Which connection pays"
        value={selectedKeyId ?? ""}
        onValueChange={onSelect}
        disabled={disabled}
        className="gap-0 overflow-hidden rounded-xl border bg-card"
      >
        {compatible.map((key) => {
          const selected = key.id === selectedKeyId;
          return (
            <Label
              key={key.id}
              htmlFor={`${id}-${key.id}`}
              className={cn(
                "flex cursor-pointer items-center gap-3 border-t px-3.5 py-3 font-normal first:border-t-0",
                selected ? "bg-primary/5" : "hover:bg-muted/40",
              )}
            >
              <RadioGroupItem id={`${id}-${key.id}`} value={key.id} />
              <ProviderLogo provider={key.provider} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {key.name}
                </span>
                <span className="block truncate text-[13px] text-muted-foreground">
                  {providers.label(key.provider)} · {scopeLabel(key)}
                </span>
              </span>
            </Label>
          );
        })}
      </RadioGroup>
      {hiddenCount > 0 && (
        <p className="text-[13px] text-muted-foreground">
          Only connections that can run Claude are listed. {hiddenCount}{" "}
          {hiddenCount === 1 ? "other is" : "others are"} hidden.
        </p>
      )}
      {onAddApiKey && (
        <Button
          type="button"
          size="sm"
          variant="link"
          className="h-auto px-0"
          onClick={onAddApiKey}
          disabled={disabled}
        >
          Add a connection
        </Button>
      )}
    </div>
  );
}

function ProviderLogo({ provider }: { provider: SupportedProvider }) {
  const icon = PROVIDER_CONFIG[provider]?.icon;
  return (
    <span
      aria-hidden="true"
      className="flex size-7 shrink-0 items-center justify-center rounded-md border bg-background"
    >
      {icon ? (
        <Image
          src={icon}
          alt=""
          width={16}
          height={16}
          className="rounded dark:invert"
        />
      ) : (
        <Key className="size-3.5" />
      )}
    </span>
  );
}

function scopeLabel(key: ConnectionKey): string {
  if (key.scope === "team")
    return key.teamName ? `${key.teamName} team` : "Team key";
  if (key.scope === "personal") return "Your key";
  return "Organization";
}
