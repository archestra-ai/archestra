"use client";

import { Check, Trash2 } from "lucide-react";
import type {
  FieldArrayWithId,
  FieldPath,
  FieldValues,
  UseFormWatch,
} from "react-hook-form";
import type { FieldScopeValue } from "@/components/field-scope-select";
import { Button } from "@/components/ui/button";
import { usePresetEntityName } from "@/lib/organization.query";

interface HeadersReadOnlyTableProps<TFieldValues extends FieldValues> {
  form: { watch: UseFormWatch<TFieldValues> };
  // biome-ignore lint/suspicious/noExplicitAny: field arrays require generic any
  fields: FieldArrayWithId<TFieldValues, any, "id">[];
  fieldNamePrefix: string;
  onEdit: (index: number) => void;
  onDelete: (index: number) => void;
}

const GRID_CLASS =
  "grid grid-cols-[1.6fr_1.4fr_0.6fr_0.5fr_0.7fr_2.2fr_auto] gap-3 px-4";

export function HeadersReadOnlyTable<TFieldValues extends FieldValues>({
  form,
  fields,
  fieldNamePrefix,
  onEdit,
  onDelete,
}: HeadersReadOnlyTableProps<TFieldValues>) {
  return (
    <div>
      <div
        className={`${GRID_CLASS} border-b py-2.5 text-xs font-medium text-foreground`}
      >
        <div>Header name</div>
        <div>Value</div>
        <div>Required</div>
        <div>Bearer</div>
        <div>Sensitive</div>
        <div>Description</div>
        <div className="w-9" />
      </div>
      {fields.map((field, index) => {
        const headerName = form.watch(
          `${fieldNamePrefix}.${index}.headerName` as FieldPath<TFieldValues>,
        ) as string | undefined;
        const required = Boolean(
          form.watch(
            `${fieldNamePrefix}.${index}.required` as FieldPath<TFieldValues>,
          ),
        );
        const promptOnInstallation = Boolean(
          form.watch(
            `${fieldNamePrefix}.${index}.promptOnInstallation` as FieldPath<TFieldValues>,
          ),
        );
        const promptOnPreset = Boolean(
          form.watch(
            `${fieldNamePrefix}.${index}.promptOnPreset` as FieldPath<TFieldValues>,
          ),
        );
        const scope: FieldScopeValue = promptOnInstallation
          ? "installation"
          : promptOnPreset
            ? "preset"
            : "static";
        const value = form.watch(
          `${fieldNamePrefix}.${index}.value` as FieldPath<TFieldValues>,
        ) as string | undefined;
        const includeBearerPrefix = Boolean(
          form.watch(
            `${fieldNamePrefix}.${index}.includeBearerPrefix` as FieldPath<TFieldValues>,
          ),
        );
        const sensitive = Boolean(
          form.watch(
            `${fieldNamePrefix}.${index}.sensitive` as FieldPath<TFieldValues>,
          ),
        );
        const description = form.watch(
          `${fieldNamePrefix}.${index}.description` as FieldPath<TFieldValues>,
        ) as string | undefined;

        return (
          // biome-ignore lint/a11y/useSemanticElements: row contains nested delete <button>, so wrapping in <button> is invalid HTML
          <div
            key={field.id}
            role="button"
            tabIndex={0}
            onClick={() => onEdit(index)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onEdit(index);
              }
            }}
            className={`${GRID_CLASS} group items-center border-b py-3 text-xs last:border-b-0 cursor-pointer hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
          >
            <div className="min-w-0 truncate font-mono">
              {headerName || (
                <span className="text-muted-foreground italic">unnamed</span>
              )}
            </div>
            <div className="min-w-0 truncate">
              <ValueCell scope={scope} value={value} />
            </div>
            <div>
              {scope === "installation" && required ? (
                <Check className="h-3.5 w-3.5 text-foreground" />
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </div>
            <div>
              {includeBearerPrefix ? (
                <Check className="h-3.5 w-3.5 text-foreground" />
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </div>
            <div>
              {sensitive ? (
                <Check className="h-3.5 w-3.5 text-foreground" />
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </div>
            <div className="min-w-0 line-clamp-2 text-muted-foreground">
              {description || <span className="italic">no description</span>}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="opacity-60 group-hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(index);
              }}
              aria-label="Remove header"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        );
      })}
    </div>
  );
}

function ValueCell({
  scope,
  value,
}: {
  scope: FieldScopeValue;
  value: string | undefined;
}) {
  const { singular } = usePresetEntityName();
  if (scope === "installation") {
    return <span className="text-muted-foreground">per-installation</span>;
  }
  if (scope === "preset") {
    return <span className="text-muted-foreground">per-{singular}</span>;
  }
  if (!value) {
    return <span className="text-muted-foreground italic">not set</span>;
  }
  return <span className="truncate font-mono">&quot;{value}&quot;</span>;
}
