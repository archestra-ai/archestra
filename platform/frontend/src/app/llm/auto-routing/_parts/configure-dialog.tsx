"use client";

import { providerSupportsChat } from "@archestra/shared";
import { Loader2, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { Controller, type UseFormReturn, useForm } from "react-hook-form";
import { FormDialog } from "@/components/form-dialog";
import {
  LlmModelSearchableSelect,
  type LlmModelSelectOption,
} from "@/components/llm-model-select";
import { LlmProviderApiKeyDropdown } from "@/components/llm-provider-api-key-dropdown";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogStickyFooter } from "@/components/ui/dialog";
import {
  InlineNotice,
  InlineNoticeBody,
  InlineNoticeText,
} from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import {
  AUTO_ROUTER_NAME,
  AUTO_ROUTER_NAME_PREFIX,
} from "@/lib/auto-router-name";
import {
  type AutoRouter,
  type AutoRouterCreate,
  AutoRouterIdContext,
  type AutoRouterUpdate,
  type AutoRoutingState,
  useAutoRoutingState,
  useCreateAutoRouter,
  useSimulateAutoRouting,
  useUpdateAutoRouter,
} from "@/lib/auto-routing.query";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { useModelsWithApiKeys } from "@/lib/llm-models.query";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { formatCurrency } from "@/lib/utils/format-currency";
import { cn } from "@/lib/utils/tailwind";
import { AddJevKeyLink } from "./add-jev-key";
import { BUDGET_PRESET_LABELS, type BudgetPreset } from "./budget-presets";
import { MAX_BUDGET, MIN_BUDGET } from "./budget-scale";
import { parsePlanSummary } from "./plan-document";
import { TIER_COLOR, TIER_LABELS, TIER_NAMES, type TierName } from "./tiers";

type TierValue = { providerApiKeyId: string; modelId: string };
type BudgetMode = BudgetPreset | "custom";
type DecisionValue = { provider: string; apiKeyId: string; model: string };
type FormValues = {
  /** What follows `auto:`; empty for the router named `auto`. */
  nameSuffix: string;
  decision: DecisionValue;
  budgetMode: BudgetMode;
  budgetUsdPerDay: string;
  tiers: Record<TierName, TierValue>;
};

const BUDGET_MODES: { value: BudgetMode; label: string; hint: string }[] = [
  {
    value: "cost_efficient",
    label: BUDGET_PRESET_LABELS.cost_efficient,
    hint: "Mostly the fast model, sized to your traffic on every refit.",
  },
  {
    value: "balanced",
    label: BUDGET_PRESET_LABELS.balanced,
    hint: "A mix of all three models, sized to your traffic on every refit.",
  },
  {
    value: "intelligence",
    label: BUDGET_PRESET_LABELS.intelligence,
    hint: "Mostly the smart model, sized to your traffic on every refit.",
  },
  {
    value: "custom",
    label: "Custom",
    hint: "The router spends up to this much a day, sending the sessions that benefit most to the bigger models.",
  },
];

const TIER_HINTS: Record<TierName, string> = {
  fast: "Short, simple sessions",
  normal: "Most sessions, and every session until the first plan",
  smart: "The hardest sessions",
};

/** The key a router scores with when none is picked: the organization's own. */
const DEFAULT_DECISION_KEY = "default";
const NAME_SUFFIX_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/;

/**
 * Everything one auto router needs, in one place: its name, the model and key
 * each tier runs on, the daily budget, and the model that decides. Saving
 * re-plans. Without a router it creates one.
 */
export function ConfigureAutoRoutingDialog({
  router,
  existingNames = [],
  onOpenChange,
}: {
  router: AutoRouter | null;
  /** The other routers' names, which a name may not repeat. */
  existingNames?: string[];
  onOpenChange: (open: boolean) => void;
}) {
  const { data: state } = useAutoRoutingState();
  if (!state) return null;
  return (
    <AutoRouterIdContext.Provider value={router?.id ?? null}>
      <ConfigureForm
        router={router}
        state={state}
        existingNames={existingNames}
        onOpenChange={onOpenChange}
      />
    </AutoRouterIdContext.Provider>
  );
}

