"use client";

import type { SupportedProvider } from "@archestra/shared";
import { Plus, X } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useMemo, useState } from "react";
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
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import { useModelsWithApiKeys } from "@/lib/llm-models.query";
import { cn } from "@/lib/utils/tailwind";

/**
 * The provider keys a virtual key uses, as a summary that opens into one line
 * per provider. Every provider starts on with its primary key; a line changes
 * the key or stops using the provider, and providers that are off stay listed
 * underneath with a way to add them back.
 *
 * With `emptyLabel`, using no provider is a valid choice that the label
 * describes, rather than a gap to fill.
 */
export function ProviderKeyList({
  value,
  onChange,
  providerApiKeys,
  label = "Provider keys",
  showLabel = true,
  emptyLabel,
  alwaysOpen = false,
}: {
  value: ProviderApiKeyMappings;
  onChange: (value: ProviderApiKeyMappings) => void;
  providerApiKeys: LlmProviderApiKeyResponse[];
  label?: ReactNode;
  /** A surrounding disclosure can supply the visible heading. */
  showLabel?: boolean;
  emptyLabel?: string;
  /**
   * Always show the editable list, with no Change/Done toggle. For a dialog
   * whose own Done button already ends the edit.
   */
  alwaysOpen?: boolean;
}) {
  const catalog = useModelProviderCatalog();
  const modelIdsByKey = useModelIdsByKey();
  const { isPending: modelsPending } = useModelsWithApiKeys({
    toastOnError: false,
  });
  const [open, setOpen] = useState(false);
  const grouped = useMemo(
    () => keysByProvider(providerApiKeys),
    [providerApiKeys],
  );
  const byLabel = (a: SupportedProvider, b: SupportedProvider) =>
    catalog.label(a).localeCompare(catalog.label(b));
  const providers = [...grouped.keys()].sort(byLabel);

  const chosenKeys = (provider: SupportedProvider) => {
    const keys = grouped.get(provider) ?? [];
    return value
      .filter((mapping) => mapping.provider === provider)
      .flatMap(
        (mapping) =>
          keys.find((key) => key.id === mapping.providerApiKeyId) ?? [],
      );
  };
  const modelCount = (keys: LlmProviderApiKeyResponse[]) =>
    new Set(keys.flatMap((key) => modelIdsByKey.get(key.id) ?? [])).size;
  const lines = providers.map((provider) => {
    const chosen = chosenKeys(provider);
    const several = takesSeveralKeys(provider);
    const hasPrimary = (grouped.get(provider) ?? []).some(
      (key) => key.isPrimary,
    );
    return {
      provider,
      label: catalog.label(provider),
      chosen,
      on: chosen.length > 0,
      several,
      notPrimary: !several && hasPrimary && !!chosen[0] && !chosen[0].isPrimary,
      noModels: !modelsPending && chosen.length > 0 && !modelCount(chosen),
    };
  });
  const onLines = lines.filter((line) => line.on);
  const offLines = lines.filter((line) => !line.on);
  const noneOn =
    providers.length > 0 && onLines.length === 0 && emptyLabel === undefined;
  const showList = alwaysOpen || open || noneOn;
  const notPrimaryCount = onLines.filter((line) => line.notPrimary).length;
  const noModelNames = onLines
    .filter((line) => line.noModels)
    .map((line) => line.label);

  const primaryKey = (provider: SupportedProvider) =>
    grouped.get(provider)?.[0];
  const addProvider = (provider: SupportedProvider) => {
    const key = primaryKey(provider);
    if (key) onChange([...value, { provider, providerApiKeyId: key.id }]);
  };
  const enableAll = () =>
    onChange([
      ...value,
      ...offLines.flatMap((line) => {
        const key = primaryKey(line.provider);
        return key
          ? [{ provider: line.provider, providerApiKeyId: key.id }]
          : [];
      }),
    ]);
  const keyLine = (keys: LlmProviderApiKeyResponse[]) => {
    const names = keys.map((key) => key.name).join(" + ");
    if (modelsPending) return names;
    const count = modelCount(keys);
    return `${names} · ${count} ${count === 1 ? "model" : "models"}`;
  };

  if (providers.length === 0) {
    return (
      <section
        aria-label={typeof label === "string" ? label : "Provider keys"}
        className="space-y-2"
      >
        <span className={cn("font-medium text-sm", !showLabel && "sr-only")}>
          {label}
        </span>
        <NoProviderKeys />
      </section>
    );
  }

  return (
    <section
      aria-label={typeof label === "string" ? label : "Provider keys"}
      className="space-y-2"
    >
      <div className="flex min-h-8 items-center justify-between gap-2">
        <span className={cn("font-medium text-sm", !showLabel && "sr-only")}>
          {label}
        </span>
        <div className={cn("flex gap-2", !showLabel && "ml-auto")}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={offLines.length === 0}
            title={
              offLines.length === 0
                ? "All providers are enabled"
                : `Enable all ${providers.length} providers`
            }
            onClick={enableAll}
          >
            Enable all
          </Button>
          {!noneOn && !alwaysOpen && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              {open ? "Done" : "Change"}
            </Button>
          )}
        </div>
      </div>

      {(!showList || alwaysOpen) &&
        onLines.length === 0 &&
        emptyLabel !== undefined && (
          <p className="text-xs text-muted-foreground">
            <span>{emptyLabel}</span>
          </p>
        )}

      {!showList && onLines.length > 0 && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {onLines.map((line) => (
              <span
                key={line.provider}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border py-0.5 pr-2.5 pl-1.5 text-xs",
                  line.noModels
                    ? "border-amber-500/50 bg-amber-50 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200"
                    : "bg-muted",
                )}
              >
                <span aria-hidden className="shrink-0">
                  <ProviderIcon provider={line.provider} size={14} />
                </span>
                <span>
                  {line.label} ·{" "}
                  {line.chosen.map((key) => key.name).join(" + ")}
                  {line.notPrimary && (
                    <span className="text-muted-foreground">
                      {" "}
                      (not primary)
                    </span>
                  )}
                </span>
              </span>
            ))}
          </div>
          <PrimaryNote notPrimaryCount={notPrimaryCount} />
          {offLines.length > 0 && (
            <p className="text-xs text-muted-foreground">
              <span>
                Not used: {offLines.map((line) => line.label).join(", ")}. Open
                Change to add them.
              </span>
            </p>
          )}
        </div>
      )}

      {showList && (
        <div className="space-y-3 rounded-lg border bg-muted/40 p-3">
          {noneOn && (
            <div className="space-y-0.5">
              <p className="font-semibold text-sm">Choose providers to use</p>
              <p className="text-xs text-muted-foreground">
                Add at least one. Each starts with its primary key.
              </p>
            </div>
          )}
          {onLines.length > 0 && (
            <div
              className={cn(
                "space-y-1.5",
                providers.length > 8 && "max-h-[440px] overflow-y-auto pr-1",
              )}
            >
              {onLines.map((line) => (
                <ProviderLine
                  key={line.provider}
                  provider={line.provider}
                  label={line.label}
                  keys={grouped.get(line.provider) ?? []}
                  chosen={line.chosen}
                  several={line.several}
                  noModels={line.noModels}
                  summary={keyLine(line.chosen)}
                  modelIdsByKey={modelIdsByKey}
                  modelsPending={modelsPending}
                  onPick={(providerApiKeyId) =>
                    onChange(
                      pickProviderKey(value, line.provider, providerApiKeyId),
                    )
                  }
                  onRemove={() =>
                    onChange(
                      value.filter(
                        (mapping) => mapping.provider !== line.provider,
                      ),
                    )
                  }
                />
              ))}
            </div>
          )}
          {offLines.length > 0 && (
            <fieldset
              className={cn(
                "min-w-0 space-y-1.5",
                // Divide from the used providers only when any are listed above.
                onLines.length > 0 && "border-t pt-3",
              )}
              aria-label="Providers not used"
            >
              {!noneOn && (
                <p className="text-xs text-muted-foreground">
                  Not used · {offLines.length}
                </p>
              )}
              {offLines.map((line) => {
                const key = primaryKey(line.provider);
                return (
                  <div
                    key={line.provider}
                    className={cn(
                      "flex min-h-10 items-center gap-2 rounded-md border pr-1.5 pl-3",
                      noneOn
                        ? "bg-background"
                        : "border-dashed bg-background/60",
                    )}
                  >
                    <ProviderName
                      provider={line.provider}
                      label={line.label}
                      muted={!noneOn}
                    />
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                      {key ? keyLine([key]) : null}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      aria-label={`Add ${line.label}`}
                      onClick={() => addProvider(line.provider)}
                    >
                      <Plus />
                      <span>Add</span>
                    </Button>
                  </div>
                );
              })}
            </fieldset>
          )}
        </div>
      )}

      {noModelNames.length > 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          <span>{noModelNames.join(", ")}: no models on the chosen key.</span>
        </p>
      )}
    </section>
  );
}

