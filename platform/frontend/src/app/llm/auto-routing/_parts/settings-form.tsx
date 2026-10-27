"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import {
  LlmModelSearchableSelect,
  type LlmModelSelectOption,
} from "@/components/llm-model-select";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  type AutoRoutingSettings,
  type AutoRoutingSettingsUpdate,
  useReplanAutoRouting,
  useUpdateAutoRoutingSettings,
} from "@/lib/auto-routing.query";
import { useLlmModels } from "@/lib/llm-models.query";
import { MAX_BUDGET, MIN_BUDGET } from "./budget-scale";
import { TIER_NAMES, type TierName } from "./tiers";

type FormValues = {
  enabled: boolean;
  budgetUsdPerDay: string;
} & Record<TierField, string>;

type TierField = `${TierName}ModelId`;

export function AutoRoutingSettingsForm({
  settings,
  canUpdate,
}: {
  settings: AutoRoutingSettings;
  canUpdate: boolean;
}) {
  const update = useUpdateAutoRoutingSettings();
  const replan = useReplanAutoRouting();
  const form = useForm<FormValues>({ defaultValues: toFormValues(settings) });
  // A refresh (refetch, re-plan) must not discard unsaved edits.
  useEffect(() => {
    if (!form.formState.isDirty) form.reset(toFormValues(settings));
  }, [settings, form]);

  const modelOptions = useTierModelOptions(settings);
  const budget = Number(form.watch("budgetUsdPerDay")) || 0;
  // From the saved budget, so the thumb moves while a new amount is typed.
  const sliderMax = Math.max(
    100,
    Math.ceil((settings.budgetUsdPerDay ?? 0) * 2),
  );
  const enabled = form.watch("enabled");
  const dirty = form.formState.isDirty;
  const pending = update.isPending || replan.isPending;
  const disabled = !canUpdate || pending;

  const onSubmit = (values: FormValues) =>
    update.mutate(changedFields(values, form.formState.dirtyFields), {
      onSuccess: (saved) => saved && form.reset(toFormValues(saved)),
    });

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="space-y-4 rounded-md border p-4"
      >
        <FormField
          control={form.control}
          name="enabled"
          render={({ field }) => (
            <FormItem className="flex items-center gap-2">
              <FormControl>
                <Switch
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  disabled={disabled}
                />
              </FormControl>
              <FormLabel className="!mt-0">
                {field.value ? "Enabled" : "Disabled"}
              </FormLabel>
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="budgetUsdPerDay"
          rules={{
            validate: (value, values) => validateBudget(value, values.enabled),
          }}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Daily budget (USD)</FormLabel>
              <div className="flex items-center gap-3">
                <Slider
                  aria-label="Daily budget slider"
                  min={0}
                  max={sliderMax}
                  step={1}
                  value={[budget]}
                  onValueChange={([value]) =>
                    form.setValue("budgetUsdPerDay", String(value), {
                      shouldDirty: true,
                      shouldValidate: true,
                    })
                  }
                  disabled={disabled}
                  className="max-w-md"
                />
                <FormControl>
                  <Input
                    type="number"
                    inputMode="decimal"
                    step="any"
                    className="w-32"
                    disabled={disabled}
                    {...field}
                  />
                </FormControl>
              </div>
              <FormMessage />
            </FormItem>
          )}
        />
        <div className="grid gap-3 md:grid-cols-3">
          {TIER_NAMES.map((tier) => (
            <FormField
              key={tier}
              control={form.control}
              name={`${tier}ModelId`}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{TIER_LABELS[tier]}</FormLabel>
                  <LlmModelSearchableSelect
                    value={field.value}
                    onValueChange={field.onChange}
                    options={modelOptions}
                    placeholder="Select model..."
                    showPricing
                    className="w-full"
                    disabled={disabled}
                  />
                </FormItem>
              )}
            />
          ))}
        </div>
        {canUpdate && (
          <Button
            // Remounted per action so a click never flips its own type.
            key={dirty ? "save" : "replan"}
            type={dirty ? "submit" : "button"}
            size="sm"
            disabled={pending}
            title={dirty ? undefined : "Refit on the latest traffic"}
            onClick={dirty ? undefined : () => replan.mutate()}
          >
            {pending ? (
              <Loader2 className="animate-spin" />
            ) : (
              !dirty && <RefreshCw />
            )}
            <span>
              {/* Disabled routing fits nothing, so its save is only a save. */}
              {!dirty ? "Re-plan now" : enabled ? "Save and re-plan" : "Save"}
            </span>
          </Button>
        )}
      </form>
    </Form>
  );
}

const TIER_LABELS: Record<TierName, string> = {
  fast: "Fast model",
  normal: "Normal model",
  smart: "Smart model",
};

/** Disabled routing may stay without a budget; the API refuses enabling one. */
function validateBudget(value: string, enabled: boolean): true | string {
  if (!value.trim()) return enabled ? "Set a daily budget" : true;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < MIN_BUDGET || parsed > MAX_BUDGET) {
    return `Enter an amount between ${MIN_BUDGET} and ${MAX_BUDGET.toLocaleString("en-US")}`;
  }
  return true;
}

function toFormValues(settings: AutoRoutingSettings): FormValues {
  return {
    enabled: settings.enabled,
    budgetUsdPerDay: settings.budgetUsdPerDay?.toString() ?? "",
    fastModelId: settings.tiers.fast?.id ?? "",
    normalModelId: settings.tiers.normal?.id ?? "",
    smartModelId: settings.tiers.smart?.id ?? "",
  };
}

/** Only edited fields go out: every saved change fits a new plan. */
function changedFields(
  values: FormValues,
  dirty: Partial<Record<keyof FormValues, boolean>>,
): AutoRoutingSettingsUpdate {
  return {
    ...(dirty.enabled ? { enabled: values.enabled } : {}),
    ...(dirty.budgetUsdPerDay && values.budgetUsdPerDay.trim()
      ? { budgetUsdPerDay: Number(values.budgetUsdPerDay) }
      : {}),
    ...Object.fromEntries(
      TIER_NAMES.map((tier) => `${tier}ModelId` as const)
        .filter((name) => dirty[name] && values[name])
        .map((name) => [name, values[name]]),
    ),
  };
}

/**
 * Every tool-capable model the viewer can route to (the API rejects others as
 * tiers), plus saved tiers that are not among them.
 */
function useTierModelOptions(
  settings: AutoRoutingSettings,
): LlmModelSelectOption[] {
  const { data: models = [] } = useLlmModels();
  const savedIds = new Set(
    TIER_NAMES.flatMap((tier) => settings.tiers[tier]?.id ?? []),
  );
  const candidates = models.filter(
    (model) =>
      model.capabilities?.supportsToolCalling !== false ||
      savedIds.has(model.dbId),
  );
  const options: LlmModelSelectOption[] = candidates.map((model) => ({
    value: model.dbId,
    model: model.displayName ?? model.id,
    modelId: model.id,
    provider: model.provider,
    pricePerMillionInput: model.capabilities?.pricePerMillionInput,
    pricePerMillionOutput: model.capabilities?.pricePerMillionOutput,
    isBest: model.isBest,
    capabilities: model.capabilities,
  }));
  for (const tier of TIER_NAMES) {
    const saved = settings.tiers[tier];
    if (saved && !options.some((option) => option.value === saved.id)) {
      options.push({
        value: saved.id,
        model: saved.modelId,
        modelId: saved.modelId,
        provider: saved.provider,
      });
    }
  }
  return options;
}
