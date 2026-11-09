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
import { Switch } from "@/components/ui/switch";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import {
  type AutoRoutingSettings,
  type AutoRoutingSettingsUpdate,
  useSimulateAutoRouting,
  useUpdateAutoRoutingSettings,
} from "@/lib/auto-routing.query";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { useModelsWithApiKeys } from "@/lib/llm-models.query";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { formatCurrency } from "@/lib/utils/format-currency";
import { cn } from "@/lib/utils/tailwind";
import { BUDGET_PRESET_LABELS, type BudgetPreset } from "./budget-presets";
import { MAX_BUDGET, MIN_BUDGET } from "./budget-scale";
import { parsePlanSummary } from "./plan-document";
import { TIER_COLOR, TIER_LABELS, TIER_NAMES, type TierName } from "./tiers";

type TierValue = { providerApiKeyId: string; modelId: string };
type BudgetMode = BudgetPreset | "custom";
type FormValues = {
  enabled: boolean;
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
    hint: "Auto spends up to this much a day, sending the sessions that benefit most to the bigger models.",
  },
];

const TIER_HINTS: Record<TierName, string> = {
  fast: "Short, simple sessions",
  normal: "Most sessions, and every chat while routing is off",
  smart: "The hardest sessions",
};

/**
 * Everything auto routing needs, in one place: whether it is on, the model and
 * key each tier runs on, and the daily budget. Saving re-plans.
 */
export function ConfigureAutoRoutingDialog({
  settings,
  onOpenChange,
}: {
  settings: AutoRoutingSettings;
  onOpenChange: (open: boolean) => void;
}) {
  const update = useUpdateAutoRoutingSettings();
  const form = useForm<FormValues>({ defaultValues: toFormValues(settings) });
  const options = useTierOptions(settings);
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
      ? validateBudget(values.budgetUsdPerDay, values.enabled)
      : null;
  // The tiers are saved together, so an edited one needs the other two.
  const tiersEdited = !!form.formState.dirtyFields.tiers;
  const problem =
    missingTier && (values.enabled || tiersEdited)
      ? `Choose a ${missingTier} model and key.`
      : unsharedKey && tiersEdited
        ? `Share "${unsharedKey.name}" with the whole organization, or pick another key.`
        : budgetError;
  const isDirty = form.formState.isDirty;

  const onSubmit = form.handleSubmit((submitted) =>
    update.mutate(changedFields(submitted, settings), {
      onSuccess: (saved) => saved && onOpenChange(false),
    }),
  );

  return (
    <FormDialog
      open
      onOpenChange={onOpenChange}
      title="Configure auto routing"
      description="Choose the model each tier runs on and a daily budget. Saving builds a new routing plan."
      size="small"
      className="sm:max-w-[720px]"
      isDirty={isDirty}
    >
      <form onSubmit={onSubmit} className="flex min-h-0 flex-col">
        <DialogBody className="space-y-6">
          <Controller
            control={form.control}
            name="enabled"
            render={({ field }) => (
              <Label className="flex items-start gap-3 rounded-md border p-3 font-normal">
                <Switch
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  disabled={update.isPending}
                  aria-label="Auto routing on"
                />
                <span className="space-y-0.5">
                  <span className="block text-sm font-medium">
                    {field.value ? "Auto routing is on" : "Auto routing is off"}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {field.value
                      ? "Auto is offered in every model picker and on the API."
                      : "Auto is hidden. Chats and agents already on Auto run on the normal model."}
                  </span>
                </span>
              </Label>
            )}
          />
          <section className="space-y-3">
            <div className="space-y-0.5">
              <h3 className="text-sm font-medium">Models</h3>
              <p className="text-xs text-muted-foreground">
                Only provider keys shared with the whole organization can run
                Auto, since every chat and agent on Auto uses them.{" "}
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
                  disabled={update.isPending}
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
                    Auto keeps running on it, but changing the tiers needs
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
            settings={settings}
            disabled={update.isPending}
            budgetError={budgetError}
          />
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
            disabled={!isDirty || problem !== null || update.isPending}
          >
            {update.isPending && <Loader2 className="animate-spin" />}
            <span>Save</span>
          </Button>
        </DialogStickyFooter>
      </form>
    </FormDialog>
  );
}

// =============================================================================
// Internal
// =============================================================================

/**
 * A preset Auto re-derives from usage on every plan, or a custom daily budget:
 * one row of a segmented choice and its cost, where sessions would land on
 * today's traffic, then one line on what the choice does.
 */
