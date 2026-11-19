import type { CostExportSchedule } from "@archestra/shared";
import { useEffect, useId, useState } from "react";
import { useBlobProviders } from "@/lib/blob-provider.query";
import {
  type CostExport,
  useCreateCostExport,
  useUpdateCostExport,
} from "@/lib/cost-export.query";
import { getApiErrorMessage } from "@/lib/utils/api";

/**
 * State and behaviour of the cost export create/edit form, shared by every
 * layout of it. A failed save lands in `failure` for the dialog to show.
 */
export function useCostExportForm({
  open,
  costExport,
  initialBlobProviderId,
  onSaved,
}: {
  open: boolean;
  /** The export being edited; null creates one. */
  costExport: CostExport | null;
  /** Preselected destination for a new export. */
  initialBlobProviderId?: string | null;
  onSaved: () => void;
}) {
  const id = useId();
  const { data: providers = [], isLoading: providersLoading } =
    useBlobProviders();
  const create = useCreateCostExport();
  const update = useUpdateCostExport();
  const [values, setValues] = useState<CostExportFormValues>(() =>
    toForm(costExport, initialBlobProviderId),
  );
  const [submitted, setSubmitted] = useState(false);
  // Changes on every open, so state kept outside `values` (the start picker)
  // starts over with the form.
  const [session, setSession] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);

  // A fresh form each time the dialog opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: read when the dialog opens.
  useEffect(() => {
    if (!open) return;
    setValues(toForm(costExport, initialBlobProviderId));
    setSession((current) => current + 1);
    setSubmitted(false);
    setFailure(null);
  }, [open]);

  // Preselect the only provider there is.
  useEffect(() => {
    if (open && !values.blobProviderId && providers.length === 1) {
      setValues((current) => ({ ...current, blobProviderId: providers[0].id }));
    }
  }, [open, providers, values.blobProviderId]);

  const set = (patch: Partial<CostExportFormValues>) => {
    setFailure(null);
    setValues((current) => ({ ...current, ...patch }));
  };
  const errors: Partial<Record<keyof CostExportFormValues, string>> = {};
  if (!values.name.trim()) errors.name = "Name is required";
  if (!values.blobProviderId) errors.blobProviderId = "Pick a blob provider";
  const errorFor = (name: keyof CostExportFormValues) =>
    submitted ? errors[name] : undefined;
  const saving = create.isPending || update.isPending;
  const provider = providers.find((p) => p.id === values.blobProviderId);

  const submit = async () => {
    setSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    setFailure(null);
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
        await create.mutateAsync({
          ...body,
          // A past start is a backfill; omitted, the first file is the
          // period in progress.
          ...(values.startFrom
            ? { startFrom: values.startFrom.toISOString() }
            : {}),
        });
      }
      onSaved();
    } catch (error) {
      setFailure(getApiErrorMessage(error));
    }
  };

  return {
    /** Prefix for element ids, unique per dialog instance. */
    id,
    /** Changes each time the dialog opens; key per-open state on it. */
    session,
    isEdit: !!costExport,
    values,
    set,
    errorFor,
    providers,
    providersLoading,
    /** The chosen destination, once picked. */
    provider,
    saving,
    failure,
    submit,
  };
}

export type CostExportFormValues = {
  name: string;
  blobProviderId: string;
  schedule: CostExportSchedule;
  pathPrefix: string;
  enabled: boolean;
  /** Create only: export from this time on, the past included; null is now. */
  startFrom: Date | null;
};

/**
 * Key of the next period's file under the destination, as the backend
 * writes it: `<pathPrefix>/year=YYYY/month=MM/day=DD/archestra-focus-<period>.csv`.
 */
export function exampleObjectKey(
  values: CostExportFormValues,
  now: Date = new Date(),
): string {
  const prefix = values.pathPrefix.replace(/^\/+|\/+$/g, "");
  // The period in progress is the next one written.
  const iso = now.toISOString();
  const day = iso.slice(0, 10);
  const [year, month, date] = day.split("-");
  const period = values.schedule === "hourly" ? iso.slice(0, 13) : day;
  return `${prefix ? `${prefix}/` : ""}year=${year}/month=${month}/day=${date}/archestra-focus-${period}.csv`;
}

// === internal ===

function toForm(
  costExport: CostExport | null,
  initialBlobProviderId?: string | null,
): CostExportFormValues {
  return {
    name: costExport?.name ?? "",
    blobProviderId: costExport?.blobProviderId ?? initialBlobProviderId ?? "",
    schedule: costExport?.schedule ?? "daily",
    pathPrefix: costExport?.pathPrefix ?? "cost-exports",
    enabled: costExport?.enabled ?? true,
    startFrom: null,
  };
}
