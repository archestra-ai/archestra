"use client";

import {
  COST_EXPORT_FORMAT_LABELS,
  type CostExportSchedule,
} from "@archestra/shared";
import { AlertTriangle, Plus } from "lucide-react";
import { useEffect, useRef } from "react";
import {
  BlobProviderLogo,
  blobProviderLocation,
} from "@/components/blob-provider-logo";
import { FormDialog } from "@/components/form-dialog";
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
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Switch } from "@/components/ui/switch";
import type { CostExport } from "@/lib/cost-export.query";
import { CostExportStartFrom } from "./cost-export-start-from";
import { exampleObjectKey, useCostExportForm } from "./use-cost-export-form";

/**
 * Schedule a cost export, or edit one: name, destination, how often (with
 * each option's file name), where a new export starts (now, or a backfill),
 * and the folder. Edit mode keeps the Enabled switch in the footer.
 */
export function CostExportDialog({
  open,
  onOpenChange,
  costExport,
  initialBlobProviderId,
  onAddProvider,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The export being edited; null creates one. */
  costExport: CostExport | null;
  /** Preselected destination for a new export. */
  initialBlobProviderId?: string | null;
  /**
   * Closes this dialog and opens the add-blob-provider dialog; once the
   * provider saves, this dialog reopens with it preselected.
   */
  onAddProvider: () => void;
}) {
  const form = useCostExportForm({
    open,
    costExport,
    initialBlobProviderId,
    onSaved: () => onOpenChange(false),
  });
  const { id, isEdit, values, set, providers, saving, failure } = form;

  const noticeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (failure) noticeRef.current?.scrollIntoView({ block: "nearest" });
  }, [failure]);

  const noProviders = !form.providersLoading && providers.length === 0;
  const fileName = (schedule: CostExportSchedule) =>
    exampleObjectKey({ ...values, schedule })
      .split("/")
      .pop();

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? "Edit cost export" : "Schedule cost export"}
      description={`Writes ${COST_EXPORT_FORMAT_LABELS.focus_csv} files of LLM cost and usage to a blob provider.`}
      size="small"
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.submit();
        }}
      >
        <DialogBody className="space-y-5">
          <Field id={`${id}-name`} label="Name" error={form.errorFor("name")}>
            <Input
              id={`${id}-name`}
              value={values.name}
              onChange={(event) => set({ name: event.target.value })}
              placeholder="FinOps daily export"
              autoComplete="off"
              aria-invalid={!!form.errorFor("name")}
              autoFocus
            />
          </Field>

          <Field
            id={`${id}-provider`}
            label="Destination"
            error={form.errorFor("blobProviderId")}
          >
            {noProviders ? (
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">
                  No blob providers yet.
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={onAddProvider}
                >
                  <Plus />
                  Add blob provider
                </Button>
              </div>
            ) : (
              <SearchableSelect
                id={`${id}-provider`}
                ariaLabel="Destination"
                className="w-full"
                showSearch={providers.length > 6}
                disabled={form.providersLoading}
                placeholder={
                  form.providersLoading ? "Loading…" : "Pick a blob provider"
                }
                value={values.blobProviderId}
                onValueChange={(value) => set({ blobProviderId: value })}
                items={providers.map((p) => {
                  const location = blobProviderLocation(p).uri;
                  return {
                    value: p.id,
                    label: p.name,
                    content: (
                      <span className="flex min-w-0 items-center gap-2">
                        <BlobProviderLogo type={p.type} />
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate">{p.name}</span>
                          <span className="truncate font-mono text-xs text-muted-foreground">
                            {location}
                          </span>
                        </span>
                      </span>
                    ),
                    selectedContent: (
                      <span className="flex min-w-0 items-center gap-2">
                        <BlobProviderLogo type={p.type} />
                        <span className="truncate">{p.name}</span>
                      </span>
                    ),
                  };
                })}
              />
            )}
          </Field>

          <div className="space-y-2">
            <Label id={`${id}-schedule`}>How often</Label>
            <RadioGroup
              aria-labelledby={`${id}-schedule`}
              value={values.schedule}
              onValueChange={(value) =>
                set({ schedule: value as CostExportSchedule })
              }
              className="gap-2.5"
            >
              {SCHEDULES.map((option) => (
                <Label
                  key={option.value}
                  htmlFor={`${id}-schedule-${option.value}`}
                  className="flex cursor-pointer items-start gap-2.5 font-normal"
                >
                  <RadioGroupItem
                    id={`${id}-schedule-${option.value}`}
                    value={option.value}
                    className="mt-0.5"
                  />
                  <span className="min-w-0 space-y-0.5">
                    <span className="block text-sm">
                      <span className="font-medium">{option.label}</span>
                      <span className="text-muted-foreground">
                        {" "}
                        — {option.hint}
                      </span>
                    </span>
                    <span className="block truncate font-mono text-xs text-muted-foreground">
                      {fileName(option.value)}
                    </span>
                  </span>
                </Label>
              ))}
            </RadioGroup>
          </div>

          {!isEdit && (
            <CostExportStartFrom
              key={form.session}
              id={id}
              schedule={values.schedule}
              onChange={(startFrom) => set({ startFrom })}
            />
          )}

          <Field
            id={`${id}-prefix`}
            label="Folder"
            hint="Files are grouped by date inside it, e.g. year=2026/month=11/day=10/."
          >
            <Input
              id={`${id}-prefix`}
              value={values.pathPrefix}
              onChange={(event) => set({ pathPrefix: event.target.value })}
              placeholder="cost-exports"
              autoComplete="off"
            />
          </Field>

          {failure && (
            <InlineNotice variant="error" ref={noticeRef}>
              <AlertTriangle />
              <InlineNoticeBody>
                <span className="font-medium">Couldn't save</span>
                <InlineNoticeText className="break-words">
                  {failure}
                </InlineNoticeText>
              </InlineNoticeBody>
            </InlineNotice>
          )}
        </DialogBody>
        <DialogStickyFooter>
          {isEdit && (
            <div className="flex items-center gap-2 sm:mr-auto">
              <Switch
                id={`${id}-enabled`}
                checked={values.enabled}
                onCheckedChange={(checked) => set({ enabled: checked })}
              />
              <Label htmlFor={`${id}-enabled`} className="font-normal">
                {values.enabled ? "Enabled" : "Paused"}
              </Label>
            </div>
          )}
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={saving || noProviders}>
            {saving ? "Saving…" : isEdit ? "Save changes" : "Schedule"}
          </Button>
        </DialogStickyFooter>
      </form>
    </FormDialog>
  );
}

// === internal ===

const SCHEDULES: {
  value: CostExportSchedule;
  label: string;
  hint: string;
}[] = [
  {
    value: "daily",
    label: "Daily",
    hint: "one file per UTC day, ready by about 00:20 UTC",
  },
  {
    value: "hourly",
    label: "Hourly",
    hint: "one file per hour, ready about 20 minutes later",
  },
];

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
