"use client";

import { E2eTestId, type SupportedProvider } from "@archestra/shared";
import { Check, X } from "lucide-react";
import { useMemo, useState } from "react";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import { cn } from "@/lib/utils/tailwind";

/**
 * Pick one provider key per provider: providers on the left (in use, other
 * providers the caller has keys for, and providers with no usable key), the
 * focused provider's keys on the right with their owner, billing and models.
 */
export function ProviderKeyPicker({
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

  const inUse = [...new Set(value.map((mapping) => mapping.provider))];
  const available = [...grouped.keys()]
    .filter((provider) => !inUse.includes(provider))
    .sort((a, b) => catalog.label(a).localeCompare(catalog.label(b)));
  const unavailable = catalog.visibleIds
    .filter((provider) => !grouped.has(provider))
    .sort((a, b) => catalog.label(a).localeCompare(catalog.label(b)));

  const [focused, setFocused] = useState<SupportedProvider | null>(
    inUse[0] ?? available[0] ?? null,
  );
  const focusedProvider =
    focused && grouped.has(focused) ? focused : (inUse[0] ?? available[0]);
  const focusedKeys = focusedProvider
    ? (grouped.get(focusedProvider) ?? [])
    : [];
  const chosenKeyIds = value
    .filter((mapping) => mapping.provider === focusedProvider)
    .map((mapping) => mapping.providerApiKeyId);
  const chosenKeys = focusedKeys.filter((key) => chosenKeyIds.includes(key.id));
  const several = !!focusedProvider && takesSeveralKeys(focusedProvider);
  const keyName = (id: string) =>
    providerApiKeys.find((key) => key.id === id)?.name ?? "Unknown key";

  const choose = (provider: SupportedProvider, providerApiKeyId: string) =>
    onChange(pickProviderKey(value, provider, providerApiKeyId));
  const stopUsing = (provider: SupportedProvider) =>
    onChange(value.filter((mapping) => mapping.provider !== provider));

  const totalModels = new Set(
    value.flatMap(
      (mapping) => modelIdsByKey.get(mapping.providerApiKeyId) ?? [],
    ),
  ).size;

  return (
    <div className="space-y-3">
      <div className="grid h-[340px] grid-cols-[176px_minmax(0,1fr)] overflow-hidden rounded-lg border">
        <div className="flex flex-col gap-0.5 overflow-y-auto border-r bg-muted/40 p-2">
          {inUse.length > 0 && (
            <GroupHeading>In use · {inUse.length}</GroupHeading>
          )}
          {inUse.map((provider) => {
            const keys = grouped.get(provider) ?? [];
            const names = value
              .filter((m) => m.provider === provider)
              .map((m) => keyName(m.providerApiKeyId));
            return (
              <ProviderRow
                key={provider}
                provider={provider}
                label={catalog.label(provider)}
                detail={keys.length === 1 ? "only key" : names.join(", ")}
                selected
                focused={focusedProvider === provider}
                onClick={() => setFocused(provider)}
              />
            );
          })}
          {available.length > 0 && (
            <GroupHeading className={cn(inUse.length > 0 && "mt-2")}>
              Available · {available.length}
            </GroupHeading>
          )}
          {available.map((provider) => {
            const count = grouped.get(provider)?.length ?? 0;
            return (
              <ProviderRow
                key={provider}
                provider={provider}
                label={catalog.label(provider)}
                detail={`${count} ${count === 1 ? "key" : "keys"}`}
                testId={E2eTestId.ProviderKeyPickerAvailableProvider}
                focused={focusedProvider === provider}
                onClick={() => setFocused(provider)}
              />
            );
          })}
          {unavailable.length > 0 && (
            <GroupHeading className="mt-2">
              No key you can use · {unavailable.length}
            </GroupHeading>
          )}
          {unavailable.map((provider) => (
            <ProviderRow
              key={provider}
              provider={provider}
              label={catalog.label(provider)}
              detail="Ask an admin to share one"
              disabled
            />
          ))}
        </div>

        <div className="flex min-w-0 flex-col overflow-y-auto">
          {focusedProvider ? (
            <>
              <div className="flex items-center justify-between gap-2 px-3 py-2">
                <span className="font-semibold text-sm">
                  {catalog.label(focusedProvider)} key
                </span>
                {chosenKeyIds.length > 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    aria-label={`Remove ${catalog.label(focusedProvider)} provider`}
                    onClick={() => stopUsing(focusedProvider)}
                  >
                    <X />
                    <span>Remove</span>
                  </Button>
                )}
              </div>
              <RadioGroup
                value={several ? "" : (chosenKeyIds[0] ?? "")}
                onValueChange={(id) => choose(focusedProvider, id)}
                aria-label={`${catalog.label(focusedProvider)} key`}
                className="gap-0"
              >
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-y bg-muted/40 text-left text-xs text-muted-foreground">
                      <th className="w-8 px-3 py-2">
                        <span className="sr-only">Pick</span>
                      </th>
                      <th className="px-2 py-2 font-medium">Key</th>
                      <th className="px-2 py-2 font-medium">Billing</th>
                      <th className="px-3 py-2 text-right font-medium">
                        Models
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {focusedKeys.map((key) => (
                      <tr
                        key={key.id}
                        className={cn(
                          "cursor-pointer border-b last:border-b-0",
                          chosenKeyIds.includes(key.id) && "bg-muted/60",
                        )}
                        onClick={() => choose(focusedProvider, key.id)}
                      >
                        <td className="px-3 py-1.5">
                          {several ? (
                            <Checkbox
                              aria-label={key.name}
                              checked={chosenKeyIds.includes(key.id)}
                              onClick={(event) => event.stopPropagation()}
                              onCheckedChange={() =>
                                choose(focusedProvider, key.id)
                              }
                            />
                          ) : (
                            <RadioGroupItem
                              onClick={(event) => event.stopPropagation()}
                              value={key.id}
                              aria-label={key.name}
                            />
                          )}
                        </td>
                        <td className="min-w-0 px-2 py-1.5">
                          <div className="truncate font-medium">{key.name}</div>
                          <div className="truncate text-xs text-muted-foreground">
                            {ownerLabel(key)}
                          </div>
                        </td>
                        <td className="px-2 py-1.5">
                          {isSubscriptionKey(key) ? "Subscription" : "Metered"}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">
                          {modelIdsByKey.get(key.id)?.length ?? 0}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </RadioGroup>
              {several && (
                <p className="px-3 pt-2 text-xs text-muted-foreground">
                  <span>
                    Each key is another endpoint. Requests go to the one that
                    serves the model.
                  </span>
                </p>
              )}
              {chosenKeys.map((chosenKey) => (
                <div
                  key={chosenKey.id}
                  className="space-y-2 p-3 text-xs text-muted-foreground"
                >
                  <ModelChips
                    keyName={chosenKey.name}
                    modelIds={modelIdsByKey.get(chosenKey.id) ?? []}
                  />
                  {isSubscriptionKey(chosenKey) && (
                    <p>
                      <span>
                        Subscription usage costs $0 in Costs. It does not count
                        toward spend caps or team limits.
                      </span>
                    </p>
                  )}
                </div>
              ))}
              {chosenKeys.length === 0 && (
                <p className="p-3 text-xs text-muted-foreground">
                  <span>
                    Pick a key to use {catalog.label(focusedProvider)}.
                  </span>
                </p>
              )}
            </>
          ) : (
            <p className="p-4 text-sm text-muted-foreground">
              <span>
                You cannot use any provider key yet. Ask an admin to share one.
              </span>
            </p>
          )}
        </div>
      </div>

      {value.length > 0 && (
        <section
          className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2"
          aria-label="Selected provider keys"
        >
          <span className="mr-1 text-xs text-muted-foreground">
            {value.length} selected · {totalModels} models
          </span>
          {value.map((mapping) => (
            <span
              key={mapping.providerApiKeyId}
              className="inline-flex items-center gap-1.5 rounded-full border bg-background py-0.5 pl-2.5 pr-1 text-xs"
            >
              <span>
                {catalog.label(mapping.provider)} ·{" "}
                {keyName(mapping.providerApiKeyId)}
              </span>
              <UnstyledButton
                aria-label={`Remove ${catalog.label(mapping.provider)} · ${keyName(mapping.providerApiKeyId)}`}
                className="rounded-full p-0.5 text-muted-foreground hover:text-foreground"
                onClick={() =>
                  onChange(
                    value.filter(
                      (m) => m.providerApiKeyId !== mapping.providerApiKeyId,
                    ),
                  )
                }
              >
                <X className="size-3.5" />
              </UnstyledButton>
            </span>
          ))}
        </section>
      )}
    </div>
  );
}

/** "11 models with Platform Eng key" and the first few model ids. */
export function ModelChips({
  keyName,
  modelIds,
}: {
  keyName: string;
  modelIds: string[];
}) {
  const shown = modelIds.slice(0, 3);
  const more = modelIds.length - shown.length;
  return (
    <div>
      <div>
        {modelIds.length} {modelIds.length === 1 ? "model" : "models"} with{" "}
        {keyName}
      </div>
      {modelIds.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {shown.map((modelId) => (
            <span
              key={modelId}
              className="rounded-full border bg-muted/50 px-2 py-0.5 text-foreground/80"
            >
              {modelId}
            </span>
          ))}
          {more > 0 && (
            <span className="rounded-full border bg-muted/50 px-2 py-0.5">
              + {more} more
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function GroupHeading({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "px-2.5 pb-1 pt-2 font-semibold text-[11px] text-muted-foreground uppercase tracking-wide",
        className,
      )}
    >
      {children}
    </div>
  );
}

function ProviderRow({
  provider,
  label,
  detail,
  selected = false,
  focused = false,
  disabled = false,
  testId,
  onClick,
}: {
  provider: SupportedProvider;
  label: string;
  detail: string;
  selected?: boolean;
  focused?: boolean;
  disabled?: boolean;
  testId?: string;
  onClick?: () => void;
}) {
  return (
    <UnstyledButton
      disabled={disabled}
      aria-current={focused ? "true" : undefined}
      data-testid={testId}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left",
        focused && "bg-background shadow-[0_0_0_1px] shadow-border",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <span aria-hidden className="shrink-0">
        <ProviderIcon provider={provider} size={16} />
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate text-sm",
            selected ? "font-medium" : "text-foreground/80",
          )}
        >
          {label}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {detail}
        </span>
      </span>
      {selected && (
        <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <Check className="size-3" />
        </span>
      )}
    </UnstyledButton>
  );
}
