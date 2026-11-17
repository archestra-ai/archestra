import type {
  McpRuntimeTierSettingsInput,
  McpRuntimeTierSize,
} from "@archestra/shared";
import { AlertCircle } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { FormDialog } from "@/components/form-dialog";
import {
  type RuntimeTierFormField,
  type RuntimeTierFormValues,
  runtimeTierFormMemory,
  runtimeTierFormValues,
  suggestRuntimeTierName,
  validateRuntimeTierForm,
} from "@/components/runtime-tiers/runtime-tier-form";
import {
  RuntimeTierField as Field,
  RuntimeTierResourceFields,
} from "@/components/runtime-tiers/runtime-tier-resource-fields";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogStickyFooter } from "@/components/ui/dialog";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { mcpRuntimeTierInput } from "./mcp-runtime-tier-form";

/**
 * Create a tier or edit one. The whole list is saved with the change in it;
 * a refusal from the server stays in the dialog, next to the fields.
 */
export function McpRuntimeTierDialog({
  open,
  onOpenChange,
  tier,
  tiers,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The tier being edited; null creates one. */
  tier: McpRuntimeTierSize | null;
  tiers: { tiers: McpRuntimeTierSize[] };
  onSave: (settings: McpRuntimeTierSettingsInput) => Promise<void>;
}) {
  const id = useId();
  const initialValues = () =>
    runtimeTierFormValues(
      tier
        ? {
            ...tier,
            pooled: false,
            warmSpares: 0,
            workspaceGiB: null,
          }
        : null,
      false,
    );
  const [values, setValues] = useState<RuntimeTierFormValues>(() =>
    initialValues(),
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: tier and tiers are read when the dialog opens.
  useEffect(() => {
    if (!open) return;
    setValues(initialValues());
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
  const defaultCpuRequest = tier?.cpuRequest ?? 1;
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
      const saved = {
        name: valid.name,
        cpuRequest: valid.cpuRequest,
        cpuLimit: valid.cpuLimit,
        memoryRequestMiB: valid.memoryRequestMiB,
        memoryLimitMiB: valid.memoryLimitMiB,
      };
      await onSave({
        tiers: tier
          ? tiers.tiers.map((entry) =>
              entry.name === tier.name
                ? { ...saved, previousName: tier.name }
                : mcpRuntimeTierInput(entry),
            )
          : [...tiers.tiers.map(mcpRuntimeTierInput), saved],
      });
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
          {failure && (
            <InlineNotice variant="error" role="alert">
              <AlertCircle />
              <span className="font-medium">Could not save tier</span>
              <InlineNoticeText>{failure}</InlineNoticeText>
            </InlineNotice>
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
