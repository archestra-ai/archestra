import { AlertCircle } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { FormDialog } from "@/components/form-dialog";
import {
  type RuntimeTierFormField,
  type RuntimeTierFormValues,
  type RuntimeTierInput,
  runtimeTierFormMemory,
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

/** Shared tier editor; callers own their tier-specific fields and persistence. */
export function RuntimeTierEditor({
  open,
  onOpenChange,
  originalName,
  initialValues,
  existingNames,
  defaultCpuRequest,
  onSave,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  originalName: string | null;
  initialValues: RuntimeTierFormValues;
  existingNames: readonly string[];
  defaultCpuRequest: number;
  onSave: (
    tier: RuntimeTierInput,
    values: RuntimeTierFormValues,
  ) => Promise<void>;
  children?: (fields: {
    id: string;
    values: RuntimeTierFormValues;
    update: (patch: Partial<RuntimeTierFormValues>) => void;
    touch: (field: RuntimeTierFormField) => void;
    shown: (field: RuntimeTierFormField) => string | undefined;
  }) => ReactNode;
}) {
  const id = useId();
  const isEditing = originalName !== null;
  const [values, setValues] = useState<RuntimeTierFormValues>(
    () => initialValues,
  );
  const [touched, setTouched] = useState<Set<RuntimeTierFormField>>(
    () => new Set(),
  );
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [suggestedName, setSuggestedName] = useState(() =>
    isEditing ? "" : suggestRuntimeTierName(existingNames),
  );

  // A fresh form each time the dialog opens, for whichever tier it is for.
  // biome-ignore lint/correctness/useExhaustiveDependencies: initial values and names are captured when the dialog opens; refetches must not discard edits.
  useEffect(() => {
    if (!open) return;
    setValues(initialValues);
    setSuggestedName(isEditing ? "" : suggestRuntimeTierName(existingNames));
    setTouched(new Set());
    setSubmitted(false);
    setFailure(null);
  }, [open]);

  const otherNames = existingNames.filter((name) => name !== originalName);
  const effectiveValues = {
    ...values,
    name: !isEditing && !values.name.trim() ? suggestedName : values.name,
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
      await onSave(valid, values);
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
      title={isEditing ? "Edit tier" : "Create tier"}
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
              placeholder={isEditing ? undefined : suggestedName}
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
          {children?.({ id, values, update, touch, shown })}
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
            {saving ? "Saving…" : isEditing ? "Save changes" : "Create tier"}
          </Button>
        </DialogStickyFooter>
      </form>
    </FormDialog>
  );
}
