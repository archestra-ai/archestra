"use client";

import type { SupportedProvider } from "@archestra/shared";
import { useMemo } from "react";
import {
  isSubscriptionKey,
  keysByProvider,
  pickProviderKey,
  takesSeveralKeys,
  useKeyOwnerLabel,
  useModelIdsByKey,
} from "@/components/credential-billing/provider-key-data";
import type { LlmProviderApiKeyResponse } from "@/components/llm-provider-api-key-form";
import { ProviderIcon } from "@/components/provider-icon";
import type { ProviderApiKeyMappings } from "@/components/provider-key-mappings-field";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  RadioGroup,
  RadioGroupItem,
  radioCardClass,
} from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import { cn } from "@/lib/utils/tailwind";

/**
 * The provider keys of an existing credential, one box per provider with its
 * keys as radio cards. Used on edit, where the credential already has keys and
 * the full two-pane picker of the create flow would be a dialog in a dialog.
 */
export function ProviderKeyBoxes({
  value,
  onChange,
  providerApiKeys,
}: {
  value: ProviderApiKeyMappings;
  onChange: (value: ProviderApiKeyMappings) => void;
  providerApiKeys: LlmProviderApiKeyResponse[];
}) {
  const catalog = useModelProviderCatalog();
  const ownerLabel = useKeyOwnerLabel();
  const modelIdsByKey = useModelIdsByKey();
  const grouped = useMemo(
    () => keysByProvider(providerApiKeys),
    [providerApiKeys],
  );
  const unmapped = [...grouped.keys()]
    .filter((provider) => !value.some((m) => m.provider === provider))
    .sort((a, b) => catalog.label(a).localeCompare(catalog.label(b)));

  const providers = [...new Set(value.map((mapping) => mapping.provider))];
  const choose = (provider: SupportedProvider, providerApiKeyId: string) =>
    onChange(pickProviderKey(value, provider, providerApiKeyId));

  return (
    <div className="space-y-3">
      {providers.map((provider) => {
        const keys = grouped.get(provider) ?? [];
        const label = catalog.label(provider);
        const chosenIds = value
          .filter((mapping) => mapping.provider === provider)
          .map((mapping) => mapping.providerApiKeyId);
        const several = takesSeveralKeys(provider);
        return (
          <section
            key={provider}
            aria-label={label}
            className="rounded-lg border"
          >
            <div className="flex items-center gap-2 border-b px-3 py-2">
              <ProviderIcon provider={provider} size={18} />
              <span className="flex-1 font-medium text-sm">{label}</span>
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto px-0 text-destructive"
                onClick={() =>
                  onChange(value.filter((m) => m.provider !== provider))
                }
              >
                Remove
              </Button>
            </div>
            <RadioGroup
              value={several ? "" : (chosenIds[0] ?? "")}
              onValueChange={(id) => choose(provider, id)}
              aria-label={`${label} key`}
              className="gap-2 p-3"
            >
              {keys.map((key) => {
                const id = `provider-key-box-${key.id}`;
                const models = modelIdsByKey.get(key.id)?.length ?? 0;
                return (
                  <Label
                    key={key.id}
                    htmlFor={id}
                    className={cn(
                      "grid cursor-pointer grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-3 rounded-md px-3 py-2 font-normal",
                      radioCardClass(),
                    )}
                  >
                    {several ? (
                      <Checkbox
                        id={id}
                        checked={chosenIds.includes(key.id)}
                        onCheckedChange={() => choose(provider, key.id)}
                      />
                    ) : (
                      <RadioGroupItem id={id} value={key.id} />
                    )}
                    <span className="min-w-0">
                      <span className="block truncate font-medium">
                        {key.name}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {ownerLabel(key)} ·{" "}
                        {isSubscriptionKey(key) ? "Subscription" : "Metered"}
                      </span>
                    </span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {models} {models === 1 ? "model" : "models"}
                    </span>
                  </Label>
                );
              })}
              {keys.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  <span>
                    Uses a key you cannot see. Keep it, or remove the provider.
                  </span>
                </p>
              )}
            </RadioGroup>
          </section>
        );
      })}

      {value.length === 0 && (
        <p className="text-sm text-muted-foreground">
          <span>No provider yet. Add one below.</span>
        </p>
      )}

      {unmapped.length > 0 && (
        <Select
          value=""
          onValueChange={(provider) => {
            const first = grouped.get(provider as SupportedProvider)?.[0];
            if (first) {
              onChange([
                ...value,
                {
                  provider: provider as SupportedProvider,
                  providerApiKeyId: first.id,
                },
              ]);
            }
          }}
        >
          <SelectTrigger
            aria-label="Add a provider"
            className="w-56 border-dashed"
          >
            <SelectValue placeholder="+ Add a provider" />
          </SelectTrigger>
          <SelectContent>
            {unmapped.map((provider) => (
              <SelectItem key={provider} value={provider}>
                {catalog.label(provider)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
