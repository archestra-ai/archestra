"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CatalogFieldEntry } from "./preset-helpers";

interface PresetFieldInputProps {
  field: CatalogFieldEntry;
  /** String-encoded value. Booleans use "true"/"false". */
  value: string;
  onChange: (v: string) => void;
  idPrefix: string;
  disabled?: boolean;
  /** When true and field.secret, render `••••••••` placeholder. Leaving the input empty preserves the stored secret; typing replaces it. */
  hasStoredSecret?: boolean;
  /** Inline validation error to render under the input (e.g. preset regex mismatch). */
  error?: string | null;
}

/**
 * Renders a single preset field input matching the install form's
 * per-field treatment: boolean → checkbox, number → number input,
 * secret/sensitive → password input, otherwise text input.
 *
 * BYOS vault selection is intentionally not supported here — preset values
 * are stored as plain JSONB on the catalog row.
 */
export function PresetFieldInput({
  field,
  value,
  onChange,
  idPrefix,
  disabled,
  hasStoredSecret,
  error,
}: PresetFieldInputProps) {
  const id = `${idPrefix}-${field.origin}-${field.key}`;
  const label = field.title || field.key;

  if (field.valueType === "boolean") {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Checkbox
            id={id}
            checked={value === "true"}
            onCheckedChange={(checked) => onChange(checked ? "true" : "false")}
            disabled={disabled}
          />
          <Label htmlFor={id} className="cursor-pointer">
            {label}
            {field.required && <span className="text-destructive ml-1">*</span>}
          </Label>
        </div>
        {field.description && (
          <p className="text-xs text-muted-foreground">{field.description}</p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>
        {label}
        {field.required && <span className="text-destructive ml-1">*</span>}
      </Label>
      {field.description && (
        <p className="text-xs text-muted-foreground">{field.description}</p>
      )}
      <Input
        id={id}
        type={
          field.valueType === "number"
            ? "number"
            : field.secret
              ? "password"
              : "text"
        }
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={
          field.secret && hasStoredSecret
            ? "••••••••"
            : `Enter value for ${field.key}`
        }
        className="font-mono"
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        // Suppress browser/password-manager autofill. For type="password"
        // fields specifically, "new-password" is the standard hint that
        // tells Chrome/Safari/Firefox not to attempt credential fill —
        // these are catalog secrets (DB passwords, API tokens), NOT login
        // credentials, so password-manager interference would surface a
        // saved Archestra login here instead of the actual stored value.
        autoComplete={field.secret ? "new-password" : "off"}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
