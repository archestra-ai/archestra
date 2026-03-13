"use client";

import { LABELS_ENTRY_DELIMITER, LABELS_VALUE_DELIMITER } from "@shared";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface LabelSelectProps {
  labelKeys: string[] | undefined;
  LabelKeyRowComponent: React.ComponentType<{
    labelKey: string;
    selectedValues: string[];
    onToggleValue: (key: string, value: string) => void;
  }>;
}

export function LabelSelect({
  labelKeys,
  LabelKeyRowComponent,
}: LabelSelectProps) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [keySearch, setKeySearch] = useState("");

  const labelsParam = searchParams.get("labels");
  const parsed = useMemo(() => parseLabelsParam(labelsParam), [labelsParam]);

  const totalSelected = useMemo(() => {
    if (!parsed) return 0;
    return Object.values(parsed).reduce((sum, vals) => sum + vals.length, 0);
  }, [parsed]);

  const filteredKeys = useMemo(() => {
    if (!labelKeys) return [];
    if (!keySearch) return labelKeys;
    const q = keySearch.toLowerCase();
    return labelKeys.filter((k) => k.toLowerCase().includes(q));
  }, [labelKeys, keySearch]);

  const updateLabels = useCallback(
    (updated: Record<string, string[]>) => {
      const params = new URLSearchParams(searchParams.toString());
      const serialized = serializeLabels(updated);
      if (serialized) {
        params.set("labels", serialized);
      } else {
        params.delete("labels");
      }
      if (params.has("page")) {
        params.set("page", "1");
      }
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  const handleToggleValue = useCallback(
    (key: string, value: string) => {
      const current = parsed ?? {};
      const currentValues = current[key] ?? [];
      const updated = { ...current };
      if (currentValues.includes(value)) {
        updated[key] = currentValues.filter((v) => v !== value);
        if (updated[key].length === 0) delete updated[key];
      } else {
        updated[key] = [...currentValues, value];
      }
      updateLabels(updated);
    },
    [parsed, updateLabels],
  );

  if (!labelKeys || labelKeys.length === 0) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn(
            "w-[180px] justify-between font-normal",
            !totalSelected && "text-muted-foreground",
          )}
        >
          <span className="truncate">
            {totalSelected > 0
              ? `${totalSelected} ${totalSelected === 1 ? "label" : "labels"} selected`
              : "Labels"}
          </span>
          <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[260px] p-0" align="start">
        <div className="flex items-center border-b px-3 py-2">
          <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
          <input
            placeholder="Search keys..."
            value={keySearch}
            onChange={(e) => setKeySearch(e.target.value)}
            className="flex w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="max-h-[350px] overflow-y-auto p-1">
          {filteredKeys.map((key) => (
            <LabelKeyRowComponent
              key={key}
              labelKey={key}
              selectedValues={parsed?.[key] ?? []}
              onToggleValue={handleToggleValue}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function LabelKeyRowBase({
  labelKey,
  selectedValues,
  onToggleValue,
  values,
  onOpenChange,
}: {
  labelKey: string;
  selectedValues: string[];
  onToggleValue: (key: string, value: string) => void;
  values: string[] | undefined;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);

  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      setOpen(newOpen);
      onOpenChange?.(newOpen);
    },
    [onOpenChange],
  );
  const [search, setSearch] = useState("");

  const filteredValues = useMemo(() => {
    if (!values) return [];
    if (!search) return values;
    const q = search.toLowerCase();
    return values.filter((v) => v.toLowerCase().includes(q));
  }, [values, search]);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "relative flex w-full cursor-default select-none items-center justify-between rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground",
            selectedValues.length > 0 && "bg-accent/50",
          )}
        >
          <span className="truncate">{labelKey}</span>
          {selectedValues.length > 0 && (
            <Badge variant="secondary" className="ml-2 h-5 px-1.5 text-xs">
              {selectedValues.length}
            </Badge>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[220px] p-0"
        side="right"
        align="start"
        sideOffset={4}
      >
        <div className="flex items-center border-b px-3 py-2">
          <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
          <input
            placeholder="Search values..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="max-h-[250px] overflow-y-auto p-1">
          {filteredValues.length === 0 ? (
            <div className="py-4 text-center text-sm text-muted-foreground">
              {values ? "No results found." : "Loading..."}
            </div>
          ) : (
            filteredValues.map((value) => {
              const isSelected = selectedValues.includes(value);
              return (
                <button
                  type="button"
                  key={value}
                  onClick={() => onToggleValue(labelKey, value)}
                  className={cn(
                    "relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground",
                    isSelected && "bg-accent text-accent-foreground",
                  )}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      isSelected ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="truncate">{value}</span>
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function LabelFilterBadges({
  onRemoveLabel,
}: {
  onRemoveLabel: (key: string, value: string) => void;
}) {
  const searchParams = useSearchParams();
  const labelsParam = searchParams.get("labels");
  const parsedLabels = useMemo(
    () => parseLabelsParam(labelsParam),
    [labelsParam],
  );

  if (!parsedLabels || Object.keys(parsedLabels).length === 0) return null;

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-xs text-muted-foreground">Labels</span>
      {Object.entries(parsedLabels).map(([key, values]) =>
        values.map((value) => (
          <Badge
            key={`${key}:${value}`}
            variant="secondary"
            className="gap-1 pr-1"
          >
            {key}: {value}
            <button
              type="button"
              onClick={() => onRemoveLabel(key, value)}
              className="ml-0.5 rounded-full hover:bg-muted-foreground/20 p-0.5"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        )),
      )}
    </div>
  );
}

export function parseLabelsParam(
  labels: string | null,
): Record<string, string[]> | null {
  if (!labels) return null;
  const result: Record<string, string[]> = {};
  for (const entry of labels.split(LABELS_ENTRY_DELIMITER)) {
    const colonIdx = entry.indexOf(":");
    if (colonIdx === -1) continue;
    const key = entry.slice(0, colonIdx).trim();
    const values = entry
      .slice(colonIdx + 1)
      .split(LABELS_VALUE_DELIMITER)
      .map((v) => v.trim())
      .filter(Boolean);
    if (key && values.length > 0) {
      result[key] = values;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

export function serializeLabels(
  labels: Record<string, string[]>,
): string | null {
  const entries = Object.entries(labels).filter(
    ([, values]) => values.length > 0,
  );
  if (entries.length === 0) return null;
  return entries
    .map(([key, values]) => `${key}:${values.join(LABELS_VALUE_DELIMITER)}`)
    .join(LABELS_ENTRY_DELIMITER);
}
