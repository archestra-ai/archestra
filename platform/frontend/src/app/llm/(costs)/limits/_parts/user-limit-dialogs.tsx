"use client";

import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import {
  DialogBody,
  DialogForm,
  DialogStickyFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import type {
  DefaultUserLimit,
  UserLimitUsage,
} from "@/lib/default-user-limit.query";
import {
  useCreateLimit,
  useDeleteLimit,
  useUpdateLimit,
} from "@/lib/limits.query";
import { cn } from "@/lib/utils/tailwind";
import {
  firstName,
  formatDate,
  formatLimit,
  formatUsd,
  intervalLabel,
  STATUS_META,
  statusFor,
} from "./user-limits-shared";

/** Who a reset is for: specific users, or everyone at their limit. */
export type ResetTarget =
  | { kind: "users"; rows: UserLimitUsage[] }
  | { kind: "allAtLimit"; count: number };

export function ResetUsageDialog({
  target,
  resetsAt,
  isPending,
  onOpenChange,
  onConfirm,
}: {
  target: ResetTarget | null;
  resetsAt: string | null;
  isPending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const single =
    target?.kind === "users" && target.rows.length === 1
      ? target.rows[0]
      : null;
  const count =
    target?.kind === "users" ? target.rows.length : (target?.count ?? 0);
  return (
    <DeleteConfirmDialog
      open={!!target}
      onOpenChange={onOpenChange}
      title={
        single
          ? `Reset usage for ${single.name}?`
          : `Reset usage for ${count} users?`
      }
      description={
        <span className="block space-y-2">
          <span className="block">
            {single
              ? `Spend restarts at $0 now, so ${firstName(single.name)} can make requests again.`
              : "Spend restarts at $0 now for each of them, so they can make requests again."}
          </span>
          <span className="block">
            {`The next automatic reset stays on schedule${resetsAt ? `, ${formatDate(resetsAt)}` : ""}. Past usage stays in cost reports.`}
          </span>
        </span>
      }
      isPending={isPending}
      confirmVariant="default"
      confirmLabel="Reset usage"
      pendingLabel="Resetting..."
      onConfirm={onConfirm}
    />
  );
}

export function RemoveCustomLimitDialog({
  row,
  fallback,
  onOpenChange,
  onRemoved,
}: {
  row: UserLimitUsage | null;
  fallback: DefaultUserLimit | undefined;
  onOpenChange: (open: boolean) => void;
  onRemoved: (row: UserLimitUsage) => void;
}) {
  const deleteLimit = useDeleteLimit();
  return (
    <DeleteConfirmDialog
      open={!!row}
      onOpenChange={onOpenChange}
      title={`Remove ${row ? firstName(row.name) : ""}'s custom limit?`}
      description={
        row ? <RemoveDescription row={row} fallback={fallback} /> : ""
      }
      isPending={deleteLimit.isPending}
      confirmLabel="Remove custom limit"
      pendingLabel="Removing..."
      onConfirm={async () => {
        if (!row?.customLimitId) return;
        const result = await deleteLimit.mutateAsync({
          id: row.customLimitId,
        });
        if (!result) return;
        onOpenChange(false);
        onRemoved(row);
      }}
    />
  );
}

/**
 * Set a custom limit for one user, or change the one they have. A new custom
 * limit keeps its own count, which starts at $0.
 */
export function CustomLimitDialog({
  row,
  fallback,
  onOpenChange,
  onSaved,
}: {
  row: UserLimitUsage | null;
  fallback: DefaultUserLimit | undefined;
  onOpenChange: (open: boolean) => void;
  onSaved: (row: UserLimitUsage) => void;
}) {
  const createLimit = useCreateLimit();
  const updateLimit = useUpdateLimit();
  const form = useForm<{ limitValue: string; reason: string }>({
    defaultValues: { limitValue: "", reason: "" },
  });

  useEffect(() => {
    if (!row) return;
    // Changing a custom limit keeps its reason unless the admin edits it.
    form.reset(
      row.source === "custom"
        ? {
            limitValue: String(row.limitValue ?? ""),
            reason: row.customReason ?? "",
          }
        : { limitValue: String(suggestLimit(row)), reason: "" },
    );
  }, [row, form]);

  const draft = parseAmount(form.watch("limitValue"));
  const error = form.formState.errors.limitValue?.message;
  const isCustom = row?.source === "custom";
  const interval =
    row?.cleanupInterval && row.cleanupInterval !== "minute"
      ? row.cleanupInterval
      : (fallback?.cleanupInterval ?? "calendar_month");
  const base = row ? (row.limitValue ?? Math.max(row.spent, 20)) : 0;
  const picks = row
    ? Array.from(
        new Set([1.5, 2, 3].map((factor) => roundUp(base * factor, 5))),
      ).filter((value) => value > 0)
    : [];
  const isPending = createLimit.isPending || updateLimit.isPending;

  return (
    <FormDialog
      open={!!row}
      onOpenChange={onOpenChange}
      size="small"
      title={isCustom ? "Change custom limit" : "Set custom limit"}
      description={
        row
          ? row.source === "none"
            ? `${row.name} has no limit today. This sets one just for them.`
            : isCustom
              ? `A limit set just for ${row.name}.`
              : `${row.name} gets this limit instead of the ${row.source === "environment_default" && row.environmentName ? `${row.environmentName} override` : "organization default"}.`
          : undefined
      }
    >
      <DialogForm
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={form.handleSubmit(async (values) => {
          const limitValue = parseAmount(values.limitValue);
          if (!row || limitValue === null) return;
          const reason = values.reason.trim() || null;
          const result =
            isCustom && row.customLimitId
              ? await updateLimit.mutateAsync({
                  id: row.customLimitId,
                  limitValue,
                  reason,
                })
              : await createLimit.mutateAsync({
                  entityType: "user",
                  entityId: row.userId,
                  limitType: "token_cost",
                  limitValue,
                  cleanupInterval: interval,
                  model: null,
                  reason,
                });
          if (!result) return;
          onOpenChange(false);
          onSaved(row);
        })}
      >
        <DialogBody className="space-y-4">
          <div className="space-y-2">
            {/* Today's limit and spend ride on the label row instead of a card. */}
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
              <Label htmlFor="custom-user-limit-value">
                {`Limit per ${intervalLabel(interval).toLowerCase()}`}
              </Label>
              {row ? (
                <span className="text-xs text-muted-foreground tabular-nums">
                  {row.limitValue === null
                    ? "No limit now"
                    : `Now ${formatLimit(row.limitValue)}`}
                  {" · "}
                  <span className={STATUS_META[row.status].text}>
                    {row.percent === null
                      ? `${formatUsd(row.spent)} spent`
                      : `${formatUsd(row.spent)} spent (${Math.round(row.percent)}%)`}
                  </span>
                </span>
              ) : null}
            </div>
            <InputGroup>
              <InputGroupAddon>
                <span>$</span>
              </InputGroupAddon>
              <InputGroupInput
                id="custom-user-limit-value"
                type="number"
                inputMode="decimal"
                min={1}
                step={1}
                autoFocus
                className="tabular-nums"
                aria-invalid={Boolean(error)}
                {...form.register("limitValue", {
                  validate: (value) =>
                    parseAmount(value) !== null || "Enter an amount above $0",
                })}
              />
            </InputGroup>
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
              {picks.length > 0 ? (
                <div className="flex items-center gap-1.5">
                  {picks.map((value) => (
                    <Button
                      key={value}
                      type="button"
                      size="xs"
                      variant="outline"
                      className="tabular-nums"
                      onClick={() =>
                        form.setValue("limitValue", String(value), {
                          shouldDirty: true,
                          shouldValidate: true,
                        })
                      }
                    >
                      {formatLimit(value)}
                    </Button>
                  ))}
                </div>
              ) : null}
              {error ? (
                <p className="text-xs text-destructive">{error}</p>
              ) : row && draft !== null ? (
                <CustomLimitPreview row={row} draft={draft} />
              ) : null}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="custom-user-limit-reason">Reason (optional)</Label>
            <Input
              id="custom-user-limit-reason"
              placeholder="For example, running the nightly eval suite"
              maxLength={500}
              {...form.register("reason")}
            />
          </div>
        </DialogBody>
        <DialogStickyFooter className="mt-0">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={isPending}>
            {isCustom ? "Save custom limit" : "Set custom limit"}
          </Button>
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}

// ===
// Internal helpers

function CustomLimitPreview({
  row,
  draft,
}: {
  row: UserLimitUsage;
  draft: number;
}) {
  // A new custom limit counts from $0; a changed one keeps its spend.
  if (row.source !== "custom") {
    return (
      <p className="text-xs text-muted-foreground">
        {row.status === "at"
          ? `Counts from $0, so ${firstName(row.name)} is unblocked right away`
          : "Counts spend from $0 when set"}
      </p>
    );
  }
  const nextPercent = (row.spent / draft) * 100;
  const status = statusFor(nextPercent);
  return (
    <p className="text-xs text-muted-foreground tabular-nums">
      <span>{`${firstName(row.name)} would be at `}</span>
      <span className={cn("font-medium", STATUS_META[status].text)}>
        {`${Math.round(nextPercent)}%`}
      </span>
      {status === "at" ? (
        <span>, still blocked</span>
      ) : row.status === "at" ? (
        <span>, unblocked right away</span>
      ) : null}
    </p>
  );
}

function RemoveDescription({
  row,
  fallback,
}: {
  row: UserLimitUsage;
  fallback: DefaultUserLimit | undefined;
}) {
  // The reason tells whoever removes the limit why it was there.
  const reason = row.customReason ? (
    <span className="block">
      {"It was set for: "}
      <span className="text-foreground">{row.customReason}</span>
    </span>
  ) : null;
  if (!fallback) {
    return (
      <span className="block space-y-2">
        {reason}
        <span className="block">{`${firstName(row.name)} will have no user limit once this is removed.`}</span>
      </span>
    );
  }
  const nextPercent = ((row.fallbackSpent ?? 0) / fallback.limitValue) * 100;
  return (
    <span className="block space-y-2">
      {reason}
      <span className="block">
        {`${firstName(row.name)} goes back to the organization default of ${formatLimit(fallback.limitValue)} per ${intervalLabel(fallback.cleanupInterval).toLowerCase()}.`}
      </span>
      <span className="block">
        {nextPercent >= 100
          ? `At current spend that is ${Math.round(nextPercent)}% used, so new requests will be blocked until the next reset.`
          : `At current spend that is ${Math.round(nextPercent)}% used.`}
      </span>
    </span>
  );
}

function parseAmount(raw: string): number | null {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100) / 100;
}

function suggestLimit(row: UserLimitUsage) {
  if (row.limitValue === null) {
    return roundUp(Math.max(row.spent * 1.25, 25), 25);
  }
  return roundUp(Math.max(row.limitValue * 1.5, row.spent * 1.25), 25);
}

function roundUp(value: number, step: number) {
  return Math.ceil(value / step) * step;
}
