"use client";

import { useState } from "react";
import { DateTimePicker } from "@/components/ui/date-time-picker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Presets for the usual choices; a date picker only for a custom date. */
export function ExpirySelect({
  id,
  value,
  onChange,
}: {
  id?: string;
  value: Date | null;
  onChange: (value: Date | null) => void;
}) {
  const [custom, setCustom] = useState(false);
  const preset = value
    ? EXPIRY_PRESETS.find(
        (p) =>
          Math.abs(value.getTime() - Date.now() - p.days * DAY_MS) < DAY_MS / 2,
      )
    : null;
  const selected = !value
    ? "never"
    : !custom && preset
      ? preset.value
      : "custom";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={selected}
        onValueChange={(next) => {
          if (next === "never") {
            setCustom(false);
            onChange(null);
          } else if (next === "custom") {
            setCustom(true);
            onChange(value ?? new Date(Date.now() + 30 * DAY_MS));
          } else {
            setCustom(false);
            const days =
              EXPIRY_PRESETS.find((p) => p.value === next)?.days ?? 30;
            onChange(new Date(Date.now() + days * DAY_MS));
          }
        }}
      >
        <SelectTrigger id={id} aria-label="Expires" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {EXPIRY_PRESETS.map((p) => (
            <SelectItem key={p.value} value={p.value}>
              {p.label}
            </SelectItem>
          ))}
          <SelectItem value="never">Never</SelectItem>
          <SelectItem value="custom">Custom date…</SelectItem>
        </SelectContent>
      </Select>
      {selected === "custom" && (
        <DateTimePicker
          value={value ?? undefined}
          onChange={(date) => onChange(date ?? null)}
          disabledDate={(date) => date < new Date(new Date().toDateString())}
          className="flex-1"
        />
      )}
    </div>
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRY_PRESETS = [
  { value: "7", label: "In 7 days", days: 7 },
  { value: "30", label: "In 30 days", days: 30 },
  { value: "90", label: "In 90 days", days: 90 },
] as const;