// =============================================================================
// Internal
// =============================================================================

function ConfigureForm({
  router,
  state,
  existingNames,
  onOpenChange,
}: {
  router: AutoRouter | null;
  state: AutoRoutingState;
  existingNames: string[];
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateAutoRouter();
  const update = useUpdateAutoRouter();
  const isPending = create.isPending || update.isPending;
  const form = useForm<FormValues>({
    defaultValues: toFormValues(router, state),
  });
  const options = useTierOptions(router, state);
  const values = form.watch();
  const missingTier = TIER_NAMES.find(
    (tier) =>
      !values.tiers[tier].providerApiKeyId || !values.tiers[tier].modelId,
  );
  // A saved key may predate the organization-wide rule; it keeps working until the tiers change.
  const unsharedKey = TIER_NAMES.map(
    (tier) => values.tiers[tier].providerApiKeyId,
  )
    .filter((id) => id && !options.eligible.has(id))
    .map((id) => options.keys.find((key) => key.id === id))[0];
  const budgetError =
    values.budgetMode === "custom"
      ? validateBudget(values.budgetUsdPerDay)
      : null;
  // The tiers are saved together, so an edited one needs the other two.
  const tiersEdited = !router || !!form.formState.dirtyFields.tiers;
  const nameError = validateName(values.nameSuffix, router, existingNames);
  const problem =
    nameError ??
    (missingTier && tiersEdited
      ? `Choose a ${missingTier} model and key.`
      : unsharedKey && tiersEdited
        ? `Share "${unsharedKey.name}" with the whole organization, or pick another key.`
        : !values.decision.model
          ? "Choose a decision model."
          : budgetError);
  const isDirty = form.formState.isDirty;

  const onSubmit = form.handleSubmit((submitted) => {
    const close = (saved: unknown) => {
      if (saved) onOpenChange(false);
    };
    if (router) {
      update.mutate(
        { id: router.id, body: changedFields(submitted, router, state) },
        { onSuccess: close },
      );
    } else {
      create.mutate(toCreateBody(submitted), { onSuccess: close });
    }
  });

  return (
    <FormDialog
      open
      onOpenChange={onOpenChange}
      title={router ? `Configure ${router.name}` : "Create auto router"}
      description="Choose the model each tier runs on, a daily budget and the model that decides. Saving builds a new routing plan."
      size="small"
      className="sm:max-w-[720px]"
      isDirty={isDirty}
    >
      <form onSubmit={onSubmit} className="flex min-h-0 flex-col">
        <DialogBody className="space-y-6">
          <NameSection
            form={form}
            router={router}
            autoTaken={existingNames.includes(AUTO_ROUTER_NAME)}
            disabled={isPending}
          />
          <section className="space-y-3">
            <div className="space-y-1">
              <h3 className="text-sm font-medium">Models</h3>
              <p className="text-xs text-muted-foreground">
                Only provider keys shared with the whole organization can run a
                router, since every chat, agent and virtual key on it uses them.{" "}
                {!options.keys.some((key) => options.eligible.has(key.id)) && (
                  <Link
                    href="/llm/model-providers"
                    className="text-primary hover:underline"
                  >
                    Add an organization key
                  </Link>
                )}
              </p>
            </div>
            <ul className="divide-y rounded-md border">
              {TIER_NAMES.map((tier) => (
                <TierRow
                  key={tier}
                  tier={tier}
                  form={form}
                  options={options}
                  disabled={isPending}
                />
              ))}
            </ul>
            {unsharedKey && (
              <InlineNotice>
                <TriangleAlert />
                <InlineNoticeBody>
                  <span className="font-medium">
                    {`"${unsharedKey.name}" is not shared with the whole organization`}
                  </span>
                  <InlineNoticeText>
                    The router keeps running on it, but changing the tiers needs
                    organization-wide keys.
                  </InlineNoticeText>
                </InlineNoticeBody>
                <Link
                  href="/llm/model-providers"
                  className="ml-auto text-primary hover:underline"
                >
                  Model Providers
                </Link>
              </InlineNotice>
            )}
          </section>
          <BudgetSection
            form={form}
            settings={router}
            disabled={isPending}
            budgetError={budgetError}
          />
          <DecisionSection form={form} state={state} disabled={isPending} />
        </DialogBody>
        <DialogStickyFooter className="mt-0">
          {problem && isDirty ? (
            <p className="mr-auto text-xs text-destructive">
              <span>{problem}</span>
            </p>
          ) : null}
          <DialogCancelButton>Cancel</DialogCancelButton>
          <Button
            type="submit"
            disabled={!isDirty || problem !== null || isPending}
          >
            {isPending && <Loader2 className="animate-spin" />}
            <span>{router ? "Save" : "Create"}</span>
          </Button>
        </DialogStickyFooter>
      </form>
    </FormDialog>
  );
}

/** The model name clients request: `auto`, or `auto:` and a name of its own. */
function NameSection({
  form,
  router,
  autoTaken,
  disabled,
}: {
  form: UseFormReturn<FormValues>;
  router: AutoRouter | null;
  autoTaken: boolean;
  disabled: boolean;
}) {
  // The bare name `auto` is a name like any other: free unless another router has it.
  const autoFree = !autoTaken || router?.name === AUTO_ROUTER_NAME;
  return (
    <section className="space-y-2">
      <Label htmlFor="auto-router-name" className="text-sm font-medium">
        Name
      </Label>
      <div className="flex items-center">
        <span className="flex h-9 items-center rounded-l-md border border-r-0 bg-muted px-3 font-mono text-sm text-muted-foreground">
          {AUTO_ROUTER_NAME_PREFIX}
        </span>
        <Input
          id="auto-router-name"
          className="rounded-l-none font-mono"
          placeholder="support"
          autoComplete="off"
          disabled={disabled}
          {...form.register("nameSuffix")}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {autoFree
          ? "The model name clients request. Leave the name empty to call the router auto."
          : "The model name clients request. Lowercase letters, numbers, dots, dashes and underscores."}
      </p>
    </section>
  );
}

/**
 * The model that reads each session and judges how hard it is: a provider that
 * offers decision models, one of its keys and one of its models.
 */
function DecisionSection({
  form,
  state,
  disabled,
}: {
  form: UseFormReturn<FormValues>;
  state: AutoRoutingState;
  disabled: boolean;
}) {
  const decision = form.watch("decision");
  const provider = state.decisionProviders.find(
    (candidate) => candidate.provider === decision.provider,
  );
  const set = (next: DecisionValue) =>
    form.setValue("decision", next, { shouldDirty: true });
  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">Decision model</h3>
        <p className="text-xs text-muted-foreground">
          Reads each session to judge how hard it is. Changing it starts the
          router learning again from its own sessions.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-[9rem_minmax(0,1fr)_minmax(0,1.25fr)]">
        <Select
          value={decision.provider}
          disabled={disabled}
          onValueChange={(value) => {
            const next = state.decisionProviders.find(
              (candidate) => candidate.provider === value,
            );
            set({
              provider: value,
              apiKeyId: DEFAULT_DECISION_KEY,
              model: next?.models[0]?.id ?? "",
            });
          }}
        >
          <SelectTrigger className="w-full" aria-label="Decision provider">
            <SelectValue placeholder="Provider" />
          </SelectTrigger>
          <SelectContent>
            {state.decisionProviders.map((candidate) => (
              <SelectItem key={candidate.provider} value={candidate.provider}>
                {DECISION_PROVIDER_LABELS[candidate.provider] ??
                  candidate.provider}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={decision.apiKeyId}
          disabled={disabled}
          onValueChange={(value) => set({ ...decision, apiKeyId: value })}
        >
          <SelectTrigger className="w-full" aria-label="Decision provider key">
            <SelectValue placeholder="Provider key" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_DECISION_KEY}>
              Organization default key
            </SelectItem>
            {(provider?.apiKeys ?? []).map((key) => (
              <SelectItem key={key.id} value={key.id}>
                {key.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={decision.model}
          disabled={disabled}
          onValueChange={(value) => set({ ...decision, model: value })}
        >
          <SelectTrigger className="w-full" aria-label="Decision model">
            <SelectValue placeholder="Model" />
          </SelectTrigger>
          <SelectContent>
            {(provider?.models ?? []).map((model) => (
              <SelectItem key={model.id} value={model.id}>
                {model.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {provider && provider.apiKeys.length === 0 && (
        <p className="text-xs text-muted-foreground">
          <span>
            No key for this provider is shared with the organization.{" "}
          </span>
          <AddJevKeyLink />
        </p>
      )}
    </section>
  );
}

const DECISION_PROVIDER_LABELS: Record<string, string> = { jev: "Jev" };

/**
 * A preset the router re-derives from usage on every plan, or a custom daily budget:
 * a line on what the choice does, one row of the segmented choice and its
 * cost, then where sessions would land on today's traffic.
 */
function BudgetSection({
  form,
  settings,
  disabled,
  budgetError,
}: {
  form: UseFormReturn<FormValues>;
  settings: AutoRouter | null;
  disabled: boolean;
  budgetError: string | null;
}) {
  const mode = form.watch("budgetMode");
  const hint = BUDGET_MODES.find((option) => option.value === mode)?.hint;
  const estimate = useBudgetEstimate(
    mode,
    form.watch("budgetUsdPerDay"),
    settings,
    !!form.formState.dirtyFields.tiers,
  );
  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h3 id="auto-routing-budget-heading" className="text-sm font-medium">
          Daily budget
        </h3>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Controller
          control={form.control}
          name="budgetMode"
          render={({ field }) => (
            // The soft segmented look of the table/card view toggle, built on
            // radios so the choice keeps radio semantics and arrow keys.
            <RadioGroup
              value={field.value}
              onValueChange={(value) => field.onChange(value as BudgetMode)}
              disabled={disabled}
              aria-labelledby="auto-routing-budget-heading"
              className="inline-flex h-8 items-center gap-0.5 rounded-md border bg-muted p-px"
            >
              {BUDGET_MODES.map((option) => (
                <Label
                  key={option.value}
                  className="flex h-7 cursor-pointer items-center rounded-sm px-2.5 text-xs font-normal text-muted-foreground hover:text-foreground has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[[data-state=checked]]:bg-raised has-[[data-state=checked]]:text-foreground has-[[data-state=checked]]:shadow-sm dark:has-[[data-state=checked]]:bg-accent"
                >
                  <RadioGroupItem value={option.value} className="sr-only" />
                  <span>{option.label}</span>
                </Label>
              ))}
            </RadioGroup>
          )}
        />
        <div className="ml-auto">
          {mode === "custom" ? (
            <div className="flex items-center gap-1.5 text-sm">
              <span className="text-muted-foreground">$</span>
              <Input
                id="auto-routing-budget"
                type="number"
                inputMode="decimal"
                step="any"
                aria-label="USD per day"
                className="h-8 w-24"
                disabled={disabled}
                aria-invalid={budgetError !== null}
                {...form.register("budgetUsdPerDay")}
              />
              <span className="text-muted-foreground">/ day</span>
            </div>
          ) : estimate.split ? (
            <p
              className={cn(
                "text-sm font-medium",
                estimate.stale && "opacity-60",
              )}
              title="At today's traffic"
              data-testid="auto-routing-preset-estimate"
            >
              ≈ {formatCurrency(estimate.split.budgetUsdPerDay)}/day
            </p>
          ) : null}
        </div>
      </div>
      {estimate.split ? (
        <TierSplit shares={estimate.split.shares} stale={estimate.stale} />
      ) : estimate.note ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="auto-routing-budget-note"
        >
          {estimate.note}
        </p>
      ) : null}
    </section>
  );
}

type BudgetSplit = {
  budgetUsdPerDay: number;
  shares: readonly [number, number, number];
};

/**
 * The selected budget re-solved on today's traffic with the saved tiers: its
 * cost and the share of sessions each tier would get. A custom budget is
 * estimated once typing pauses; the last split stays up, dimmed, meanwhile.
 */
function useBudgetEstimate(
  mode: BudgetMode,
  budgetText: string,
  settings: AutoRouter | null,
  tiersEdited: boolean,
): { split: BudgetSplit | null; stale: boolean; note: string | null } {
  const tiersSaved =
    settings !== null &&
    TIER_NAMES.every((tier) => settings.tiers[tier] !== null);
  const coldStart = settings?.status.coldStart ?? { sessions: 0, required: 1 };
  const ready =
    tiersSaved && !tiersEdited && coldStart.sessions >= coldStart.required;
  const budget = Number(budgetText);
  const debouncedBudget = useDebouncedValue(budget, 400);
  const customValid = validateBudget(budgetText) === null;
  const body: Parameters<typeof useSimulateAutoRouting>[0] = !ready
    ? null
    : mode !== "custom"
      ? { budgetPreset: mode, volumeMultiplier: 1 }
      : customValid && debouncedBudget === budget
        ? { budgetUsdPerDay: budget, volumeMultiplier: 1 }
        : null;
  const { data, isFetching, isError } = useSimulateAutoRouting(body);
  const summary =
    body && data?.status === "feasible" ? parsePlanSummary(data.summary) : null;
  const current: BudgetSplit | null =
    data?.status === "feasible" && summary
      ? {
          budgetUsdPerDay: data.budgetUsdPerDay,
          shares: summary.tier_session_share,
        }
      : null;
  // The last split shown, kept up (dimmed) while the next one loads.
  const lastRef = useRef<BudgetSplit | null>(null);
  if (current) lastRef.current = current;
  const last = lastRef.current;

  if (!settings) {
    return {
      split: null,
      stale: false,
      note: "A new router starts cold: every session runs on the normal model until it has scored enough of its own.",
    };
  }
  if (!tiersSaved || tiersEdited) {
    return {
      split: null,
      stale: false,
      note: "Save the models to see where sessions would land.",
    };
  }
  if (coldStart.sessions < coldStart.required) {
    return {
      split: null,
      stale: false,
      note: `Set after ${coldStart.required.toLocaleString("en-US")} sessions (${coldStart.sessions.toLocaleString("en-US")} so far). Until then, the router uses the normal model.`,
    };
  }
  if (mode === "custom" && !customValid) {
    return { split: null, stale: false, note: null };
  }
  if (data?.status === "infeasible" && !isFetching) {
    return {
      split: null,
      stale: false,
      note: `Today's traffic needs at least ${formatCurrency(data.minBudgetUsdPerDay)}/day.`,
    };
  }
  if (current && !isFetching)
    return { split: current, stale: false, note: null };
  if (last && !isError) return { split: last, stale: true, note: null };
  return {
    split: null,
    stale: false,
    note: isError ? "No estimate at today's traffic." : "Estimating…",
  };
}

/** One thin bar of the session share per tier, with the percentages under it. */
function TierSplit({
  shares,
  stale,
}: {
  shares: readonly [number, number, number];
  stale: boolean;
}) {
  return (
    <div
      className={cn("space-y-2", stale && "opacity-60")}
      data-testid="auto-routing-budget-split"
    >
      <div className="flex h-2 gap-0.5 overflow-hidden rounded-full">
        {TIER_NAMES.map((tier, i) =>
          shares[i] > 0 ? (
            <div
              key={tier}
              className={cn("transition-[flex-grow]", TIER_COLOR[tier].swatch)}
              style={{ flexGrow: shares[i] }}
            />
          ) : null,
        )}
      </div>
      <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
        {TIER_NAMES.map((tier, i) => (
          <span key={tier} className="flex items-center gap-1.5">
            <span
              className={cn("size-2 rounded-sm", TIER_COLOR[tier].swatch)}
            />
            <span>
              {Math.round(shares[i] * 100)}% {tier}
            </span>
          </span>
        ))}
        <span className="ml-auto">of sessions at today's traffic</span>
      </p>
    </div>
  );
}

type TierOptions = ReturnType<typeof useTierOptions>;

function TierRow({
  tier,
  form,
  options,
  disabled,
}: {
  tier: TierName;
  form: UseFormReturn<FormValues>;
  options: TierOptions;
  disabled: boolean;
}) {
  const [keyOpen, setKeyOpen] = useState(false);
  const keyId = form.watch(`tiers.${tier}.providerApiKeyId`);
  return (
    <li className="grid gap-3 p-3 sm:grid-cols-[9rem_minmax(0,1fr)_minmax(0,1.25fr)] sm:items-start">
      <div className="space-y-1 sm:pt-2">
        <span className="block text-sm font-medium">{TIER_LABELS[tier]}</span>
        <span className="block text-xs text-muted-foreground">
          {TIER_HINTS[tier]}
        </span>
      </div>
      <LlmProviderApiKeyDropdown
        availableKeys={options.keys}
        selectedApiKeyId={keyId || null}
        open={keyOpen}
        onOpenChange={setKeyOpen}
        disabled={disabled}
        onSelectKey={(next) => {
          form.setValue(`tiers.${tier}.providerApiKeyId`, next, {
            shouldDirty: true,
          });
          form.setValue(`tiers.${tier}.modelId`, "", { shouldDirty: true });
          setKeyOpen(false);
        }}
        triggerVariant="select"
        triggerClassName="w-full"
        triggerAriaLabel={`${TIER_LABELS[tier]} provider key`}
        emptyTriggerLabel="Select provider key..."
      />
      <Controller
        control={form.control}
        name={`tiers.${tier}.modelId`}
        render={({ field }) => (
          <LlmModelSearchableSelect
            options={options.modelsByKey.get(keyId) ?? []}
            value={field.value}
            onValueChange={field.onChange}
            disabled={disabled || !keyId}
            placeholder={keyId ? "Select model..." : "Select a key first"}
            emptyMessage="This key has no synced models."
            className="w-full"
            popoverContentClassName="w-[400px]"
            popoverAlign="start"
          />
        )}
      />
    </li>
  );
}

/**
 * The organization-wide keys a tier may run on, plus any key a tier is saved
 * on so the dialog can name it, and each key's chat models by catalog id.
 */
function useTierOptions(router: AutoRouter | null, state: AutoRoutingState) {
  const { eligibleApiKeyIds } = state;
  const tiers = router?.tiers;
  const { data: allKeys = [] } = useLlmProviderApiKeys();
  const { data: models = [] } = useModelsWithApiKeys({
    includeAssignments: false,
  });
  const eligible = useMemo(
    () => new Set(eligibleApiKeyIds),
    [eligibleApiKeyIds],
  );
  const keys = useMemo(() => {
    const saved = new Set(TIER_NAMES.map((tier) => tiers?.[tier]?.apiKey.id));
    return allKeys.filter(
      (key) =>
        (eligible.has(key.id) || saved.has(key.id)) &&
        providerSupportsChat(key.provider),
    );
  }, [allKeys, eligible, tiers]);
  const modelsByKey = useMemo(() => {
    const byKey = new Map<string, LlmModelSelectOption[]>();
    for (const model of models) {
      if (model.ignored || model.embeddingDimensions) continue;
      for (const key of model.apiKeys) {
        byKey.set(key.id, [
          ...(byKey.get(key.id) ?? []),
          {
            value: model.id,
            model: model.description || model.modelId,
            modelId: model.modelId,
            provider: model.provider,
          },
        ]);
      }
    }
    return byKey;
  }, [models]);
  return { keys, eligible, modelsByKey };
}

function toFormValues(
  router: AutoRouter | null,
  state: AutoRoutingState,
): FormValues {
  const tier = (name: TierName): TierValue => ({
    providerApiKeyId: router?.tiers[name]?.apiKey.id ?? "",
    modelId: router?.tiers[name]?.id ?? "",
  });
  return {
    nameSuffix: router?.name.startsWith(AUTO_ROUTER_NAME_PREFIX)
      ? router.name.slice(AUTO_ROUTER_NAME_PREFIX.length)
      : "",
    // Nothing chosen yet starts on Balanced.
    budgetMode:
      router?.budgetPreset ??
      (router?.budgetUsdPerDay == null ? "balanced" : "custom"),
    budgetUsdPerDay: router?.budgetUsdPerDay?.toString() ?? "",
    tiers: { fast: tier("fast"), normal: tier("normal"), smart: tier("smart") },
    decision: toDecisionValue(router, state),
  };
}

/** The provider is the one holding the saved key, or offering the saved model. */
function toDecisionValue(
  router: AutoRouter | null,
  state: AutoRoutingState,
): DecisionValue {
  const saved = router?.decisionModel;
  const provider =
    state.decisionProviders.find(
      (candidate) =>
        saved &&
        (candidate.apiKeys.some((key) => key.id === saved.apiKeyId) ||
          candidate.models.some((model) => model.id === saved.model)),
    ) ?? state.decisionProviders[0];
  return {
    provider: provider?.provider ?? "",
    apiKeyId: saved?.apiKeyId ?? DEFAULT_DECISION_KEY,
    model: saved?.model ?? provider?.models[0]?.id ?? "",
  };
}

function toName(suffix: string): string {
  const trimmed = suffix.trim();
  return trimmed ? `${AUTO_ROUTER_NAME_PREFIX}${trimmed}` : AUTO_ROUTER_NAME;
}

function validateName(
  suffix: string,
  router: AutoRouter | null,
  existingNames: string[],
): string | null {
  const trimmed = suffix.trim();
  if (trimmed && !NAME_SUFFIX_PATTERN.test(trimmed)) {
    return "Use lowercase letters, numbers, dots, dashes and underscores in the name.";
  }
  const name = toName(suffix);
  if (name !== router?.name && existingNames.includes(name)) {
    return trimmed
      ? `Another router is already named ${name}.`
      : "Give the router a name.";
  }
  return null;
}

function validateBudget(value: string): string | null {
  if (!value.trim()) return "Set a daily budget.";
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < MIN_BUDGET || parsed > MAX_BUDGET) {
    return `Enter a budget between ${MIN_BUDGET} and ${MAX_BUDGET.toLocaleString("en-US")}.`;
  }
  return null;
}

function toDecisionBody(decision: DecisionValue) {
  return {
    apiKeyId:
      decision.apiKeyId === DEFAULT_DECISION_KEY ? null : decision.apiKeyId,
    model: decision.model,
  };
}

function toCreateBody(values: FormValues): AutoRouterCreate {
  return {
    name: toName(values.nameSuffix),
    ...(values.budgetMode === "custom"
      ? { budgetUsdPerDay: Number(values.budgetUsdPerDay) }
      : { budgetPreset: values.budgetMode }),
    tiers: values.tiers,
    decisionModel: toDecisionBody(values.decision),
  };
}

/** Only edited fields go out; the tiers go together. */
function changedFields(
  values: FormValues,
  router: AutoRouter,
  state: AutoRoutingState,
): AutoRouterUpdate {
  const saved = toFormValues(router, state);
  const tiersChanged = TIER_NAMES.some(
    (tier) =>
      values.tiers[tier].providerApiKeyId !==
        saved.tiers[tier].providerApiKeyId ||
      values.tiers[tier].modelId !== saved.tiers[tier].modelId,
  );
  const custom = values.budgetMode === "custom";
  const savedMode =
    router.budgetPreset ?? (router.budgetUsdPerDay === null ? null : "custom");
  const name = toName(values.nameSuffix);
  return {
    ...(name !== router.name ? { name } : {}),
    ...(values.budgetMode !== savedMode
      ? {
          budgetPreset:
            values.budgetMode === "custom" ? null : values.budgetMode,
        }
      : {}),
    ...(custom && values.budgetUsdPerDay !== saved.budgetUsdPerDay
      ? { budgetUsdPerDay: Number(values.budgetUsdPerDay) }
      : {}),
    ...(tiersChanged ? { tiers: values.tiers } : {}),
    ...(values.decision.apiKeyId !== saved.decision.apiKeyId ||
    values.decision.model !== saved.decision.model
      ? { decisionModel: toDecisionBody(values.decision) }
      : {}),
  };
}
