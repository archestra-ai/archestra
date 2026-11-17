import type { AgentRuntimeTierSettingsInput } from "@archestra/shared";
import { useEffect, useId, useState } from "react";
import { FormDialog } from "@/components/form-dialog";
import {
  type RuntimeTierFormField,
  type RuntimeTierFormValues,
  type RuntimeTierSize,
  type RuntimeTiersInEffect,
  runtimeTierFormMemory,
  runtimeTierFormValues,
  runtimeTierSettingsAfter,
  suggestRuntimeTierName,
  validateRuntimeTierForm,
} from "@/components/runtime-tiers/runtime-tier-form";
import {
  RuntimeTierField as Field,
  RuntimeTierResourceFields,
} from "@/components/runtime-tiers/runtime-tier-resource-fields";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DialogBody, DialogStickyFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { PooledHint } from "./pooled-hint";

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
  const [suggestedName, setSuggestedName] = useState(() =>
    tier ? "" : suggestRuntimeTierName(tiers.tiers.map((entry) => entry.name)),
  );

  // A fresh form each time the dialog opens, for whichever tier it is for.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tier, tiers and isDefault are read when the dialog opens.
  useEffect(() => {
    if (!open) return;
    setValues(runtimeTierFormValues(tier, isDefault));
    setSuggestedName(
      tier
        ? ""
        : suggestRuntimeTierName(tiers.tiers.map((entry) => entry.name)),
    );
    setTouched(new Set());
    setSubmitted(false);
    setFailure(null);
  }, [open]);

  const otherNames = tiers.tiers
    .filter((entry) => !tier || entry.name !== tier.name)
    .map((entry) => entry.name);
  const defaultCpuRequest =
    tier?.cpuRequest ??
    tiers.tiers.find((entry) => entry.name === tiers.defaultTier)?.cpuRequest ??
    4;
  const effectiveValues = {
    ...values,
    name: !tier && !values.name.trim() ? suggestedName : values.name,
    cpuRequest: values.cpuRequest.trim() || String(defaultCpuRequest),
  };
  const { errors, tier: valid } = validateRuntimeTierForm(effectiveValues, {
    otherNames,
  });
  const defaultMemory = runtimeTierFormMemory({
    cpuRequest: effectiveValues.cpuRequest,
    cpuLimit: values.cpuLimit,
    memoryRequestGiB: values.memoryRequestGiB,
  });
  const shown = (field: RuntimeTierFormField): string | undefined =>
    open && (submitted || touched.has(field)) ? errors[field] : undefined;

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
              placeholder={tier ? undefined : suggestedName}
              autoComplete="off"
              autoFocus
            />
          </Field>
          <RuntimeTierResourceFields
            id={id}
            values={values}
            update={update}
            touch={touch}
            shown={shown}
            defaultCpuRequest={defaultCpuRequest}
            defaultMemory={defaultMemory}
          />
          <Field
            id={`${id}-workspace`}
            label="Disk (GiB)"
            error={shown("workspaceGiB")}
          >
            <Input
              id={`${id}-workspace`}
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              placeholder={String(tiers.defaultWorkspaceGiB)}
              value={values.workspaceGiB}
              onChange={(event) => update({ workspaceGiB: event.target.value })}
              onBlur={() => touch("workspaceGiB")}
              aria-invalid={shown("workspaceGiB") ? true : undefined}
              aria-describedby={
                shown("workspaceGiB")
                  ? `${id}-workspace-error`
                  : `${id}-workspace-hint`
              }
            />
            <p
              id={`${id}-workspace-hint`}
              className="text-sm text-muted-foreground"
              data-testid="tier-workspace"
            >
              {workspaceHint(tiers.defaultWorkspaceGiB)}
            </p>
          </Field>
          <div className="flex items-center justify-between gap-4 rounded-md border px-3 py-2">
            <span className="flex items-center gap-1.5">
              <Label htmlFor={`${id}-pooled`} className="font-normal">
                Pooled
              </Label>
              <PooledHint />
            </span>
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

/** What a blank disk field uses. */
function workspaceHint(defaultWorkspaceGiB: number): string {
  return `${defaultWorkspaceGiB} GiB by default`;
}
