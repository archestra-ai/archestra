"use client";

import { useMemo } from "react";
import { SearchableSelect } from "@/components/ui/searchable-select";

/** The viewer's IANA timezone, falling back to UTC. */
export function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function supportedTimezones(): string[] {
  // Intl.supportedValuesOf is widely available but not yet in the TS lib types.
  const fn = (
    Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
  ).supportedValuesOf;
  try {
    return fn?.("timeZone") ?? [];
  } catch {
    return [];
  }
}

/**
 * Searchable IANA timezone dropdown. Reuses the shared {@link SearchableSelect}
 * rather than introducing another combobox. Callers default `value` to
 * {@link browserTimezone}.
 */
export function TimezonePicker({
  value,
  onValueChange,
  className,
  disabled,
}: {
  value: string;
  onValueChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
}) {
  const items = useMemo(() => {
    const zones = supportedTimezones();
    const list = zones.length > 0 ? zones : [browserTimezone()];
    // Keep a non-standard stored value selectable instead of silently dropping it.
    const withValue = value && !list.includes(value) ? [value, ...list] : list;
    return withValue.map((zone) => ({ value: zone, label: zone }));
  }, [value]);

  return (
    <SearchableSelect
      value={value}
      onValueChange={onValueChange}
      items={items}
      placeholder="Select timezone"
      searchPlaceholder="Search timezones..."
      className={className}
      disabled={disabled}
    />
  );
}