function BudgetSection({
  form,
  settings,
  disabled,
  budgetError,
}: {
  form: UseFormReturn<FormValues>;
  settings: AutoRoutingSettings;
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
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 id="auto-routing-budget-heading" className="text-sm font-medium">
          Daily budget
        </h3>
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
      <p className="text-xs text-muted-foreground">{hint}</p>
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
  settings: AutoRoutingSettings,
  tiersEdited: boolean,
): { split: BudgetSplit | null; stale: boolean; note: string | null } {
  const tiersSaved = TIER_NAMES.every((tier) => settings.tiers[tier] !== null);
  const { coldStart } = settings.status;
  const ready =
    tiersSaved && !tiersEdited && coldStart.sessions >= coldStart.required;
  const budget = Number(budgetText);
  const debouncedBudget = useDebouncedValue(budget, 400);
  const customValid = validateBudget(budgetText, true) === null;
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
      note: `Set after ${coldStart.required.toLocaleString("en-US")} sessions (${coldStart.sessions.toLocaleString("en-US")} so far). Until then, Auto uses the normal model.`,
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
      className={cn("space-y-1", stale && "opacity-60")}
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
    <li className="grid gap-2 px-3 py-2.5 sm:grid-cols-[9rem_minmax(0,1fr)_minmax(0,1.25fr)] sm:items-start">
      <div className="space-y-0.5 sm:pt-2">
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
function useTierOptions(settings: AutoRoutingSettings) {
  const { eligibleApiKeyIds, tiers } = settings;
  const { data: allKeys = [] } = useLlmProviderApiKeys();
  const { data: models = [] } = useModelsWithApiKeys({
    includeAssignments: false,
  });
  const eligible = useMemo(
    () => new Set(eligibleApiKeyIds),
    [eligibleApiKeyIds],
  );
  const keys = useMemo(() => {
    const saved = new Set(TIER_NAMES.map((tier) => tiers[tier]?.apiKey.id));
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

function toFormValues(settings: AutoRoutingSettings): FormValues {
  const tier = (name: TierName): TierValue => ({
    providerApiKeyId: settings.tiers[name]?.apiKey.id ?? "",
    modelId: settings.tiers[name]?.id ?? "",
  });
  return {
    enabled: settings.enabled,
    // Nothing chosen yet starts on Balanced.
    budgetMode:
      settings.budgetPreset ??
      (settings.budgetUsdPerDay === null ? "balanced" : "custom"),
    budgetUsdPerDay: settings.budgetUsdPerDay?.toString() ?? "",
    tiers: { fast: tier("fast"), normal: tier("normal"), smart: tier("smart") },
  };
}

/** Routing that is off may stay without a budget; the API refuses turning it on without one. */
function validateBudget(value: string, enabled: boolean): string | null {
  if (!value.trim()) return enabled ? "Set a daily budget." : null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < MIN_BUDGET || parsed > MAX_BUDGET) {
    return `Enter a budget between ${MIN_BUDGET} and ${MAX_BUDGET.toLocaleString("en-US")}.`;
  }
  return null;
}

/**
 * Only edited fields go out; the tiers go together once all three are set. A
 * preset goes out until one is saved, so turning routing on with the
 * preselected one saves it.
 */
function changedFields(
  values: FormValues,
  settings: AutoRoutingSettings,
): AutoRoutingSettingsUpdate {
  const saved = toFormValues(settings);
  const tiersChanged = TIER_NAMES.some(
    (tier) =>
      values.tiers[tier].providerApiKeyId !==
        saved.tiers[tier].providerApiKeyId ||
      values.tiers[tier].modelId !== saved.tiers[tier].modelId,
  );
  const tiersComplete = TIER_NAMES.every(
    (tier) => values.tiers[tier].providerApiKeyId && values.tiers[tier].modelId,
  );
  const custom = values.budgetMode === "custom";
  const savedMode =
    settings.budgetPreset ??
    (settings.budgetUsdPerDay === null ? null : "custom");
  return {
    ...(values.enabled !== saved.enabled ? { enabled: values.enabled } : {}),
    ...(values.budgetMode !== savedMode
      ? {
          budgetPreset:
            values.budgetMode === "custom" ? null : values.budgetMode,
        }
      : {}),
    ...(custom &&
    values.budgetUsdPerDay.trim() &&
    values.budgetUsdPerDay !== saved.budgetUsdPerDay
      ? { budgetUsdPerDay: Number(values.budgetUsdPerDay) }
      : {}),
    ...(tiersChanged && tiersComplete ? { tiers: values.tiers } : {}),
  };
}
