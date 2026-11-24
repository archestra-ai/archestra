"use client";

import type { SupportedProvider } from "@archestra/shared";
import {
  ChevronDown,
  ChevronRight,
  KeyRound,
  LayersIcon,
  Plus,
  Shuffle,
  X,
} from "lucide-react";
import {
  Fragment,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  poolAnswers,
  poolServes,
} from "@/components/credential-billing/model-pool-access";
import { PoolSummary } from "@/components/credential-billing/model-pools-field";
import {
  isSubscriptionKey,
  keysByProvider,
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
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
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UnstyledButton } from "@/components/ui/unstyled-button";
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

type Kind = "providers" | "pools" | "routers";

/**
 * Everything a new virtual key can reach: whether it follows the
 * organization's shared providers, one picker that adds a provider, a model
 * pool or an auto router, and what's added, on a tab per kind. A provider row
 * picks its key in place; pools and routers open to show what's behind them.
 * Saves the same fields the separate pickers did.
 */
export function VirtualKeyAccessField(props: AccessProps) {
  const model = useAccess(props);
  const [tab, setTab] = useState<Kind>("providers");

  const counts = {
    providers: model.providerRows.length,
    pools: model.listedPools.length,
    routers: model.listedRouters.length,
  };
  // A tab shows when it has something listed or something left to add.
  const showPools =
    counts.pools > 0 ||
    (props.canSetModelPools && model.addablePools.length > 0);
  const showRouters =
    counts.routers > 0 ||
    (props.canSetAutoRouters && model.addableRouters.length > 0);

  // After an add, switch to that kind's tab so the user sees it land.
  const previous = useRef(counts);
  useEffect(() => {
    const before = previous.current;
    previous.current = {
      providers: counts.providers,
      pools: counts.pools,
      routers: counts.routers,
    };
    if (counts.routers > before.routers) setTab("routers");
    else if (counts.pools > before.pools) setTab("pools");
    else if (counts.providers > before.providers) setTab("providers");
  }, [counts.providers, counts.pools, counts.routers]);

  // A tab that disappears falls back to providers.
  const active: Kind =
    (tab === "pools" && !showPools) || (tab === "routers" && !showRouters)
      ? "providers"
      : tab;

  return (
    <div className="space-y-4">
      <ProviderAccessModes model={model} />
      <section aria-label="Access" className="space-y-2">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-sm font-medium">Access</p>
          <span className="truncate text-xs text-muted-foreground">
            {model.summary}
          </span>
        </div>
        <ScopedPicker model={model} />
        <Tabs
          value={active}
          onValueChange={(next) => setTab(next as Kind)}
          className="gap-0 overflow-hidden rounded-md border"
        >
          <div className="border-b bg-muted/30 px-2 py-1.5">
            <TabsList size="sm" className="bg-transparent">
              <TabsTrigger value="providers">
                <span>Providers</span>
                <TabCount
                  value={
                    model.includeFutureProviders
                      ? counts.providers
                        ? `All +${counts.providers}`
                        : "All"
                      : String(counts.providers)
                  }
                />
              </TabsTrigger>
              {showPools && (
                <TabsTrigger value="pools">
                  <LayersIcon aria-hidden />
                  <span>Model pools</span>
                  <TabCount value={String(counts.pools)} />
                </TabsTrigger>
              )}
              {showRouters && (
                <TabsTrigger value="routers">
                  <Shuffle aria-hidden />
                  <span>Auto routers</span>
                  <TabCount value={String(counts.routers)} />
                </TabsTrigger>
              )}
            </TabsList>
          </div>
          <TabsContent value="providers">
            <ProvidersTab model={model} />
          </TabsContent>
          {showPools && (
            <TabsContent value="pools">
              <PoolsTab model={model} />
            </TabsContent>
          )}
          {showRouters && (
            <TabsContent value="routers">
              <RoutersTab model={model} />
            </TabsContent>
          )}
        </Tabs>
      </section>
    </div>
  );
}

function TabCount({ value }: { value: string }) {
  return (
    <span className="text-xs font-normal tabular-nums text-muted-foreground">
      {value}
    </span>
  );
}

