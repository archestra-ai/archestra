"use client";

import {
  COST_EXPORT_FORMAT_LABELS,
  type CostExportSchedule,
} from "@archestra/shared";
import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogStickyFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useBlobProviders } from "@/lib/blob-provider.query";
import {
  type CostExport,
  useCreateCostExport,
  useUpdateCostExport,
} from "@/lib/cost-export.query";

/** Schedule a cost export, or edit one. */
export function CostExportDialog({
  open,
  onOpenChange,
  costExport,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The export being edited; null creates one. */
  costExport: CostExport | null;
}) {
  const id = useId();
  const { data: providers = [] } = useBlobProviders();
  const create = useCreateCostExport();
  const update = useUpdateCostExport();
  const [values, setValues] = useState<FormValues>(() => toForm(costExport));
  const [submitted, setSubmitted] = useState(false);

  // A fresh form each time the dialog opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: costExport is read when the dialog opens.
  useEffect(() => {
    if (!open) return;
    setValues(toForm(costExport));
    setSubmitted(false);
  }, [open]);

  // Preselect the only provider there is.
  useEffect(() => {
    if (open && !values.blobProviderId && providers.length === 1) {
      setValues((current) => ({ ...current, blobProviderId: providers[0].id }));
    }
  }, [open, providers, values.blobProviderId]);

  const set = (patch: Partial<FormValues>) =>
    setValues((current) => ({ ...current, ...patch }));
  const errors: Partial<Record<keyof FormValues, string>> = {};
  if (!values.name.trim()) errors.name = "Name is required";
  if (!values.blobProviderId) errors.blobProviderId = "Pick a blob provider";
  const shown = (field: keyof FormValues) =>
    submitted ? errors[field] : undefined;
  const saving = create.isPending || update.isPending;

  const submit = async () => {
    setSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    const body = {
      name: values.name,
      blobProviderId: values.blobProviderId,
      schedule: values.schedule,
      pathPrefix: values.pathPrefix,
      enabled: values.enabled,
      format: "focus_csv" as const,
    };
    try {
      if (costExport) {
        await update.mutateAsync({ id: costExport.id, body });
      } else {
        await create.mutateAsync(body);
      }
      onOpenChange(false);
    } catch {
      // The query layer has shown the error; the dialog stays open.
    }
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={costExport ? "Edit cost export" : "Schedule cost export"}
      description={`${COST_EXPORT_FORMAT_LABELS.focus_csv}: one file per completed period, written to a blob provider.`}
      size="small"
    >
      <form
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
              onChange={(event) => set({ name: event.target.value })}
              placeholder="FinOps daily export"
              autoComplete="off"
              autoFocus
            />
          </Field>
          <Field
            id={`${id}-provider`}
            label="Destination"
            error={shown("blobProviderId")}
          >
            {providers.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No blob providers yet.{" "}
                <Link
                  href="/settings/blob-providers"
                  className="text-primary hover:underline"
                >
                  Add one in Settings
                </Link>{" "}
                first.
              </p>
            ) : (
              <Select
                value={values.blobProviderId}
                onValueChange={(value) => set({ blobProviderId: value })}
              >
                <SelectTrigger id={`${id}-provider`} className="w-full">
                  <SelectValue placeholder="Pick a blob provider" />
                </SelectTrigger>
                <SelectContent>
                  {providers.map((provider) => (
                    <SelectItem key={provider.id} value={provider.id}>
                      {provider.name} (s3://{provider.config.bucket})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
          <Field
            id={`${id}-schedule`}
            label="Schedule"
            hint="Times are UTC. A period is written 15 minutes after it ends."
          >
            <Select
              value={values.schedule}
              onValueChange={(value) =>
                set({ schedule: value as CostExportSchedule })
              }
            >
              <SelectTrigger id={`${id}-schedule`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="daily">Daily (one file per day)</SelectItem>
                <SelectItem value="hourly">
                  Hourly (one file per hour)
                </SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field
            id={`${id}-prefix`}
            label="Path prefix"
            hint="Under the provider's own prefix. Files land in year=/month=/day= folders."
          >
            <Input
              id={`${id}-prefix`}
              value={values.pathPrefix}
              onChange={(event) => set({ pathPrefix: event.target.value })}
              autoComplete="off"
            />
          </Field>
          <div className="flex items-center gap-2">
            <Switch
              id={`${id}-enabled`}
              checked={values.enabled}
              onCheckedChange={(checked) => set({ enabled: checked })}
            />
            <Label htmlFor={`${id}-enabled`} className="font-normal">
              Enabled
            </Label>
          </div>
        </DialogBody>
        <DialogStickyFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={saving || providers.length === 0}>
            {saving ? "Saving…" : costExport ? "Save changes" : "Schedule"}
          </Button>
        </DialogStickyFooter>
      </form>
    </FormDialog>
  );
}

// === internal ===

type FormValues = {
  name: string;
  blobProviderId: string;
  schedule: CostExportSchedule;
  pathPrefix: string;
  enabled: boolean;
};

function toForm(costExport: CostExport | null): FormValues {
  return {
    name: costExport?.name ?? "",
    blobProviderId: costExport?.blobProviderId ?? "",
    schedule: costExport?.schedule ?? "daily",
    pathPrefix: costExport?.pathPrefix ?? "cost-exports",
    enabled: costExport?.enabled ?? true,
  };
}

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
