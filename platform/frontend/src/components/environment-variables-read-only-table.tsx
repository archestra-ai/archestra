"use client";

import { parseVaultReference } from "@shared";
import { Check, KeyRound, Trash2 } from "lucide-react";
import type {
  FieldArrayWithId,
  FieldPath,
  FieldValues,
  UseFormWatch,
} from "react-hook-form";
import type { FieldScopeValue } from "@/components/field-scope-select";
import { Button } from "@/components/ui/button";
import { usePresetEntityName } from "@/lib/organization.query";

interface EnvironmentVariablesReadOnlyTableProps<
  TFieldValues extends FieldValues,
> {
  form: { watch: UseFormWatch<TFieldValues> };
  // biome-ignore lint/suspicious/noExplicitAny: field arrays require generic any
  fields: FieldArrayWithId<TFieldValues, any, "id">[];
  rowIndexes: number[];
  fieldNamePrefix: string;
  useExternalSecretsManager?: boolean;
  secretKeysWithStoredValue?: Set<string>;
  showType?: boolean;
  keyLabel?: string;
  removeAriaLabel?: string;
  onEdit: (index: number) => void;
  onDelete: (index: number) => void;
}

const TYPE_LABEL: Record<string, string> = {
  plain_text: "Plain text",
  secret: "Secret",
  boolean: "Boolean",
  number: "Number",
};

const GRID_WITH_TYPE =
  "grid grid-cols-[1.4fr_0.8fr_0.6fr_2fr_2.5fr_auto] gap-3 px-4";
const GRID_WITHOUT_TYPE =
  "grid grid-cols-[1.4fr_0.6fr_2fr_2.5fr_auto] gap-3 px-4";

export function EnvironmentVariablesReadOnlyTable<
  TFieldValues extends FieldValues,
>({
  form,
  fields,
  rowIndexes,
  fieldNamePrefix,
  useExternalSecretsManager = false,
  secretKeysWithStoredValue,
  showType = true,
  keyLabel = "Key",
  removeAriaLabel = "Remove variable",
  onEdit,
  onDelete,
}: EnvironmentVariablesReadOnlyTableProps<TFieldValues>) {
  const gridClass = showType ? GRID_WITH_TYPE : GRID_WITHOUT_TYPE;
  return (
    <div>
      <div
        className={`${gridClass} border-b py-2.5 text-xs font-medium text-foreground`}
      >
        <div>{keyLabel}</div>
        {showType && <div>Type</div>}
        <div>Required</div>
        <div>Value</div>
        <div>Description</div>
        <div className="w-9" />
      </div>
      {rowIndexes.map((index) => {
        const field = fields[index];
        const key = form.watch(
          `${fieldNamePrefix}.${index}.key` as FieldPath<TFieldValues>,
        ) as string | undefined;
        const type = (form.watch(
          `${fieldNamePrefix}.${index}.type` as FieldPath<TFieldValues>,
        ) ?? "plain_text") as string;
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
        const description = form.watch(
          `${fieldNamePrefix}.${index}.description` as FieldPath<TFieldValues>,
        ) as string | undefined;
        const hasStoredSecret =
          type === "secret" &&
          !!key &&
          secretKeysWithStoredValue?.has(key) === true;

        return (
          // biome-ignore lint/a11y/useSemanticElements: row contains a nested delete <button>, so <button> wrapper is invalid HTML
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
            className={`${gridClass} group items-center border-b py-3 text-xs last:border-b-0 cursor-pointer hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
          >
            <div className="min-w-0 truncate font-mono">
              {key || (
                <span className="text-muted-foreground italic">unnamed</span>
              )}
            </div>
            {showType && (
              <div className="text-muted-foreground">
                {TYPE_LABEL[type] ?? type}
              </div>
            )}
            <div>
              {scope === "installation" && required ? (
                <Check className="h-3.5 w-3.5 text-foreground" />
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </div>
            <div className="min-w-0 truncate">
              <ValueCell
                scope={scope}
                type={type}
                value={value}
                hasStoredSecret={hasStoredSecret}
                useExternalSecretsManager={useExternalSecretsManager}
              />
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
              aria-label={removeAriaLabel}
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
  type,
  value,
  hasStoredSecret,
  useExternalSecretsManager,
}: {
  scope: FieldScopeValue;
  type: string;
  value: string | undefined;
  hasStoredSecret: boolean;
  useExternalSecretsManager: boolean;
}) {
  const { singular } = usePresetEntityName();
  if (scope === "installation") {
    return <span className="text-muted-foreground">per-installation</span>;
  }
  if (scope === "preset") {
    return <span className="text-muted-foreground">per-{singular}</span>;
  }

  if (useExternalSecretsManager && type === "secret" && value) {
    const parsed = parseVaultReference(value);
    if (parsed.key) {
      return (
        <span className="inline-flex items-center gap-1 font-mono text-green-600">
          <KeyRound className="h-3 w-3" />
          <span className="truncate">{parsed.key}</span>
        </span>
      );
    }
  }

  if (type === "secret") {
    return (
      <span className="font-mono">
        {value || hasStoredSecret ? (
          "••••••••"
        ) : (
          <span className="text-muted-foreground italic">not set</span>
        )}
      </span>
    );
  }

  if (type === "boolean") {
    return (
      <span className="font-mono">{value === "true" ? "true" : "false"}</span>
    );
  }

  if (!value) {
    return <span className="text-muted-foreground italic">not set</span>;
  }
  return <span className="truncate font-mono">&quot;{value}&quot;</span>;
}
