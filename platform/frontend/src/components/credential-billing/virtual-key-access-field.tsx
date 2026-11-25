"use client";

import type { SupportedProvider } from "@archestra/shared";
import {
  ChevronDown,
  KeyRound,
  LayersIcon,
  Plus,
  Shuffle,
  X,
} from "lucide-react";
import { Fragment, type ReactNode, useId, useMemo, useState } from "react";
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
import { Badge } from "@/components/ui/badge";
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

/**
 * Everything a new virtual key can reach: whether it follows the
 * organization's shared providers, one picker that adds an auto router, a
 * model pool or a provider key, and what's added, in a block per kind. Rows
 * are read-only: each opens to show what's behind it, and changing one means
 * removing it and adding another. Saves the same fields the separate pickers
 * did.
 */
export function VirtualKeyAccessField(props: AccessProps) {
  const model = useAccess(props);

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
        <AccessPicker model={model} />
        <div className="divide-y">
          {model.listedRouters.length > 0 && (
            <KindSection
              title="Auto routers"
              hint="Apps send its name as the model"
            >
              {model.listedRouters.map((router) => (
                <AccessRow
                  key={router.id}
                  icon={<Shuffle className="size-4" aria-hidden />}
                  name={<span className="font-mono">{router.name}</span>}
                  label={router.name}
                  meta={
                    <span className="truncate">
                      {tierModelIds(model.tiersByRouter.get(router.id))}
                    </span>
                  }
                  onRemove={() => model.removeRouter(router.id)}
                >
                  <RouterDetails model={model} routerId={router.id} />
                </AccessRow>
              ))}
            </KindSection>
          )}
          {model.listedPools.length > 0 && (
            <KindSection
              title="Model pools"
              hint="One name that fails over across its members"
            >
              {model.listedPools.map((pool) => (
                <AccessRow
                  key={pool.id}
                  icon={<LayersIcon className="size-4" aria-hidden />}
                  name={<span className="font-mono">{pool.name}</span>}
                  label={pool.name}
                  meta={<PoolMeta pool={pool} />}
                  onRemove={() => model.removePool(pool.id)}
                >
                  <PoolDetails model={model} pool={pool} />
                </AccessRow>
              ))}
            </KindSection>
          )}
          <KindSection
            title="Providers"
            hint={
              model.includeFutureProviders
                ? "Each shared provider’s primary key, including providers added later"
                : "Apps call each provider’s models by name, on the key shown"
            }
          >
            <ProvidersBlock model={model} />
          </KindSection>
        </div>
      </section>
    </div>
  );
}

/** One kind of access: its name and what it gives on the left, rows on the right. */
function KindSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="grid gap-2 py-3 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4"
    >
      <div className="space-y-1 sm:pt-2">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <div className="min-w-0 space-y-0.5">{children}</div>
    </section>
  );
}

/**
 * A router, pool or provider: its name and a short line, a chevron that opens
 * read-only details under it, and remove on the right.
 */
function AccessRow({
  icon,
  name,
  label,
  nameClassName,
  meta,
  onRemove,
  removeLabel,
  children,
}: {
  icon: ReactNode;
  name: ReactNode;
  /** Plain name, for the buttons' labels. */
  label: string;
  nameClassName?: string;
  meta: ReactNode;
  onRemove: () => void;
  removeLabel?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="flex items-center gap-2">
        <CollapsibleTrigger asChild>
          <UnstyledButton
            type="button"
            aria-label={`${open ? "Hide" : "Show"} ${label} details`}
            className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-md text-left"
          >
            <span className="shrink-0 text-muted-foreground">{icon}</span>
            <span
              className={cn("min-w-0 shrink-0 truncate text-sm", nameClassName)}
            >
              {name}
            </span>
            <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              {meta}
            </span>
            <ChevronDown
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform",
                open && "rotate-180",
              )}
              aria-hidden
            />
          </UnstyledButton>
        </CollapsibleTrigger>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={removeLabel ?? `Remove ${label}`}
          onClick={onRemove}
        >
          <X />
        </Button>
      </div>
      <CollapsibleContent>
        <div className="mb-2 mt-0.5 ml-6 mr-9 rounded-md bg-muted/40 p-2.5 text-xs">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

