"use client";

import { DocsPage, getDocsUrl } from "@archestra/shared";
import type { LlmProviderApiKeyResponse } from "@/components/llm-provider-api-key-form";
import {
  type ProviderApiKeyMap,
  ProviderKeyMappingsField,
} from "@/components/provider-key-mappings-field";
import { Separator } from "@/components/ui/separator";

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
    <div className="space-y-4">
      <Separator />
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Provider Keys</h3>
        <p className="text-sm text-muted-foreground">
          Choose one API key per provider. Requests use: provider → API key.
          With Model Router: model → provider → API key.{" "}
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