function Empty({ children }: { children: string }) {
  return <p className="px-3 py-3 text-sm text-muted-foreground">{children}</p>;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

function ProvidersTab({ model }: { model: AccessModel }) {
  if (model.noProviderKeys && !model.includeFutureProviders)
    return (
      <div className="p-3">
        <NoProviderKeys />
      </div>
    );
  return (
    <div>
      <div className="divide-y">
        {model.includeFutureProviders && (
          <div className="px-3 py-2.5">
            <AllSharedProviders model={model} />
          </div>
        )}
        {model.providerRows.map((row) => (
          <ProviderLine key={row.provider} row={row} model={model} />
        ))}
      </div>
      {!model.includeFutureProviders && model.providerRows.length === 0 && (
        <Empty>No providers yet — add one above.</Empty>
      )}
    </div>
  );
}

function ProviderLine({
  row,
  model,
}: {
  row: ProviderRow;
  model: AccessModel;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)_auto] items-start gap-3 px-3 py-2">
      <span className="flex min-h-9 min-w-0 items-center gap-2">
        <ProviderIcon provider={row.provider} size={16} />
        <span className="min-w-0">
          <span className="block truncate text-sm">{row.label}</span>
          {row.replaces && (
            <span className="block truncate text-xs text-muted-foreground">
              instead of {row.replaces}
            </span>
          )}
        </span>
      </span>
      <div className="min-w-0 space-y-1.5">
        <ProviderKeySelect row={row} model={model} className="w-full" />
        {row.chosen.length > 1 && (
          <ul className="space-y-1">
            {row.chosen.map((option) => (
              <li
                key={option.key.id}
                className="flex items-center gap-2 text-xs"
              >
                <span className="min-w-0 flex-1 truncate">{option.name}</span>
                <span className="shrink-0 text-muted-foreground">
                  {option.owner}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove ${option.name}`}
                  onClick={() => model.removeKey(option.key.id)}
                >
                  <X />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <span className="flex min-h-9 items-center">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Stop using ${row.label}`}
          onClick={() => model.removeProvider(row.provider)}
        >
          <X />
        </Button>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Model pools and auto routers: read-only rows whose details open on demand
// ---------------------------------------------------------------------------

function PoolsTab({ model }: { model: AccessModel }) {
  return (
    <div>
      {model.listedPools.length === 0 ? (
        <Empty>No model pools yet — add one above.</Empty>
      ) : (
        <div className="divide-y">
          {model.listedPools.map((pool) => (
            <ReadOnlyItem
              key={pool.id}
              icon={<LayersIcon className="size-4" aria-hidden />}
              name={pool.name}
              meta={<PoolMeta pool={pool} />}
              onRemove={() => model.removePool(pool.id)}
            >
              <PoolDetails model={model} pool={pool} />
            </ReadOnlyItem>
          ))}
        </div>
      )}
    </div>
  );
}

function RoutersTab({ model }: { model: AccessModel }) {
  return (
    <div>
      {model.listedRouters.length === 0 ? (
        <Empty>No auto routers yet — add one above.</Empty>
      ) : (
        <div className="divide-y">
          {model.listedRouters.map((router) => (
            <ReadOnlyItem
              key={router.id}
              icon={<Shuffle className="size-4" aria-hidden />}
              name={router.name}
              meta={
                <span>
                  {routerModelCount(model.tiersByRouter.get(router.id))}
                </span>
              }
              onRemove={() => model.removeRouter(router.id)}
            >
              <RouterDetails model={model} routerId={router.id} />
            </ReadOnlyItem>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A pool or router row, laid out like a provider row: name on the left, a
 * short line in the middle, remove on the right. Its details open under it.
 */
function ReadOnlyItem({
  icon,
  name,
  meta,
  onRemove,
  children,
}: {
  icon: ReactNode;
  name: string;
  meta: ReactNode;
  onRemove: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2">
        <CollapsibleTrigger asChild>
          <UnstyledButton
            type="button"
            aria-label={`${open ? "Hide" : "Show"} ${name} details`}
            className="col-span-2 grid min-h-9 grid-cols-subgrid items-center text-left"
          >
            <span className="flex min-w-0 items-center gap-2">
              <ChevronRight
                className={cn(
                  "size-4 shrink-0 text-muted-foreground transition-transform",
                  open && "rotate-90",
                )}
                aria-hidden
              />
              <span className="shrink-0 text-muted-foreground">{icon}</span>
              <span className="truncate font-mono text-sm">{name}</span>
            </span>
            <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              {meta}
            </span>
          </UnstyledButton>
        </CollapsibleTrigger>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Remove ${name}`}
          onClick={onRemove}
        >
          <X />
        </Button>
      </div>
      <CollapsibleContent>
        <div className="mx-3 mb-2.5 rounded-md bg-muted/40 p-2.5 text-xs">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type AccessProps = {
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
};

type TierModel = { provider: SupportedProvider; modelId: string };
type RouterTiers = {
  fast: TierModel | null;
  normal: TierModel | null;
  smart: TierModel | null;
};
const TIER_LABELS = {
  fast: "Fast",
  normal: "Normal",
  smart: "Smart",
} as const;

const ROUTER_HINT =
  "Apps send its name as the model, and it picks a fast, normal or smart model for each session.";
const ROUTER_ENDPOINT_NOTE = "Works only on the OpenAI-compatible endpoint.";

type KeyOption = {
  key: LlmProviderApiKeyResponse;
  name: string;
  owner: string;
  /** Owner and billing, e.g. "Organization · Metered". */
  detail: string;
  /** Discovered models; null while they load. */
  models: number | null;
};

type ProviderRow = {
  provider: SupportedProvider;
  label: string;
  /** Every key this provider has, for the key dropdown. */
  allKeys: KeyOption[];
  /** The keys in the list (one, unless a starting value had several). */
  chosen: KeyOption[];
  /** In automatic mode, the shared primary key this row overrides. */
  replaces?: string;
};

type AccessModel = ReturnType<typeof useAccess>;

/**
 * Everything a variant needs: what's listed, what the picker can still add,
 * and the actions. Adding a provider picks its primary key (or, in automatic
 * mode, its first key that automatic access doesn't already cover); the row's
 * key dropdown changes it.
 */
function useAccess(props: AccessProps) {
  const {
    providerApiKeys,
    value,
    onChange,
    includeFutureProviders,
    modelPoolIds,
    onModelPoolIdsChange,
    canSetModelPools,
    autoRouterIds,
    onAutoRouterIdsChange,
    canSetAutoRouters,
  } = props;
  const catalog = useModelProviderCatalog();
  const ownerLabel = useKeyOwnerLabel();
  const { byKey: modelIdsByKey, pending: modelsPending } = useModelIdsByKey();
  const { data: pools = [] } = useModelPools({ enabled: canSetModelPools });
  const { data: routers = [] } = useAvailableAutoRouters({
    enabled: canSetAutoRouters,
  });
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
  /** In automatic mode, the shared primary key automatic access already uses. */
  const automaticKey = (provider: SupportedProvider) =>
    includeFutureProviders
      ? (grouped.get(provider) ?? []).find(isSharedPrimary)
      : undefined;
  /** Keys a row may switch to: all of them, minus the automatic one. */
  const selectableKeys = (provider: SupportedProvider) => {
    const automatic = automaticKey(provider);
    return (grouped.get(provider) ?? []).filter(
      (key) => key.id !== automatic?.id,
    );
  };

  const listedProviders = providers.filter(
    (provider) => chosenKeys(provider).length > 0,
  );
  const providerRows: ProviderRow[] = listedProviders.map((provider) => {
    const automatic = automaticKey(provider);
    return {
      provider,
      label: catalog.label(provider),
      allKeys: selectableKeys(provider).map(keyOption),
      chosen: chosenKeys(provider).map(keyOption),
      replaces: automatic ? keyName(automatic) : undefined,
    };
  });

  /** Providers the picker can add: not listed, with a key to add. */
  const addableProviders = providers
    .filter((provider) => chosenKeys(provider).length === 0)
    .flatMap((provider) => {
      const keys = selectableKeys(provider);
      if (keys.length === 0) return [];
      const first = keys.find((key) => key.isPrimary) ?? keys[0];
      return [
        {
          provider,
          label: catalog.label(provider),
          keyCount: keys.length,
          first: keyOption(first),
          replaces: automaticKey(provider)
            ? keyName(automaticKey(provider) as LlmProviderApiKeyResponse)
            : undefined,
        },
      ];
    });

  const listedRouters = routers.filter((router) =>
    autoRouterIds.includes(router.id),
  );
  const listedPools = pools.filter((pool) => modelPoolIds.includes(pool.id));
  const addableRouters = canSetAutoRouters
    ? routers.filter((router) => !autoRouterIds.includes(router.id))
    : [];
  const addablePools = canSetModelPools
    ? pools.filter((pool) => !modelPoolIds.includes(pool.id))
    : [];

  const addProvider = (provider: SupportedProvider) => {
    const entry = addableProviders.find((item) => item.provider === provider);
    if (entry)
      onChange([...value, { provider, providerApiKeyId: entry.first.key.id }]);
  };
  /** Replace every key of this provider with one. */
  const setProviderKey = (provider: SupportedProvider, keyId: string) =>
    onChange([
      ...value.filter((mapping) => mapping.provider !== provider),
      { provider, providerApiKeyId: keyId },
    ]);
  const removeProvider = (provider: SupportedProvider) =>
    onChange(value.filter((mapping) => mapping.provider !== provider));
  const removeKey = (keyId: string) =>
    onChange(value.filter((mapping) => mapping.providerApiKeyId !== keyId));
  const addPool = (id: string) => onModelPoolIdsChange([...modelPoolIds, id]);
  const removePool = (id: string) =>
    onModelPoolIdsChange(modelPoolIds.filter((poolId) => poolId !== id));
  const addRouter = (id: string) =>
    onAutoRouterIdsChange([...autoRouterIds, id]);
  const removeRouter = (id: string) =>
    onAutoRouterIdsChange(autoRouterIds.filter((routerId) => routerId !== id));

  /** "8 providers · 1 pool · 1 router" */
  const summary = [
    includeFutureProviders
      ? `all shared providers${
          providerRows.length
            ? ` + ${plural(providerRows.length, "override", "overrides")}`
            : ""
        }`
      : plural(providerRows.length, "provider", "providers"),
    ...(listedPools.length
      ? [plural(listedPools.length, "pool", "pools")]
      : []),
    ...(listedRouters.length
      ? [plural(listedRouters.length, "router", "routers")]
      : []),
  ].join(" · ");

  return {
    props,
    catalog,
    includeFutureProviders,
    providers,
    sharedProviders,
    noProviderKeys: providers.length === 0,
    providerRows,
    addableProviders,
    listedRouters,
    listedPools,
    addableRouters,
    addablePools,
    tiersByRouter,
    summary,
    addProvider,
    setProviderKey,
    removeProvider,
    removeKey,
    addPool,
    removePool,
    addRouter,
    removeRouter,
  };
}

// ---------------------------------------------------------------------------
// Provider access mode cards (unchanged from the current field)
// ---------------------------------------------------------------------------

function ProviderAccessModes({ model }: { model: AccessModel }) {
  const id = useId();
  const { props } = model;
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Provider access</p>
      <RadioGroup
        value={props.includeFutureProviders ? "future" : "selected"}
        onValueChange={(next) =>
          props.onIncludeFutureProvidersChange(next === "future")
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
          disabled={!props.canIncludeFutureProviders}
          title="Current and future providers"
          description="Every shared provider’s primary key, including providers added later. Model pools and auto routers are only the ones you add."
        />
      </RadioGroup>
    </div>
  );
}

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

// ---------------------------------------------------------------------------
// The scoped picker: providers, pools and routers, not individual keys
// ---------------------------------------------------------------------------

type PickerKind = "routers" | "pools" | "providers";

/**
 * Adds a provider (on its primary key), a model pool or an auto router. Keys
 * are chosen afterwards, on the provider's row. Closes after each pick;
 * anything already added is left out.
 */
function ScopedPicker({
  model,
  label = "Add a provider, model pool or auto router",
  only,
  className,
}: {
  model: AccessModel;
  label?: string;
  /** Limit the picker to one kind, e.g. an "Add provider" button in a group. */
  only?: PickerKind;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next) setSearch("");
  };
  const shows = (kind: PickerKind) => !only || only === kind;
  const routers = shows("routers") ? model.addableRouters : [];
  const pools = shows("pools") ? model.addablePools : [];
  const providers = shows("providers") ? model.addableProviders : [];
  const nothingLeft =
    routers.length === 0 && pools.length === 0 && providers.length === 0;

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={label}
          className={cn("w-full justify-start font-normal", className)}
        >
          <Plus className="text-muted-foreground" />
          <span className="flex-1 truncate text-left text-muted-foreground">
            {label}
          </span>
          <ChevronDown className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] min-w-[320px] p-0"
        align="start"
      >
        <Command filter={matchesEveryWord}>
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder={
              only === "providers"
                ? "Search providers…"
                : "Search providers, pools and routers…"
            }
          />
          <CommandList className="max-h-[320px]">
            <CommandEmpty>
              {nothingLeft ? "Everything is already added." : "No matches."}
            </CommandEmpty>
            {routers.length > 0 && (
              <CommandGroup heading="Auto routers">
                {routers.map((router) => (
                  <CommandItem
                    key={router.id}
                    value={`router:${router.id}`}
                    keywords={[router.name, "auto router"]}
                    onSelect={() => {
                      model.addRouter(router.id);
                      changeOpen(false);
                    }}
                  >
                    <Shuffle className="size-3.5 shrink-0" aria-hidden />
                    <RouterSummary
                      name={router.name}
                      tiers={model.tiersByRouter.get(router.id)}
                    />
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {pools.length > 0 && (
              <CommandGroup heading="Model pools">
                {pools.map((pool) => (
                  <CommandItem
                    key={pool.id}
                    value={`pool:${pool.id}`}
                    keywords={[pool.name, "model pool"]}
                    disabled={!poolAnswers(pool)}
                    onSelect={() => {
                      model.addPool(pool.id);
                      changeOpen(false);
                    }}
                  >
                    <LayersIcon className="size-3.5 shrink-0" aria-hidden />
                    <PoolSummary pool={pool} />
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {providers.length > 0 && (
              <CommandGroup heading="Providers">
                {providers.map((entry) => (
                  <CommandItem
                    key={entry.provider}
                    value={`provider:${entry.provider}`}
                    keywords={[entry.label, entry.provider, "provider"]}
                    onSelect={() => {
                      model.addProvider(entry.provider);
                      changeOpen(false);
                    }}
                  >
                    <ProviderIcon provider={entry.provider} size={16} />
                    <span className="flex min-w-0 flex-1 items-baseline gap-2">
                      <span className="truncate text-sm">{entry.label}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {entry.keyCount > 1
                          ? `${plural(entry.keyCount, "key", "keys")} · starts on ${entry.first.name}`
                          : entry.first.name}
                      </span>
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// The provider's key dropdown (today's per-provider key picker)
// ---------------------------------------------------------------------------

/**
 * Picks which of the provider's keys or subscriptions the virtual key uses.
 * Choosing replaces the current key.
 */
function ProviderKeySelect({
  row,
  model,
  className,
}: {
  row: ProviderRow;
  model: AccessModel;
  className?: string;
}) {
  const current = row.chosen[0];
  const items = row.allKeys.map((option) => ({
    value: option.key.id,
    label: option.name,
    searchText: `${option.name} ${option.owner}`,
    description: option.detail,
    content: (
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 basis-full break-words">{option.name}</span>
        {option.key.isPrimary && <PrimaryBadge />}
        {option.models !== null && <ModelCount count={option.models} />}
      </span>
    ),
    selectedContent: (
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate">{option.name}</span>
        {option.key.isPrimary && <PrimaryBadge />}
        {option.models !== null && <ModelCount count={option.models} />}
      </span>
    ),
  }));
  return (
    <SearchableSelect
      className={cn("min-w-0 bg-background", className)}
      ariaLabel={`${row.label} key`}
      value={row.chosen.length === 1 ? (current?.key.id ?? "") : ""}
      placeholder={
        row.chosen.length > 1
          ? plural(row.chosen.length, "key", "keys")
          : "Choose a key"
      }
      onValueChange={(keyId) => model.setProviderKey(row.provider, keyId)}
      items={items}
      showSearch={row.allKeys.length > 6}
      searchPlaceholder={`Search ${row.allKeys.length} ${row.label} keys`}
      emptyMessage="No key matches."
    />
  );
}

// ---------------------------------------------------------------------------
// Read-only details for routers and pools, and small shared bits
// ---------------------------------------------------------------------------

function tierModelsOf(tiers: RouterTiers | undefined) {
  return (Object.keys(TIER_LABELS) as (keyof typeof TIER_LABELS)[]).flatMap(
    (tier) => {
      const model = tiers?.[tier];
      return model ? [{ tier, ...model }] : [];
    },
  );
}

/** "3 models", for a router's line. */
function routerModelCount(tiers: RouterTiers | undefined) {
  const count = new Set(tierModelsOf(tiers).map((model) => model.modelId)).size;
  return count ? plural(count, "model", "models") : "";
}

/** A router's tier table and endpoint note. */
function RouterDetails({
  model,
  routerId,
}: {
  model: AccessModel;
  routerId: string;
}) {
  const tierModels = tierModelsOf(model.tiersByRouter.get(routerId));
  if (!tierModels.length)
    return (
      <p className="text-muted-foreground">
        {ROUTER_HINT} {ROUTER_ENDPOINT_NOTE}
      </p>
    );
  return (
    <div className="space-y-2">
      <DetailGrid headings={["Tier", "Provider", "Model"]}>
        {tierModels.map((tier) => (
          <Fragment key={tier.tier}>
            <span>{TIER_LABELS[tier.tier]}</span>
            <ProviderCell
              provider={tier.provider}
              label={model.catalog.label(tier.provider)}
            />
            <span className="truncate font-mono">{tier.modelId}</span>
          </Fragment>
        ))}
      </DetailGrid>
      <p className="text-muted-foreground">{ROUTER_ENDPOINT_NOTE}</p>
    </div>
  );
}

/** A pool's line: the model it serves, how many more, and a warning. */
function PoolMeta({ pool }: { pool: ModelPool }) {
  const serves = poolServes(pool);
  return (
    <>
      {serves.first && serves.first !== pool.name && (
        <span className="truncate font-mono">{serves.first}</span>
      )}
      {serves.otherModels > 0 && (
        <span>+{plural(serves.otherModels, "model", "models")}</span>
      )}
      {!poolAnswers(pool) && (
        <span className="text-amber-700 dark:text-amber-400">won’t answer</span>
      )}
    </>
  );
}

/** A pool's members in priority order; disabled members struck through. */
function PoolDetails({ model, pool }: { model: AccessModel; pool: ModelPool }) {
  const members = [...pool.members].sort((a, b) => a.priority - b.priority);
  return (
    <DetailGrid headings={["Provider", "Serves"]}>
      {members.map((member) => (
        <Fragment key={member.id}>
          <ProviderCell
            provider={member.provider as SupportedProvider}
            label={model.catalog.label(member.provider)}
            off={!member.enabled}
          />
          <span
            className={cn(
              "truncate font-mono",
              !member.enabled && "text-muted-foreground line-through",
            )}
          >
            {member.modelId}
          </span>
        </Fragment>
      ))}
    </DetailGrid>
  );
}

/** The "All shared providers" line in automatic mode. */
function AllSharedProviders({ model }: { model: AccessModel }) {
  return (
    <div className="flex items-start gap-2">
      <KeyRound
        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="block text-sm">All shared providers</span>
        <span className="block text-xs text-muted-foreground">
          Each shared provider’s primary key. New providers join automatically;
          personal and subscription keys are left out.
        </span>
      </span>
      <span className="mt-0.5 flex shrink-0 items-center gap-1">
        {model.sharedProviders.map((provider) => (
          <ProviderIcon key={provider} provider={provider} size={14} />
        ))}
      </span>
    </div>
  );
}

/** A small table, with a muted heading per column. */
function DetailGrid({
  headings,
  children,
}: {
  headings: string[];
  children: ReactNode;
}) {
  const columns = {
    2: "grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]",
    3: "grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_auto]",
    4: "grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_auto_auto]",
  }[headings.length];
  return (
    <div className={cn("grid items-center gap-x-3 gap-y-1.5", columns)}>
      {headings.map((heading) => (
        <span key={heading || "actions"} className="text-muted-foreground">
          {heading}
        </span>
      ))}
      {children}
    </div>
  );
}

function ProviderCell({
  provider,
  label,
  off = false,
}: {
  provider: SupportedProvider;
  label: string;
  off?: boolean;
}) {
  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-1.5",
        off && "text-muted-foreground line-through",
      )}
    >
      <ProviderIcon provider={provider} size={14} />
      <span className="truncate">{label}</span>
    </span>
  );
}

function ModelCount({ count }: { count: number }) {
  return (
    <span
      className={cn(
        "shrink-0 text-xs tabular-nums",
        count ? "text-muted-foreground" : "text-amber-700 dark:text-amber-400",
      )}
    >
      {count ? plural(count, "model", "models") : "no models"}
    </span>
  );
}

/** A router's name, model count and providers, for the picker. */
function RouterSummary({
  name,
  tiers,
}: {
  name: string;
  tiers: RouterTiers | undefined;
}) {
  const models = tierModelsOf(tiers);
  const providers = [...new Set(models.map((model) => model.provider))];
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <span className="truncate font-mono text-sm">{name}</span>
      {models.length > 0 && (
        <span className="shrink-0 text-xs text-muted-foreground">
          {routerModelCount(tiers)}
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {providers.map((provider) => (
          <ProviderIcon key={provider} provider={provider} size={14} />
        ))}
      </span>
    </span>
  );
}

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

function isSharedPrimary(key: LlmProviderApiKeyResponse): boolean {
  return key.userId === null && key.isPrimary && !key.requiresReauthentication;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
