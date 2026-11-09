"use client";

import { providerSupportsChat } from "@archestra/shared";
import { Loader2, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
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
import {
  RadioGroup,
  RadioGroupItem,
  radioCardClass,
} from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import {
  type AutoRoutingSettings,
  type AutoRoutingSettingsUpdate,
  useSimulateAutoRouting,
  useUpdateAutoRoutingSettings,
} from "@/lib/auto-routing.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useModelsWithApiKeys } from "@/lib/llm-models.query";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { formatCurrency } from "@/lib/utils/format-currency";
import { cn } from "@/lib/utils/tailwind";
import { BUDGET_PRESET_LABELS, type BudgetPreset } from "./budget-presets";
import { MAX_BUDGET, MIN_BUDGET } from "./budget-scale";
import { parsePlanSummary } from "./plan-document";
import { TIER_LABELS, TIER_NAMES, type TierName } from "./tiers";

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
    hint: "Mostly the fast model",
  },
  {
    value: "balanced",
    label: BUDGET_PRESET_LABELS.balanced,
    hint: "A mix, halfway in cost",
  },
  {
    value: "intelligence",
    label: BUDGET_PRESET_LABELS.intelligence,
    hint: "Mostly the smart model",
  },
  { value: "custom", label: "Custom", hint: "Your own daily budget" },
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

/** A preset Auto re-derives from usage on every plan, or a custom daily budget. */
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
  const appName = useAppName();
  const mode = form.watch("budgetMode");
  return (
    <section className="space-y-3">
      <div className="space-y-0.5">
        <h3 className="text-sm font-medium">Daily budget</h3>
        <p className="text-xs text-muted-foreground">
          {mode === "custom"
            ? "Auto spends up to this much a day, sending the sessions that benefit most to the bigger models."
            : `${appName} sets the budget from recent traffic and adjusts it every time the plan is refitted.`}
        </p>
      </div>
      <Controller
        control={form.control}
        name="budgetMode"
        render={({ field }) => (
          <RadioGroup
            value={field.value}
            onValueChange={(value) => field.onChange(value as BudgetMode)}
            disabled={disabled}
            aria-label="Daily budget"
            className="grid-cols-2 gap-2 sm:grid-cols-4"
          >
            {BUDGET_MODES.map((option) => (
              <Label
                key={option.value}
                className={cn(
                  radioCardClass(),
                  "flex cursor-pointer items-start gap-2 rounded-lg p-3 font-normal",
                )}
              >
                <RadioGroupItem value={option.value} className="mt-0.5" />
                <span className="space-y-0.5">
                  <span className="block text-sm font-medium">
                    {option.label}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {option.hint}
                  </span>
                </span>
              </Label>
            ))}
          </RadioGroup>
        )}
      />
      {mode === "custom" ? (
        <div className="space-y-1.5">
          <Label htmlFor="auto-routing-budget">USD per day</Label>
          <Input
            id="auto-routing-budget"
            type="number"
            inputMode="decimal"
            step="any"
            className="w-40"
            disabled={disabled}
            aria-invalid={budgetError !== null}
            {...form.register("budgetUsdPerDay")}
          />
        </div>
      ) : (
        <PresetEstimate
          preset={mode}
          settings={settings}
          tiersEdited={!!form.formState.dirtyFields.tiers}
        />
      )}
    </section>
  );
}

/** What the preset resolves to on today's traffic, with the saved tiers. */
function PresetEstimate({
  preset,
  settings,
  tiersEdited,
}: {
  preset: BudgetPreset;
  settings: AutoRoutingSettings;
  tiersEdited: boolean;
}) {
  const tiersSaved = TIER_NAMES.every((tier) => settings.tiers[tier] !== null);
  const { coldStart } = settings.status;
  const canEstimate =
    tiersSaved && !tiersEdited && coldStart.sessions >= coldStart.required;
  const { data, isPending, isError } = useSimulateAutoRouting(
    canEstimate ? { budgetPreset: preset, volumeMultiplier: 1 } : null,
  );
  const text = (() => {
    if (!tiersSaved || tiersEdited) {
      return "The budget is estimated once the models are saved.";
    }
    if (coldStart.sessions < coldStart.required) {
      return `The budget is set once ${coldStart.required.toLocaleString("en-US")} sessions are scored (${coldStart.sessions.toLocaleString("en-US")} so far). Until then, Auto runs every session on the normal model.`;
    }
    if (isPending) return "Estimating at today's traffic…";
    if (isError || data?.status !== "feasible") {
      return "No estimate at today's traffic.";
    }
    const summary = parsePlanSummary(data.summary);
    const shares = summary
      ? TIER_NAMES.map(
          (tier, i) =>
            `${Math.round(summary.tier_session_share[i] * 100)}% ${tier}`,
        ).join(", ")
      : null;
    return `At today's traffic: about ${formatCurrency(data.budgetUsdPerDay)}/day${shares ? ` (sessions: ${shares})` : ""}.`;
  })();
  return (
    <p
      className="text-xs text-muted-foreground"
      data-testid="auto-routing-preset-estimate"
    >
      {text}
    </p>
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
