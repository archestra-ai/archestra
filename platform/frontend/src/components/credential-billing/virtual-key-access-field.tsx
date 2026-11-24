"use client";

import type { SupportedProvider } from "@archestra/shared";
import {
  CheckIcon,
  ChevronDown,
  KeyRound,
  LayersIcon,
  Plus,
  Sparkles,
  X,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode, useId, useMemo, useState } from "react";
import { poolAnswers } from "@/components/credential-billing/model-pool-access";
import {
  PoolRow,
  PoolSummary,
} from "@/components/credential-billing/model-pools-field";
import {
  isSubscriptionKey,
  keysByProvider,
  pickProviderKey,
  takesSeveralKeys,
  useKeyOwnerLabel,
  useModelIdsByKey,
} from "@/components/credential-billing/provider-key-data";
import {
  NoProviderKeys,
  ProviderLine,
} from "@/components/credential-billing/provider-key-list";
import type { LlmProviderApiKeyResponse } from "@/components/llm-provider-api-key-form";
import { ProviderIcon } from "@/components/provider-icon";
import type { ProviderApiKeyMappings } from "@/components/provider-key-mappings-field";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  RadioGroup,
  RadioGroupItem,
  radioCardClass,
} from "@/components/ui/radio-group";
import {
  useAutoRouters,
  useAvailableAutoRouters,
} from "@/lib/auto-routing.query";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import { type ModelPool, useModelPools } from "@/lib/model-pools.query";
import {
  isOrganizationSubscription,
  organizationSubscriptionName,
} from "@/lib/organization-subscription";
import { cn } from "@/lib/utils/tailwind";

type RouterTiers = {
  fast: { modelId: string } | null;
  normal: { modelId: string } | null;
  smart: { modelId: string } | null;
};

const TIER_LABELS = { fast: "Fast", normal: "Normal", smart: "Smart" } as const;

/**
 * Everything a new virtual key can reach, in one place: whether it follows
 * the organization's shared providers, one picker for provider keys, model
 * pools and auto routers, and what is picked, grouped by kind with a line on
 * what each kind gives. Saves the same fields the separate pickers did.
 */
