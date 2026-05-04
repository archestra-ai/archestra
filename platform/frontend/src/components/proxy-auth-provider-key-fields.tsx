"use client";

import { DocsPage, E2eTestId, getDocsUrl } from "@shared";
import {
  type LlmProviderApiKeyResponse,
  PROVIDER_CONFIG,
} from "@/components/llm-provider-api-key-form";
import { LlmProviderApiKeySelectItems } from "@/components/llm-provider-options";
import {
  type ModelRouterProviderApiKeyMap,
  ModelRouterProviderKeyMappingsField,
} from "@/components/model-router-provider-key-mappings-field";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function ProviderApiKeyField({
  value,
  onValueChange,
  providerApiKeys,
  allowNone = false,
}: {
  value: string;
  onValueChange: (value: string) => void;
  providerApiKeys: LlmProviderApiKeyResponse[];
  allowNone?: boolean;
}) {
  return (
    <div className="space-y-2">
      <Label>Provider API Key</Label>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger
          className="w-full"
          data-testid={E2eTestId.VirtualKeyParentKeySelect}
        >
          <SelectValue placeholder="Select an API key" />
        </SelectTrigger>
        <SelectContent>
          {allowNone && (
            <SelectItem value="none">No provider API key</SelectItem>
          )}
          <LlmProviderApiKeySelectItems
            options={providerApiKeys.map((key) => {
              const config = PROVIDER_CONFIG[key.provider];
              return {
                value: key.id,
                icon: config.icon,
                providerName: config.name,
                keyName: key.name,
                secondaryLabel: config.name,
              };
            })}
          />
        </SelectContent>
      </Select>
    </div>
  );
}

export function ModelRouterAccessFields({
  enabled,
  onEnabledChange,
  providerApiKeyIds,
  onProviderApiKeyIdsChange,
  providerApiKeys,
  id,
  label = "Use for Model Router",
}: {
  enabled: boolean;
  onEnabledChange: (value: boolean) => void;
  providerApiKeyIds: ModelRouterProviderApiKeyMap;
  onProviderApiKeyIdsChange: (value: ModelRouterProviderApiKeyMap) => void;
  providerApiKeys: LlmProviderApiKeyResponse[];
  id: string;
  label?: string;
}) {
  const docsUrl = getDocsUrl(
    DocsPage.PlatformLlmProxyAuthentication,
    "model-router-virtual-keys",
  );

  return (
    <div className="space-y-4 rounded-md border p-4">
      <div className="flex items-start gap-3">
        <Checkbox
          id={id}
          checked={enabled}
          onCheckedChange={(checked) => onEnabledChange(checked === true)}
          className="mt-0.5"
        />
        <div className="space-y-1">
          <Label htmlFor={id} className="font-medium">
            {label}
          </Label>
          <p className="text-sm text-muted-foreground">
            Map provider API keys for OpenAI-compatible Model Router requests.{" "}
            <a
              href={docsUrl}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              View docs
            </a>
          </p>
        </div>
      </div>

      {enabled && (
        <div className="space-y-4 border-t pt-4">
          <ModelRouterProviderKeyMappingsField
            providerApiKeyIds={providerApiKeyIds}
            onProviderApiKeyIdsChange={onProviderApiKeyIdsChange}
            providerApiKeys={providerApiKeys}
          />
        </div>
      )}
    </div>
  );
}
