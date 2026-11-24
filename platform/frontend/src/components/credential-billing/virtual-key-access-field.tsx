"use client";

import type { SupportedProvider } from "@archestra/shared";
import {
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
  takesSeveralKeys,
  useKeyOwnerLabel,
  useModelIdsByKey,
} from "@/components/credential-billing/provider-key-data";
import {
  NoProviderKeys,
  PrimaryBadge,
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
  ORGANIZATION_SUBSCRIPTIONS_HEADING,
  organizationSubscriptionName,
  organizationSubscriptionSubtitle,
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
    (grouped.get(provider) ?? []).some(isSharedPrimary),
  );

  const keyName = (key: LlmProviderApiKeyResponse) =>
    isOrganizationSubscription(key)
      ? organizationSubscriptionName(key, catalog.enterprisePlanName)
      : key.name;
  const keyOption = (key: LlmProviderApiKeyResponse): KeyOption => ({
    key,
    name: keyName(key),
    owner: ownerLabel(key),
    detail: isOrganizationSubscription(key)
      ? `${ORGANIZATION_SUBSCRIPTIONS_HEADING} · ${organizationSubscriptionSubtitle(key)}`
      : `${ownerLabel(key)} · ${isSubscriptionKey(key) ? "Subscription" : "Metered"}`,
    models: modelsPending ? null : (modelIdsByKey.get(key.id)?.length ?? 0),
  });
  const chosenKeys = (provider: SupportedProvider) => {
    const keys = grouped.get(provider) ?? [];
    return value.flatMap((mapping) =>
      mapping.provider === provider
        ? (keys.find((key) => key.id === mapping.providerApiKeyId) ?? [])
        : [],
    );
  };
  const chosenIds = new Set(value.map((mapping) => mapping.providerApiKeyId));

  // Every key the picker can still add, grouped by provider. Keys already in
  // the list are left out, and so is a shared primary key that automatic
  // access already uses. A provider takes one key unless it is endpoint-local,
  // so adding another key there replaces the one in use.
  const pickerProviders: PickerProvider[] = providers.flatMap((provider) => {
    const keys = grouped.get(provider) ?? [];
    const chosen = chosenKeys(provider);
    const automatic =
      includeFutureProviders && chosen.length === 0
        ? keys.find(isSharedPrimary)
        : undefined;
    const inUse = chosen[0] ?? automatic;
    const replaces =
      !takesSeveralKeys(provider) && inUse ? keyName(inUse) : undefined;
    const options = keys
      .filter((key) => !chosenIds.has(key.id) && key.id !== automatic?.id)
      .map((key) => ({ ...keyOption(key), replaces }));
    return options.length
      ? [{ provider, label: catalog.label(provider), keys: options }]
      : [];
  });
  const addKey = (provider: SupportedProvider, providerApiKeyId: string) =>
    onChange([
      ...(takesSeveralKeys(provider)
        ? value
        : value.filter((mapping) => mapping.provider !== provider)),
      { provider, providerApiKeyId },
    ]);

  const listedRouters = routers.filter((router) =>
    autoRouterIds.includes(router.id),
  );
  const listedPools = pools.filter((pool) => modelPoolIds.includes(pool.id));
  const listedProviders = providers.filter(
    (provider) => chosenKeys(provider).length > 0,
  );
  const listedKeys = listedProviders.flatMap((provider) =>
    chosenKeys(provider).map((key) => ({
      provider,
      label: catalog.label(provider),
      several: takesSeveralKeys(provider),
      option: keyOption(key),
    })),
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
          routers={canSetAutoRouters ? routers : []}
          tiersByRouter={tiersByRouter}
          autoRouterIds={autoRouterIds}
          onAutoRouterIdsChange={onAutoRouterIdsChange}
          pools={canSetModelPools ? pools : []}
          modelPoolIds={modelPoolIds}
          onModelPoolIdsChange={onModelPoolIdsChange}
          providers={pickerProviders}
          onAddKey={addKey}
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
              {listedKeys.map(({ provider, label, several, option }) => (
                <ListedKeyRow
                  key={option.key.id}
                  provider={provider}
                  label={label}
                  option={option}
                  removeLabel={
                    several ? `Remove ${option.name}` : `Stop using ${label}`
                  }
                  onRemove={() =>
                    onChange(
                      value.filter(
                        (mapping) => mapping.providerApiKeyId !== option.key.id,
                      ),
                    )
                  }
                />
              ))}
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

type KeyOption = {
  key: LlmProviderApiKeyResponse;
  name: string;
  owner: string;
  /** Owner and billing, e.g. "Organization · Metered". */
  detail: string;
  /** Discovered models; null while they load. */
  models: number | null;
};

type PickerProvider = {
  provider: SupportedProvider;
  label: string;
  /** Keys not in the list yet. `replaces` names the key a pick swaps out. */
  keys: (KeyOption & { replaces?: string })[];
};

/** A chosen key: its provider on the left, the key and its owner on the right. */
function ListedKeyRow({
  provider,
  label,
  option,
  removeLabel,
  onRemove,
}: {
  provider: SupportedProvider;
  label: string;
  option: KeyOption;
  removeLabel: string;
  onRemove: () => void;
}) {
  return (
    <div className="flex min-h-9 items-center gap-2 pl-2">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 @[480px]/provider-keys:flex-row @[480px]/provider-keys:items-center @[480px]/provider-keys:gap-2">
        <span className="flex min-w-0 items-center gap-2 text-sm @[480px]/provider-keys:w-36 @[480px]/provider-keys:shrink-0">
          <span aria-hidden className="shrink-0">
            <ProviderIcon provider={provider} size={16} />
          </span>
          <span className="truncate">{label}</span>
        </span>
        <span className="min-w-0 flex-1">
          <KeyTitle option={option} />
          <span className="block truncate text-xs text-muted-foreground">
            {option.detail}
          </span>
        </span>
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="shrink-0 text-muted-foreground"
        aria-label={removeLabel}
        onClick={onRemove}
      >
        <X />
      </Button>
    </div>
  );
}

/** The key's name, a Primary badge, and how many models it serves. */
function KeyTitle({ option }: { option: KeyOption }) {
  return (
    <span className="flex min-w-0 items-center gap-2 text-sm">
      <span className="truncate">{option.name}</span>
      {option.key.isPrimary && <PrimaryBadge />}
      {option.models !== null && (
        <span
          className={cn(
            "shrink-0 text-xs tabular-nums",
            option.models
              ? "text-muted-foreground"
              : "text-amber-700 dark:text-amber-400",
          )}
        >
          {option.models
            ? plural(option.models, "model", "models")
            : "no models"}
        </span>
      )}
    </span>
  );
}

/**
 * One searchable list for adding access: auto routers, model pools, then each
 * provider's keys under the provider's name, so searching "anthropic" lists
 * every Anthropic key. Picking only adds, and anything already in the list is
 * left out. The list stays open for the next pick.
 */
function AccessPicker({
  id,
  routers,
  tiersByRouter,
  autoRouterIds,
  onAutoRouterIdsChange,
  pools,
  modelPoolIds,
  onModelPoolIdsChange,
  providers,
  onAddKey,
}: {
  id: string;
  routers: { id: string; name: string }[];
  tiersByRouter: Map<string, RouterTiers>;
  autoRouterIds: string[];
  onAutoRouterIdsChange: (value: string[]) => void;
  pools: ModelPool[];
  modelPoolIds: string[];
  onModelPoolIdsChange: (value: string[]) => void;
  providers: PickerProvider[];
  onAddKey: (provider: SupportedProvider, providerApiKeyId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const addableRouters = routers.filter(
    (router) => !autoRouterIds.includes(router.id),
  );
  const addablePools = pools.filter((pool) => !modelPoolIds.includes(pool.id));
  const nothingLeft =
    addableRouters.length === 0 &&
    addablePools.length === 0 &&
    providers.length === 0;

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
            <CommandEmpty>
              {nothingLeft
                ? "Everything is already added."
                : "No matches. Anything already added is hidden."}
            </CommandEmpty>
            {addableRouters.length > 0 && (
              <CommandGroup
                heading={
                  <GroupHeading
                    title="Auto routers"
                    hint="Picks a fast, normal or smart model per session"
                  />
                }
              >
                {addableRouters.map((router) => (
                  <CommandItem
                    key={router.id}
                    value={`router:${router.id}`}
                    keywords={[router.name, "auto router", "auto routing"]}
                    onSelect={() =>
                      onAutoRouterIdsChange([...autoRouterIds, router.id])
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
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {addablePools.length > 0 && (
              <CommandGroup
                heading={
                  <GroupHeading
                    title="Model pools"
                    hint="One model name that fails over across every member"
                  />
                }
              >
                {addablePools.map((pool) => (
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
                    disabled={!poolAnswers(pool)}
                    onSelect={() =>
                      onModelPoolIdsChange([...modelPoolIds, pool.id])
                    }
                  >
                    <LayersIcon className="size-3.5 shrink-0" aria-hidden />
                    <PoolSummary pool={pool} />
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {providers.map((entry) => (
              <CommandGroup
                key={entry.provider}
                heading={
                  <span className="flex items-center gap-2 text-foreground">
                    <span aria-hidden className="shrink-0">
                      <ProviderIcon provider={entry.provider} size={14} />
                    </span>
                    <span>{entry.label}</span>
                  </span>
                }
              >
                {entry.keys.map((option) => (
                  <CommandItem
                    key={option.key.id}
                    value={`key:${option.key.id}`}
                    keywords={[
                      entry.label,
                      entry.provider,
                      option.name,
                      option.owner,
                      isSubscriptionKey(option.key)
                        ? "subscription"
                        : "metered",
                    ]}
                    onSelect={() => onAddKey(entry.provider, option.key.id)}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <KeyTitle option={option} />
                      <span className="truncate text-xs text-muted-foreground">
                        {option.replaces
                          ? `${option.detail} · replaces ${option.replaces}`
                          : option.detail}
                      </span>
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
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

/** What automatic access adds at request time: a shared primary key that still works. */
function isSharedPrimary(key: LlmProviderApiKeyResponse): boolean {
  return key.userId === null && key.isPrimary && !key.requiresReauthentication;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