export function VirtualKeyAccessField({
  providerApiKeys,
  value,
  onChange,
  includeFutureProviders,
  onIncludeFutureProvidersChange,
  canIncludeFutureProviders,
  modelPoolIds,
  onModelPoolIdsChange,
  canSetModelPools,
  autoRouterIds,
  onAutoRouterIdsChange,
  canSetAutoRouters,
}: {
  providerApiKeys: LlmProviderApiKeyResponse[];
  value: ProviderApiKeyMappings;
  onChange: (value: ProviderApiKeyMappings) => void;
  includeFutureProviders: boolean;
  onIncludeFutureProvidersChange: (value: boolean) => void;
  canIncludeFutureProviders: boolean;
  modelPoolIds: string[];
  onModelPoolIdsChange: (value: string[]) => void;
  canSetModelPools: boolean;
  autoRouterIds: string[];
  onAutoRouterIdsChange: (value: string[]) => void;
  canSetAutoRouters: boolean;
}) {
  const id = useId();
  const catalog = useModelProviderCatalog();
  const ownerLabel = useKeyOwnerLabel();
  const { byKey: modelIdsByKey, pending: modelsPending } = useModelIdsByKey();
  const { data: pools = [] } = useModelPools({ enabled: canSetModelPools });
  const { data: routers = [] } = useAvailableAutoRouters({
    enabled: canSetAutoRouters,
  });
  // Tier models, for the line under each router. Reading them needs the same
  // permission as adding a router.
  const { data: routerDetails = [] } = useAutoRouters({
    enabled: canSetAutoRouters,
  });
  const tiersByRouter = useMemo(
    () =>
      new Map<string, RouterTiers>(
        routerDetails.map((router) => [router.id, router.tiers]),
      ),
    [routerDetails],
  );

  const grouped = useMemo(
    () => keysByProvider(providerApiKeys),
    [providerApiKeys],
  );
  const providers = [...grouped.keys()].sort((a, b) =>
    catalog.label(a).localeCompare(catalog.label(b)),
  );
  // What automatic access adds at request time: each provider's shared
  // primary key that still works.
  const sharedProviders = providers.filter((provider) =>
    (grouped.get(provider) ?? []).some(
      (key) =>
        key.userId === null && key.isPrimary && !key.requiresReauthentication,
    ),
  );

  const keyName = (key: LlmProviderApiKeyResponse) =>
    isOrganizationSubscription(key)
      ? organizationSubscriptionName(key, catalog.enterprisePlanName)
      : key.name;
  const modelCount = (keys: LlmProviderApiKeyResponse[]) =>
    new Set(keys.flatMap((key) => modelIdsByKey.get(key.id) ?? [])).size;
  const keyLine = (keys: LlmProviderApiKeyResponse[]) => {
    const names = keys.map(keyName).join(" + ");
    if (modelsPending) return names;
    const count = modelCount(keys);
    return `${names} · ${count} ${count === 1 ? "model" : "models"}`;
  };
  const chosenKeys = (provider: SupportedProvider) => {
    const keys = grouped.get(provider) ?? [];
    return value.flatMap((mapping) =>
      mapping.provider === provider
        ? (keys.find((key) => key.id === mapping.providerApiKeyId) ?? [])
        : [],
    );
  };

  const listedRouters = routers.filter((router) =>
    autoRouterIds.includes(router.id),
  );
  const listedPools = pools.filter((pool) => modelPoolIds.includes(pool.id));
  const listedProviders = providers.filter(
    (provider) => chosenKeys(provider).length > 0,
  );

  const summary = [
    includeFutureProviders
      ? `all shared providers${
          listedProviders.length
            ? ` + ${plural(listedProviders.length, "override", "overrides")}`
            : ""
        }`
      : plural(listedProviders.length, "provider", "providers"),
    ...(listedPools.length
      ? [plural(listedPools.length, "pool", "pools")]
      : []),
    ...(listedRouters.length
      ? [plural(listedRouters.length, "router", "routers")]
      : []),
  ].join(" · ");

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <p className="text-sm font-medium">Provider access</p>
        <RadioGroup
          value={includeFutureProviders ? "future" : "selected"}
          onValueChange={(next) =>
            onIncludeFutureProvidersChange(next === "future")
          }
          aria-label="Provider access"
          className="grid gap-2 sm:grid-cols-2"
        >
          <ModeCard
            id={`${id}-selected`}
            value="selected"
            title="Selected providers"
            description="Only the providers in the list below."
          />
          <ModeCard
            id={`${id}-future`}
            value="future"
            disabled={!canIncludeFutureProviders}
            title="Current and future providers"
            description="Every shared provider’s primary key, including providers added later."
          />
        </RadioGroup>
      </div>

      <section aria-label="Access" className="space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <Label htmlFor={`${id}-picker`}>Access</Label>
          <span className="truncate text-xs text-muted-foreground">
            {summary}
          </span>
        </div>
        <AccessPicker
          id={`${id}-picker`}
          includeFutureProviders={includeFutureProviders}
          routers={canSetAutoRouters ? routers : []}
          tiersByRouter={tiersByRouter}
          autoRouterIds={autoRouterIds}
          onAutoRouterIdsChange={onAutoRouterIdsChange}
          pools={canSetModelPools ? pools : []}
          modelPoolIds={modelPoolIds}
          onModelPoolIdsChange={onModelPoolIdsChange}
          providers={providers.map((provider) => {
            const keys = grouped.get(provider) ?? [];
            const chosen = chosenKeys(provider);
            return {
              provider,
              label: catalog.label(provider),
              keys: keys.map((key) => ({
                key,
                name: keyName(key),
                owner: ownerLabel(key),
              })),
              chosen,
              shared: sharedProviders.includes(provider),
              keyLine,
            };
          })}
          value={value}
          onChange={onChange}
        />

        <div className="divide-y">
          {listedRouters.length > 0 && (
            <KindSection
              title="Auto routers"
              hint="Apps send the router’s name as the model."
              manage={{ href: "/llm/auto-routing", label: "Manage routers" }}
            >
              {listedRouters.map((router) => (
                <div
                  key={router.id}
                  className="flex min-h-9 items-center gap-2 pl-2"
                >
                  <Sparkles className="size-3.5 shrink-0" aria-hidden />
                  <span className="shrink-0 font-mono text-sm">
                    {router.name}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {tierLine(tiersByRouter.get(router.id))}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove ${router.name}`}
                    onClick={() =>
                      onAutoRouterIdsChange(
                        autoRouterIds.filter(
                          (routerId) => routerId !== router.id,
                        ),
                      )
                    }
                  >
                    <X />
                  </Button>
                </div>
              ))}
            </KindSection>
          )}
          {listedPools.length > 0 && (
            <KindSection
              title="Model pools"
              hint="One model name that fails over across its members."
              manage={{ href: "/llm/model-pools", label: "Manage pools" }}
            >
              {listedPools.map((pool) => (
                <PoolRow
                  key={pool.id}
                  pool={pool}
                  onRemove={() =>
                    onModelPoolIdsChange(
                      modelPoolIds.filter((poolId) => poolId !== pool.id),
                    )
                  }
                />
              ))}
            </KindSection>
          )}
          <KindSection
            title="Providers"
            hint={
              includeFutureProviders
                ? "Each shared provider’s primary key. Add one above to use another key."
                : "Apps call each provider’s models by name, on the key shown."
            }
          >
            <div className="@container/provider-keys space-y-1.5">
              {providers.length === 0 && !includeFutureProviders && (
                <NoProviderKeys />
              )}
              {includeFutureProviders && (
                <div className="flex min-h-9 items-start gap-2 py-1.5 pl-2">
                  <KeyRound
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 space-y-0.5">
                    <span className="block text-sm">All shared providers</span>
                    <span className="block text-xs text-muted-foreground">
                      New providers join automatically. Personal and
                      subscription keys are left out.
                    </span>
                  </span>
                  <span className="mt-0.5 flex shrink-0 items-center gap-1 pr-2">
                    {sharedProviders.map((provider) => (
                      <ProviderIcon
                        key={provider}
                        provider={provider}
                        size={14}
                      />
                    ))}
                  </span>
                </div>
              )}
              {listedProviders.map((provider) => {
                const keys = grouped.get(provider) ?? [];
                const chosen = chosenKeys(provider);
                const label = catalog.label(provider);
                return (
                  <ProviderLine
                    key={provider}
                    provider={provider}
                    label={label}
                    keys={keys}
                    chosen={chosen}
                    several={takesSeveralKeys(provider)}
                    noModels={!modelsPending && !modelCount(chosen)}
                    summary={keyLine(chosen)}
                    modelIdsByKey={modelIdsByKey}
                    modelsPending={modelsPending}
                    onPick={(providerApiKeyId) =>
                      onChange(
                        pickProviderKey(value, provider, providerApiKeyId),
                      )
                    }
                    onRemove={() =>
                      onChange(
                        value.filter(
                          (mapping) => mapping.provider !== provider,
                        ),
                      )
                    }
                  />
                );
              })}
              {providers.length > 0 &&
                listedProviders.length === 0 &&
                !includeFutureProviders && (
                  <p className="py-2 text-xs text-muted-foreground">
                    No providers selected — add one above.
                  </p>
                )}
            </div>
          </KindSection>
        </div>
      </section>
    </div>
  );
}

// =========================================================================
// Parts
// =========================================================================

function ModeCard({
  id,
  value,
  title,
  description,
  disabled = false,
}: {
  id: string;
  value: string;
  title: string;
  description: string;
  disabled?: boolean;
}) {
  return (
    <Label
      htmlFor={id}
      className={cn(
        radioCardClass(),
        "flex cursor-pointer items-start gap-3 rounded-md p-3",
      )}
    >
      <RadioGroupItem
        id={id}
        value={value}
        disabled={disabled}
        className="mt-0.5"
      />
      <span className="space-y-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs font-normal leading-relaxed text-muted-foreground">
          {description}
        </span>
      </span>
    </Label>
  );
}

/** One kind of access: its name and what it gives on the left, items on the right. */
function KindSection({
  title,
  hint,
  manage,
  children,
}: {
  title: string;
  hint: string;
  manage?: { href: string; label: string };
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="grid gap-2 py-3 first:pt-1 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4"
    >
      <div className="space-y-1 sm:pt-2">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
        {manage && (
          <Button variant="link" size="xs" className="h-auto px-0" asChild>
            <Link href={manage.href}>{manage.label}</Link>
          </Button>
        )}
      </div>
      <div className="min-w-0 space-y-1">{children}</div>
    </section>
  );
}

type PickerProvider = {
  provider: SupportedProvider;
  label: string;
  keys: { key: LlmProviderApiKeyResponse; name: string; owner: string }[];
  chosen: LlmProviderApiKeyResponse[];
  shared: boolean;
  keyLine: (keys: LlmProviderApiKeyResponse[]) => string;
};

/**
 * One searchable list of auto routers, model pools and providers, grouped
 * like the chat's key picker. Picking toggles and the list stays open. The
 * search also matches key names and owners: picking a provider found by one
 * of its other keys switches it to that key.
 */
function AccessPicker({
  id,
  includeFutureProviders,
  routers,
  tiersByRouter,
  autoRouterIds,
  onAutoRouterIdsChange,
  pools,
  modelPoolIds,
  onModelPoolIdsChange,
  providers,
  value,
  onChange,
}: {
  id: string;
  includeFutureProviders: boolean;
  routers: { id: string; name: string }[];
  tiersByRouter: Map<string, RouterTiers>;
  autoRouterIds: string[];
  onAutoRouterIdsChange: (value: string[]) => void;
  pools: ModelPool[];
  modelPoolIds: string[];
  onModelPoolIdsChange: (value: string[]) => void;
  providers: PickerProvider[];
  value: ProviderApiKeyMappings;
  onChange: (value: ProviderApiKeyMappings) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const tokens = search.toLowerCase().split(/\s+/).filter(Boolean);
  const toggle = (list: string[], itemId: string) =>
    list.includes(itemId)
      ? list.filter((entry) => entry !== itemId)
      : [...list, itemId];

  // A key found by the words that aren't part of the provider's own name:
  // "anthropic research" finds Anthropic's research key, "openai" finds none.
  const matchedKey = (entry: PickerProvider) => {
    const own = `${entry.label} ${entry.provider}`.toLowerCase();
    const keyTokens = tokens.filter((token) => !own.includes(token));
    if (!keyTokens.length) return undefined;
    return entry.keys.find(({ name, owner }) =>
      keyTokens.every((token) =>
        `${name} ${owner}`.toLowerCase().includes(token),
      ),
    );
  };

  const pickProvider = (entry: PickerProvider) => {
    const primary = entry.keys[0]?.key;
    if (!primary) return;
    const matched = matchedKey(entry)?.key;
    const listed = entry.chosen.length > 0;
    const switchesKey =
      !!matched && !entry.chosen.some((key) => key.id === matched.id);
    if (listed && !switchesKey) {
      onChange(value.filter((mapping) => mapping.provider !== entry.provider));
    } else if (listed && takesSeveralKeys(entry.provider) && matched) {
      onChange(pickProviderKey(value, entry.provider, matched.id));
    } else {
      onChange([
        ...value.filter((mapping) => mapping.provider !== entry.provider),
        {
          provider: entry.provider,
          providerApiKeyId: (matched ?? primary).id,
        },
      ]);
    }
  };

  const providerDescription = (entry: PickerProvider) => {
    const matched = matchedKey(entry);
    if (matched && matched.key.id !== entry.keys[0]?.key.id) {
      return `Key ${matched.name} · ${matched.owner}`;
    }
    if (includeFutureProviders) {
      if (entry.chosen.length)
        return `Uses ${entry.keyLine(entry.chosen)} instead of its primary key`;
      return entry.shared
        ? "Included with its primary key · pick to use another key"
        : "Not a shared key · pick to add it";
    }
    const keys = entry.chosen.length
      ? entry.chosen
      : entry.keys[0]
        ? [entry.keys[0].key]
        : [];
    const others = entry.keys.length > 1 ? ` · ${entry.keys.length} keys` : "";
    return `${entry.keyLine(keys)}${others}`;
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label="Add a provider, model pool or auto router"
          className="w-full justify-start font-normal"
        >
          <Plus className="text-muted-foreground" />
          <span className="flex-1 text-left text-muted-foreground">
            Add a provider, model pool or auto router
          </span>
          <ChevronDown className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] p-0"
        align="start"
      >
        <Command filter={matchesEveryWord}>
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder="Search providers, keys, pools and routers…"
          />
          <CommandList className="max-h-[320px]">
            <CommandEmpty>No matches.</CommandEmpty>
            {routers.length > 0 && (
              <CommandGroup
                heading={
                  <GroupHeading
                    title="Auto routers"
                    hint="Picks a fast, normal or smart model per session"
                  />
                }
              >
                {routers.map((router) => {
                  const on = autoRouterIds.includes(router.id);
                  return (
                    <CommandItem
                      key={router.id}
                      value={`router:${router.id}`}
                      keywords={[router.name, "auto router", "auto routing"]}
                      onSelect={() =>
                        onAutoRouterIdsChange(toggle(autoRouterIds, router.id))
                      }
                    >
                      <Sparkles className="size-3.5 shrink-0" aria-hidden />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-mono text-sm">
                          {router.name}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {tierLine(tiersByRouter.get(router.id))}
                        </span>
                      </span>
                      <CheckIcon
                        className={cn("size-4 shrink-0", !on && "opacity-0")}
                      />
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
            {pools.length > 0 && (
              <CommandGroup
                heading={
                  <GroupHeading
                    title="Model pools"
                    hint="One model name that fails over across every member"
                  />
                }
              >
                {pools.map((pool) => {
                  const on = modelPoolIds.includes(pool.id);
                  return (
                    <CommandItem
                      key={pool.id}
                      value={`pool:${pool.id}`}
                      keywords={[
                        pool.name,
                        "model pool",
                        ...pool.members.flatMap((member) => [
                          member.provider,
                          member.modelId,
                        ]),
                      ]}
                      disabled={!on && !poolAnswers(pool)}
                      onSelect={() =>
                        onModelPoolIdsChange(toggle(modelPoolIds, pool.id))
                      }
                    >
                      <LayersIcon className="size-3.5 shrink-0" aria-hidden />
                      <PoolSummary pool={pool} />
                      <CheckIcon
                        className={cn("size-4 shrink-0", !on && "opacity-0")}
                      />
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
            {providers.length > 0 && (
              <CommandGroup
                heading={
                  <GroupHeading
                    title="Providers"
                    hint={
                      includeFutureProviders
                        ? "Shared providers are already included. Pick one to use a different key."
                        : "Apps call the provider’s models by name, on the key you choose"
                    }
                  />
                }
              >
                {providers.map((entry) => {
                  const on =
                    entry.chosen.length > 0 ||
                    (includeFutureProviders && entry.shared);
                  return (
                    <CommandItem
                      key={entry.provider}
                      value={`provider:${entry.provider}`}
                      keywords={[
                        entry.label,
                        entry.provider,
                        "provider key",
                        ...entry.keys.flatMap(({ name, owner, key }) => [
                          name,
                          owner,
                          isSubscriptionKey(key) ? "subscription" : "metered",
                        ]),
                      ]}
                      onSelect={() => pickProvider(entry)}
                    >
                      <span aria-hidden className="shrink-0">
                        <ProviderIcon provider={entry.provider} size={16} />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate">{entry.label}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          {providerDescription(entry)}
                        </span>
                      </span>
                      <CheckIcon
                        className={cn("size-4 shrink-0", !on && "opacity-0")}
                      />
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function GroupHeading({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="space-y-0.5">
      <div className="text-foreground">{title}</div>
      <div className="font-normal">{hint}</div>
    </div>
  );
}

function tierLine(tiers: RouterTiers | undefined): string {
  if (!tiers) return "Picks a fast, normal or smart model per session";
  return (Object.keys(TIER_LABELS) as (keyof typeof TIER_LABELS)[])
    .flatMap((tier) => {
      const model = tiers[tier]?.modelId;
      return model ? [`${TIER_LABELS[tier]} ${model}`] : [];
    })
    .join(" · ");
}

/** Every typed word appears in the item's value or keywords, in any order. */
function matchesEveryWord(
  value: string,
  search: string,
  keywords?: string[],
): number {
  const haystack = [value, ...(keywords ?? [])].join(" ").toLowerCase();
  return search
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word))
    ? 1
    : 0;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
