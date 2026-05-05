"use client";

import { DocsPage, getDocsUrl } from "@shared";
import type { LlmProviderApiKeyResponse } from "@/components/llm-provider-api-key-form";
import {
  type ProviderApiKeyMap,
  ProviderKeyMappingsField,
} from "@/components/provider-key-mappings-field";
import { Label } from "@/components/ui/label";

export function ProviderKeyAccessFields({
  providerApiKeyIds,
  onProviderApiKeyIdsChange,
  providerApiKeys,
}: {
  providerApiKeyIds: ProviderApiKeyMap;
  onProviderApiKeyIdsChange: (value: ProviderApiKeyMap) => void;
  providerApiKeys: LlmProviderApiKeyResponse[];
}) {
  const docsUrl = getDocsUrl(
    DocsPage.PlatformLlmProxyAuthentication,
    "virtual-api-keys",
  );

  return (
    <div className="space-y-4 rounded-md border p-4">
      <div className="space-y-1">
        <Label className="font-medium">Provider Keys</Label>
        <p className="text-sm text-muted-foreground">
          Map one or more Model Provider keys this credential can use.
          Provider-specific proxy routes use the matching provider key, and
          Model Router requests use the provider prefix in the requested model.{" "}
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

      <ProviderKeyMappingsField
        providerApiKeyIds={providerApiKeyIds}
        onProviderApiKeyIdsChange={onProviderApiKeyIdsChange}
        providerApiKeys={providerApiKeys}
      />
    </div>
  );
}
