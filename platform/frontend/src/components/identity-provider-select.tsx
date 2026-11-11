// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import type { ComponentProps } from "react";
import { IdentityProviderIcon } from "@/components/identity-provider-icons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils/tailwind";

/**
 * Picks one of the organization's identity providers, each shown with its
 * brand icon and issuer. Extra props (an `id`, the `aria-*` a form field
 * passes down) go to the trigger, so it works inside a `FormControl`.
 */
export function IdentityProviderSelect({
  identityProviders,
  value,
  onChange,
  noneLabel,
  placeholder = "Select an identity provider",
  disabled,
  className,
  ...triggerProps
}: {
  identityProviders: ReadonlyArray<IdentityProviderOption>;
  value: string | null;
  onChange: (value: string | null) => void;
  /** Adds an option that clears the selection, labelled with this text. */
  noneLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
} & Omit<
  ComponentProps<typeof SelectTrigger>,
  "value" | "onChange" | "children"
>) {
  const selected = identityProviders.find((provider) => provider.id === value);
  const selectValue = value ?? (noneLabel ? NONE_VALUE : "");

  return (
    <Select
      value={selectValue}
      disabled={disabled}
      onValueChange={(next) => onChange(next === NONE_VALUE ? null : next)}
    >
      <SelectTrigger
        className={cn("w-full min-w-0", className)}
        {...triggerProps}
      >
        <SelectValue placeholder={placeholder}>
          {selected ? (
            <span className="flex min-w-0 items-center gap-2">
              <IdentityProviderIcon
                providerId={selected.providerId}
                className="shrink-0"
              />
              <span className="shrink-0">{selected.providerId}</span>
              <span className="truncate text-muted-foreground">
                {selected.issuer}
              </span>
            </span>
          ) : selectValue === NONE_VALUE ? (
            noneLabel
          ) : null}
        </SelectValue>
      </SelectTrigger>
      <SelectContent
        position="popper"
        className="max-w-[var(--radix-select-trigger-width)]"
      >
        {noneLabel && <SelectItem value={NONE_VALUE}>{noneLabel}</SelectItem>}
        {identityProviders.map((provider) => (
          <SelectItem
            key={provider.id}
            value={provider.id}
            icon={
              <IdentityProviderIcon
                providerId={provider.providerId}
                className="mt-0.5 shrink-0 self-start"
              />
            }
            description={<span className="break-all">{provider.issuer}</span>}
            className="items-start [&>div]:min-w-0"
          >
            {provider.providerId}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ===

type IdentityProviderOption = {
  id: string;
  providerId: string;
  issuer: string;
};

/** Radix Select cannot hold an empty-string value, so "none" needs a sentinel. */
const NONE_VALUE = "__none__";