function ProvidersBlock({ model }: { model: AccessModel }) {
  if (model.noProviderKeys && !model.includeFutureProviders)
    return <NoProviderKeys />;
  return (
    <>
      {model.includeFutureProviders && <AllSharedProviders model={model} />}
      {model.providerRows.map((row) => (
        <AccessRow
          key={row.provider}
          icon={<ProviderIcon provider={row.provider} size={16} />}
          name={row.label}
          label={row.label}
          nameClassName="w-36"
          meta={<ProviderMeta row={row} />}
          removeLabel={`Stop using ${row.label}`}
          onRemove={() => model.removeProvider(row.provider)}
        >
          <ProviderDetails row={row} />
        </AccessRow>
      ))}
      {!model.includeFutureProviders && model.providerRows.length === 0 && (
        <p className="py-2 text-sm text-muted-foreground">
          No providers yet — add one above.
        </p>
      )}
    </>
  );
}

/** "anthropic-prod · 14 models PRIMARY", or "2 keys" for several. */
function ProviderMeta({ row }: { row: ProviderRow }) {
  const [only] = row.chosen;
  if (row.chosen.length > 1)
    return (
      <span className="truncate">
        {plural(row.chosen.length, "key", "keys")}
      </span>
    );
  if (!only) return null;
  return (
    <>
      <span className="truncate">
        <span>{only.name}</span>
        {only.modelIds !== null && (
          <span> · {plural(only.modelIds.length, "model", "models")}</span>
        )}
      </span>
      {only.key.isPrimary && <PrimaryBadge />}
    </>
  );
}

const MODEL_SAMPLE_SIZE = 3;

/** Each key the provider uses: who owns it, how it bills, a few of its models. */
function ProviderDetails({ row }: { row: ProviderRow }) {
  return (
    <div className="space-y-3">
      {row.chosen.map((option) => (
        <div key={option.key.id} className="space-y-2">
          <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5">
            <span className="text-muted-foreground">Key</span>
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate">{option.name}</span>
              {option.key.isPrimary && <PrimaryBadge />}
            </span>
            <span className="text-muted-foreground">Owner</span>
            <span className="truncate">{option.detail}</span>
            <span className="text-muted-foreground">Models</span>
            <ModelSample modelIds={option.modelIds} />
          </div>
        </div>
      ))}
    </div>
  );
}

function ModelSample({ modelIds }: { modelIds: string[] | null }) {
  if (modelIds === null)
    return <span className="text-muted-foreground">Loading…</span>;
  if (modelIds.length === 0)
    return (
      <span className="text-amber-700 dark:text-amber-400">
        No models found on this key
      </span>
    );
  const sample = [...modelIds].sort().slice(0, MODEL_SAMPLE_SIZE);
  const more = modelIds.length - sample.length;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {sample.map((modelId) => (
        <span
          key={modelId}
          className="max-w-full truncate rounded bg-background px-1.5 py-px font-mono"
        >
          {modelId}
        </span>
      ))}
      {more > 0 && <span className="text-muted-foreground">+{more} more</span>}
    </span>
  );
}

