import type { AgentRuntimeTierSettingsInput } from "@archestra/shared";
import { formatMemory } from "@archestra/shared";
import { useEffect, useId, useState } from "react";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DialogBody, DialogStickyFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils/tailwind";
import {
  type RuntimeTierFormField,
  type RuntimeTierFormValues,
  type RuntimeTierSize,
  type RuntimeTiersInEffect,
  runtimeTierFormMemory,
  runtimeTierFormValues,
  runtimeTierSettingsAfter,
  validateRuntimeTierForm,
} from "./runtime-tier-form";

/**
 * Create a tier or edit one. The whole list is saved with the change in it;
 * a refusal from the server stays in the dialog, next to the fields.
 */
export function RuntimeTierDialog({
  open,
  onOpenChange,
  tier,
  tiers,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The tier being edited; null creates one. */
  tier: RuntimeTierSize | null;
  tiers: RuntimeTiersInEffect;
  onSave: (settings: AgentRuntimeTierSettingsInput) => Promise<void>;
}) {
  const id = useId();
  const isDefault =
    tier !== null &&
    tier.name.toLowerCase() === tiers.defaultTier.toLowerCase();
  const [values, setValues] = useState<RuntimeTierFormValues>(() =>
    runtimeTierFormValues(tier, isDefault),
  );
  const [touched, setTouched] = useState<Set<RuntimeTierFormField>>(
    () => new Set(),
  );
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // A fresh form each time the dialog opens, for whichever tier it is for.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tier and isDefault are read when the dialog opens.
  useEffect(() => {
    if (!open) return;
    setValues(runtimeTierFormValues(tier, isDefault));
    setTouched(new Set());
    setSubmitted(false);
    setFailure(null);
  }, [open]);

  const otherNames = tiers.tiers
    .filter((entry) => !tier || entry.name !== tier.name)
    .map((entry) => entry.name);
  const { errors, tier: valid } = validateRuntimeTierForm(values, {
    otherNames,
  });
  const memory = runtimeTierFormMemory(values);
  const shown = (field: RuntimeTierFormField): string | undefined =>
    submitted || touched.has(field) ? errors[field] : undefined;

  const update = (patch: Partial<RuntimeTierFormValues>) => {
    setValues((current) => ({ ...current, ...patch }));
    setFailure(null);
  };
  const touch = (field: RuntimeTierFormField) =>
    setTouched((current) => new Set(current).add(field));

  const submit = async () => {
    setSubmitted(true);
    if (!valid) return;
    setSaving(true);
    try {
      await onSave(
        runtimeTierSettingsAfter(
          tiers,
          tier
            ? {
                kind: "update",
                original: tier.name,
                tier: valid,
                isDefault: values.isDefault,
              }
            : { kind: "create", tier: valid, isDefault: values.isDefault },
        ),
      );
    } catch (error) {
      setFailure(
        error instanceof Error && error.message
          ? error.message
          : "The tier could not be saved",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={tier ? "Edit tier" : "Create tier"}
      size="small"
    >
      <form
        // The fields explain their own problems; the browser's bubbles and
        // step rules would block the save on amounts such as 8.
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <DialogBody className="space-y-4">
          <Field id={`${id}-name`} label="Name" error={shown("name")}>
            <Input
              id={`${id}-name`}
              value={values.name}
              onChange={(event) => update({ name: event.target.value })}
              onBlur={() => touch("name")}
              aria-invalid={shown("name") ? true : undefined}
              aria-describedby={shown("name") ? `${id}-name-error` : undefined}
              autoComplete="off"
              autoFocus
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id={`${id}-cpu-request`}
              label="CPU request"
              error={shown("cpuRequest")}
            >
              <Input
                id={`${id}-cpu-request`}
                type="number"
                inputMode="decimal"
                min={0.1}
                step="any"
                value={values.cpuRequest}
                onChange={(event) => update({ cpuRequest: event.target.value })}
                onBlur={() => touch("cpuRequest")}
                aria-invalid={shown("cpuRequest") ? true : undefined}
                aria-describedby={
                  shown("cpuRequest") ? `${id}-cpu-request-error` : undefined
                }
              />
            </Field>
            <Field
              id={`${id}-cpu-limit`}
              label="CPU limit"
              error={shown("cpuLimit")}
            >
              <Input
                id={`${id}-cpu-limit`}
                type="number"
                inputMode="decimal"
                min={0.1}
                step="any"
                placeholder="No limit"
                value={values.cpuLimit}
                onChange={(event) => update({ cpuLimit: event.target.value })}
                onBlur={() => touch("cpuLimit")}
                aria-invalid={shown("cpuLimit") ? true : undefined}
                aria-describedby={
                  shown("cpuLimit") ? `${id}-cpu-limit-error` : undefined
                }
              />
            </Field>
          </div>
          <p
            className="text-sm text-muted-foreground"
            data-testid="tier-memory"
          >
            {memory
              ? `Memory: ${formatMemory(memory.memoryRequestMiB)}, ${formatMemory(memory.memoryLimitMiB)} limit`
              : "Memory follows the CPU request."}
          </p>
          <div className="flex items-center justify-between gap-4 rounded-md border px-3 py-2">
            <Label htmlFor={`${id}-pooled`} className="font-normal">
              Pooled
            </Label>
            <Switch
              id={`${id}-pooled`}
              checked={values.pooled}
              onCheckedChange={(pooled) => update({ pooled })}
            />
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id={`${id}-default`}
              checked={values.isDefault}
              disabled={isDefault}
              onCheckedChange={(checked) =>
                update({ isDefault: checked === true })
              }
            />
            <Label htmlFor={`${id}-default`} className="font-normal">
              Default tier
            </Label>
          </div>
          {failure && (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          )}
        </DialogBody>
        <DialogStickyFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={saving || (submitted && !valid)}>
            {saving ? "Saving…" : tier ? "Save changes" : "Create tier"}
          </Button>
        </DialogStickyFooter>
      </form>
    </FormDialog>
  );
}

function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className={cn(error && "text-destructive")}>
        {label}
      </Label>
      {children}
      {error && (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
