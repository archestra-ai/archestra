"use client";

import type { SupportedProvider } from "@archestra/shared";
import { ChevronDown } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function ClaudeCodeInferenceSettings({
  provider,
  vertexEnabled,
  availableProviders,
  onProviderChange,
  apiKeySelector,
  modelSelector,
  subscriptionCredential,
}: {
  provider: SupportedProvider | null;
  vertexEnabled: boolean;
  availableProviders: SupportedProvider[];
  onProviderChange: (provider: "anthropic" | "bedrock") => void;
  apiKeySelector: ReactNode;
  modelSelector: ReactNode;
  subscriptionCredential: ReactNode;
}) {
  const sourceId = useId();
  const subscription = provider === "anthropic" && !vertexEnabled;
  const cloud =
    provider === "bedrock" || (provider === "anthropic" && vertexEnabled);
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={sourceId}>Pay with</Label>
        <Select
          value={
            provider === "anthropic" || provider === "bedrock" ? provider : ""
          }
          onValueChange={(value) => {
            if (value === "anthropic" || value === "bedrock")
              onProviderChange(value);
          }}
        >
          <SelectTrigger id={sourceId} className="w-full sm:w-72">
            <SelectValue placeholder="Choose an inference source" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem
              value="anthropic"
              disabled={!availableProviders.includes("anthropic")}
            >
              {vertexEnabled
                ? "Google Cloud (Vertex AI)"
                : "Claude subscription"}
            </SelectItem>
            <SelectItem
              value="bedrock"
              disabled={!availableProviders.includes("bedrock")}
            >
              Amazon Bedrock
            </SelectItem>
          </SelectContent>
        </Select>
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {subscription
            ? "Each person uses their own Claude subscription. The provider API key is not used for inference."
            : cloud
              ? "Runs use cloud provider billing. Your Claude subscription token is not sent or required."
              : "Choose a provider connection to select the model and billing source."}
        </p>
      </div>
      {availableProviders.length === 0 && (
        <Button asChild type="button" variant="outline" size="sm">
          <Link href="/llm/model-providers">Add a model provider</Link>
        </Button>
      )}
      {subscription && subscriptionCredential}
      <div className="space-y-2">
        <Label>Model</Label>
        <div className="flex flex-wrap items-center gap-2">
          {cloud && apiKeySelector}
          {modelSelector}
        </div>
      </div>
      {!cloud && (
        <Collapsible defaultOpen={!provider}>
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="-ml-2 text-muted-foreground"
            >
              <ChevronDown className="size-4" />
              <span>Model catalog</span>
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-2 pt-2">
            <p className="text-xs text-muted-foreground">
              This connection supplies the list of available models.
              Subscription runs do not use its API key.
            </p>
            {apiKeySelector}
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
