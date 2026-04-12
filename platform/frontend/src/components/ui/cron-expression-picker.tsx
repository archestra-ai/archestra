"use client";

import { Check, ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { formatCronSchedule } from "@/lib/utils/format-cron";

export type CronPresetOption = {
  label: string;
  value: string;
};

export const DEFAULT_CRON_PRESET_OPTIONS: CronPresetOption[] = [
  { label: "Every hour", value: "0 * * * *" },
  { label: "Every 6 hours", value: "0 */6 * * *" },
  { label: "Every 12 hours", value: "0 */12 * * *" },
  { label: "Daily", value: "0 0 * * *" },
  { label: "Weekly", value: "0 0 * * 0" },
];

export function CronExpressionPicker({
  value,
  onChange,
  presets = DEFAULT_CRON_PRESET_OPTIONS,
  selectPlaceholder = "Select a schedule",
  customPlaceholder = "0 */6 * * *",
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  presets?: CronPresetOption[];
  selectPlaceholder?: string;
  customPlaceholder?: string;
  /** @deprecated No longer rendered. Kept for backward compatibility. */
  descriptionFallback?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [customDraft, setCustomDraft] = useState("");

  const presetValues = useMemo(
    () => new Set(presets.map((preset) => preset.value)),
    [presets],
  );

  const isCustom = !!value && !presetValues.has(value);

  const displayLabel = useMemo(() => {
    if (!value) return null;

    const preset = presets.find((p) => p.value === value);
    if (preset) return preset.label;

    const humanReadable = formatCronSchedule(value);
    return humanReadable !== value ? humanReadable : value;
  }, [presets, value]);

  const commitCustomValue = () => {
    const trimmed = customDraft.trim();
    if (trimmed) {
      onChange(trimmed);
      setOpen(false);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setCustomDraft(isCustom ? value : "");
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn(
            "border-input h-9 w-[200px] justify-between bg-transparent font-normal shadow-xs hover:bg-transparent hover:text-foreground",
            !value && "text-muted-foreground",
            className,
          )}
        >
          <span className="min-w-0 flex-1 truncate text-left">
            {displayLabel ?? selectPlaceholder}
          </span>
          <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] p-0"
        align="start"
      >
        <div
          className="max-h-[300px] overflow-y-auto p-1"
          onWheelCapture={(event) => event.stopPropagation()}
        >
          {presets.map((preset) => (
            <button
              type="button"
              key={preset.value}
              onClick={() => {
                onChange(preset.value);
                setOpen(false);
              }}
              className={cn(
                "relative flex w-full cursor-default select-none items-center justify-between rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground",
                value === preset.value && "bg-accent/50",
              )}
            >
              <span className="min-w-0 flex-1">
                {preset.label}
                <span className="block text-xs text-muted-foreground">
                  {formatCronSchedule(preset.value)}
                </span>
              </span>
              <Check
                className={cn(
                  "ml-2 h-4 w-4 shrink-0",
                  value === preset.value ? "opacity-100" : "opacity-0",
                )}
              />
            </button>
          ))}
        </div>

        <div className="border-t px-2 py-2">
          <p className="mb-1.5 px-1 text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60">
            Custom cron
          </p>
          <div className="flex items-center gap-1.5">
            <Input
              placeholder={customPlaceholder}
              value={customDraft}
              onChange={(event) => setCustomDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitCustomValue();
                }
              }}
              className="h-8 min-w-0 px-2 text-sm"
            />
            <Button
              variant="ghost"
              size="sm"
              className="h-8 shrink-0 px-2 text-xs"
              disabled={!customDraft.trim()}
              onClick={commitCustomValue}
            >
              Apply
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