// =========================================================================
// Parts
// =========================================================================

function ProviderLine({
  provider,
  label,
  keys,
  chosen,
  several,
  noModels,
  summary,
  modelIdsByKey,
  modelsPending,
  onPick,
  onRemove,
}: {
  provider: SupportedProvider;
  label: string;
  keys: LlmProviderApiKeyResponse[];
  chosen: LlmProviderApiKeyResponse[];
  several: boolean;
  noModels: boolean;
  summary: string;
  modelIdsByKey: Map<string, string[]>;
  modelsPending: boolean;
  onPick: (providerApiKeyId: string) => void;
  onRemove: () => void;
}) {
  const ownerLabel = useKeyOwnerLabel();
  const chosenIds = chosen.map((key) => key.id);
  const items = keys.map((key) => {
    const count = modelIdsByKey.get(key.id)?.length ?? 0;
    return {
      value: key.id,
      label: key.name,
      searchText: `${key.name} ${ownerLabel(key)}`,
      description: `${ownerLabel(key)} · ${isSubscriptionKey(key) ? "Subscription" : "Metered"}`,
      checked: several && chosenIds.includes(key.id),
      content: (
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{key.name}</span>
          {key.isPrimary && <PrimaryBadge />}
          {!modelsPending && (
            <span
              className={cn(
                "ml-auto shrink-0 text-xs tabular-nums",
                count
                  ? "text-muted-foreground"
                  : "text-amber-700 dark:text-amber-400",
              )}
            >
              {count
                ? `${count} ${count === 1 ? "model" : "models"}`
                : "no models"}
            </span>
          )}
        </span>
      ),
      selectedContent: (
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{summary}</span>
          {key.isPrimary && <PrimaryBadge />}
        </span>
      ),
    };
  });

  return (
    <div className="flex items-center gap-2">
      <ProviderName provider={provider} label={label} />
      <SearchableSelect
        className={cn(
          "min-w-0 flex-1 bg-background",
          noModels && "border-amber-500/60",
        )}
        ariaLabel={`${label} key`}
        value={several ? "" : (chosenIds[0] ?? "")}
        placeholder={summary}
        onValueChange={onPick}
        items={items}
        showSearch={keys.length > 6}
        searchPlaceholder={`Search ${keys.length} ${label} keys`}
        emptyMessage="No key matches."
        hint={
          several
            ? "Pick several. Each key is another endpoint. Requests go to the one that serves the model."
            : undefined
        }
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="text-muted-foreground"
        aria-label={`Stop using ${label}`}
        onClick={onRemove}
      >
        <X />
      </Button>
    </div>
  );
}