/** The "All shared providers" line in automatic mode. */
function AllSharedProviders({ model }: { model: AccessModel }) {
  return (
    <div className="flex items-start gap-2 py-2">
      <KeyRound
        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="block text-sm">All shared providers</span>
        <span className="block text-xs text-muted-foreground">
          New providers join automatically; personal and subscription keys are
          left out.
        </span>
      </span>
      <span className="mt-0.5 flex shrink-0 items-center gap-1 pr-2">
        {model.sharedProviders.map((provider) => (
          <ProviderIcon key={provider} provider={provider} size={14} />
        ))}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Model pools and auto routers
// ---------------------------------------------------------------------------

/** A pool's providers, and whether it won't answer. */
function PoolMeta({ pool }: { pool: ModelPool }) {
  const providers = [
    ...new Set(
      pool.members.map((member) => member.provider as SupportedProvider),
    ),
  ];
  return (
    <>
      <span className="flex shrink-0 items-center gap-1">
        {providers.map((provider) => (
          <ProviderIcon key={provider} provider={provider} size={14} />
        ))}
      </span>
      {!poolAnswers(pool) && (
        <Badge variant="outline" className="text-muted-foreground">
          Won&apos;t answer
        </Badge>
      )}
    </>
  );
}

/** What a pool serves, then its members in priority order. */
function PoolDetails({ model, pool }: { model: AccessModel; pool: ModelPool }) {
  const members = [...pool.members].sort((a, b) => a.priority - b.priority);
  const serves = poolServes(pool);
  return (
    <div className="space-y-2">
      {serves.first && serves.first !== pool.name && (
        <p className="text-muted-foreground">
          Serves{" "}
          <span className="font-mono text-foreground">{serves.first}</span>
          {serves.otherModels > 0 && (
            <span> and {plural(serves.otherModels, "other", "others")}</span>
          )}
        </p>
      )}
      <DetailGrid headings={["Provider", "Model"]}>
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
    </div>
  );
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
  return (
    <div className="space-y-2">
      {tierModels.length > 0 ? (
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
      ) : (
        <p className="text-muted-foreground">{ROUTER_HINT}</p>
      )}
      <p className="text-muted-foreground">{ROUTER_ENDPOINT_NOTE}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Props and state
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
  modelIds: string[] | null;
};

type ProviderRow = {
  provider: SupportedProvider;
  label: string;
  /** The keys in the list (one, unless a starting value had several). */
  chosen: KeyOption[];
};

type PickerProvider = {
  provider: SupportedProvider;
  label: string;
  /** Keys the picker offers. */
  keys: KeyOption[];
};

type AccessModel = ReturnType<typeof useAccess>;

/**
 * What's listed, what the picker can still add, and the actions. The picker
 * adds one key per provider; once a provider is listed its keys leave the
 * picker until its row is removed. With current and future providers it adds
 * no provider keys: every shared provider's primary key is already in.
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
    modelIds: modelsPending ? null : (modelIdsByKey.get(key.id) ?? []),
  });
  const chosenKeys = (provider: SupportedProvider) => {
    const keys = grouped.get(provider) ?? [];
    return value.flatMap((mapping) =>
      mapping.provider === provider
        ? (keys.find((key) => key.id === mapping.providerApiKeyId) ?? [])
        : [],
    );
  };
  const providerRows: ProviderRow[] = providers
    .filter((provider) => chosenKeys(provider).length > 0)
    .map((provider) => ({
      provider,
      label: catalog.label(provider),
      chosen: chosenKeys(provider).map(keyOption),
    }));

  // Every key the picker can still add, by provider. A listed provider is
  // left out: one key per provider, and switching means removing it and
  // adding the other.
  const pickerProviders: PickerProvider[] = includeFutureProviders
    ? []
    : providers.flatMap((provider) => {
        if (chosenKeys(provider).length > 0) return [];
        const keys = (grouped.get(provider) ?? []).map(keyOption);
        return keys.length
          ? [{ provider, label: catalog.label(provider), keys }]
          : [];
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

  const addKey = (provider: SupportedProvider, providerApiKeyId: string) =>
    onChange([...value, { provider, providerApiKeyId }]);
  const removeProvider = (provider: SupportedProvider) =>
    onChange(value.filter((mapping) => mapping.provider !== provider));
  // Rebuilt from the pools and routers that still exist, so one deleted
  // elsewhere drops out on the next change instead of failing Create.
  const listedPoolIds = listedPools.map((pool) => pool.id);
  const listedRouterIds = listedRouters.map((router) => router.id);
  const addPool = (id: string) => onModelPoolIdsChange([...listedPoolIds, id]);
  const removePool = (id: string) =>
    onModelPoolIdsChange(listedPoolIds.filter((poolId) => poolId !== id));
  const addRouter = (id: string) =>
    onAutoRouterIdsChange([...listedRouterIds, id]);
  const removeRouter = (id: string) =>
    onAutoRouterIdsChange(
      listedRouterIds.filter((routerId) => routerId !== id),
    );

  /** "8 providers · 1 pool · 1 router" */
  const summary = [
    includeFutureProviders
      ? "all shared providers"
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
    sharedProviders,
    noProviderKeys: providers.length === 0,
    providerRows,
    pickerProviders,
    listedRouters,
    listedPools,
    addableRouters,
    addablePools,
    tiersByRouter,
    summary,
    addKey,
    removeProvider,
    addPool,
    removePool,
    addRouter,
    removeRouter,
  };
}

// ---------------------------------------------------------------------------
// Provider access mode cards
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
// The picker: auto routers, model pools and provider keys, by kind
// ---------------------------------------------------------------------------

/**
 * Adds an auto router, a model pool or (in selected-providers mode) one
 * provider key. Grouped by kind;
 * under Providers, every key of each provider not listed yet, under that
 * provider's name. Closes after each pick; anything already added is left
 * out.
 */
function AccessPicker({ model }: { model: AccessModel }) {
  const label = model.includeFutureProviders
    ? "Add a model pool or auto router"
    : "Add a provider, model pool or auto router";
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next) setSearch("");
  };
  const routers = model.addableRouters;
  const pools = model.addablePools;
  const providers = model.pickerProviders;
  const nothingLeft =
    routers.length === 0 && pools.length === 0 && providers.length === 0;
  // Each provider is its own group, so its keys stay under its name while
  // the search filters. The first one still showing carries the kind label.
  const firstShownProvider = providers.find((entry) =>
    entry.keys.some((option) =>
      matchesEveryWord(
        `key:${option.key.id}`,
        search,
        keyKeywords(entry, option),
      ),
    ),
  )?.provider;

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={label}
          className="w-full justify-start font-normal"
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
              model.includeFutureProviders
                ? "Search pools and routers…"
                : "Search providers, keys, pools and routers…"
            }
          />
          <CommandList className="max-h-[360px]">
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
            {providers.map((entry) => (
              <CommandGroup
                key={entry.provider}
                heading={
                  <>
                    {entry.provider === firstShownProvider && (
                      <span className="block pb-2">Providers</span>
                    )}
                    <span className="flex items-center gap-2 text-sm text-foreground">
                      <ProviderIcon provider={entry.provider} size={16} />
                      <span>{entry.label}</span>
                    </span>
                  </>
                }
              >
                {entry.keys.map((option) => (
                  <CommandItem
                    key={option.key.id}
                    value={`key:${option.key.id}`}
                    keywords={keyKeywords(entry, option)}
                    className="pl-8"
                    onSelect={() => {
                      model.addKey(entry.provider, option.key.id);
                      changeOpen(false);
                    }}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="sr-only">{entry.label} </span>
                        <span className="truncate text-sm">{option.name}</span>
                        {option.key.isPrimary && <PrimaryBadge />}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {option.detail}
                      </span>
                    </span>
                    {option.modelIds !== null && (
                      <ModelCount count={option.modelIds.length} />
                    )}
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

// ---------------------------------------------------------------------------
// Small shared bits
// ---------------------------------------------------------------------------

function tierModelsOf(tiers: RouterTiers | undefined) {
  return (Object.keys(TIER_LABELS) as (keyof typeof TIER_LABELS)[]).flatMap(
    (tier) => {
      const model = tiers?.[tier];
      return model ? [{ tier, ...model }] : [];
    },
  );
}

/** "gemini-3-flash · claude-haiku-4-5 · claude-sonnet-4-5", for a router's line. */
function tierModelIds(tiers: RouterTiers | undefined) {
  return [...new Set(tierModelsOf(tiers).map((model) => model.modelId))].join(
    " · ",
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
  }[headings.length];
  return (
    <div className={cn("grid items-center gap-x-3 gap-y-1.5", columns)}>
      {headings.map((heading) => (
        <span key={heading} className="text-muted-foreground">
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
  const count = new Set(models.map((model) => model.modelId)).size;
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <span className="truncate font-mono text-sm">{name}</span>
      {count > 0 && (
        <span className="shrink-0 text-xs text-muted-foreground">
          {plural(count, "model", "models")}
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

/** What a provider key is found by in the picker's search. */
function keyKeywords(entry: PickerProvider, option: KeyOption): string[] {
  return [
    entry.label,
    entry.provider,
    option.name,
    option.owner,
    isSubscriptionKey(option.key) ? "subscription" : "metered",
  ];
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
