"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils/tailwind";

/**
 * The one GitHub organization input every GitHub App setup asks for: a name
 * on github.com, or the organization's address on any GitHub host. The
 * backend parses it; its message about the input replaces the help line.
 */
export function GithubOrganizationField({
  id,
  value,
  onChange,
  error,
  label = "GitHub organization",
  help = "Organization's GitHub handle or URL",
  disabled = false,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  error: string | null;
  label?: string;
  help?: string;
  /** Shown but fixed, e.g. reconnecting a plan whose organization is set. */
  disabled?: boolean;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        placeholder="acme or https://github.com/acme"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="off"
        data-1p-ignore
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-help`}
      />
      {/* One line under the field: the error takes the help text's place, so
          the dialog does not grow or jump when an error appears or clears. */}
      <p
        id={`${id}-help`}
        className={cn(
          "min-h-4 text-xs",
          error ? "text-destructive" : "text-muted-foreground",
        )}
        role={error ? "alert" : undefined}
      >
        {error ?? help}
      </p>
    </div>
  );
}