function ProviderName({
  provider,
  label,
  muted = false,
}: {
  provider: SupportedProvider;
  label: string;
  muted?: boolean;
}) {
  return (
    <span
      className={cn(
        "flex w-36 shrink-0 items-center gap-2 text-sm",
        muted ? "text-muted-foreground" : "text-foreground",
      )}
    >
      <span aria-hidden className="shrink-0">
        <ProviderIcon provider={provider} size={16} />
      </span>
      <span className="truncate">{label}</span>
    </span>
  );
}

function PrimaryBadge() {
  return (
    <span className="shrink-0 rounded bg-muted px-1.5 py-px font-semibold text-[10px] text-muted-foreground uppercase tracking-wide">
      Primary
    </span>
  );
}

function PrimaryNote({ notPrimaryCount }: { notPrimaryCount: number }) {
  return (
    <p className="text-xs text-muted-foreground">
      {notPrimaryCount > 0 ? (
        <span>
          Each provider uses its primary key, except {notPrimaryCount} marked
          “not primary”.
        </span>
      ) : (
        <span>Each provider uses its primary key.</span>
      )}
    </p>
  );
}

/** No provider key the caller can use yet: where to get one. */
function NoProviderKeys() {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        <span>
          No provider keys are available. Add a key or ask an admin to share
          one.
        </span>
      </p>
      <Button asChild size="sm">
        <Link href="/llm/model-providers">Add provider key</Link>
      </Button>
    </div>
  );
}
