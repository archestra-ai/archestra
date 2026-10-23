"use client";

import { format } from "date-fns";
import { CalendarIcon, ChevronDown } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DateTimeCalendar } from "@/components/ui/date-time-calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/** Presets and a custom date share one control, without moving the form. */
export function ExpirySelect({
  id,
  value,
  onChange,
  disabledDate,
}: {
  id?: string;
  value: Date | null;
  onChange: (value: Date | null) => void;
  disabledDate?: (date: Date) => boolean;
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const preset =
    value && !custom
      ? EXPIRY_PRESETS.find(
          (p) =>
            Math.abs(value.getTime() - Date.now() - p.days * DAY_MS) <
            DAY_MS / 2,
        )
      : undefined;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          className="w-full min-w-0 justify-between font-normal"
          aria-label="Expires"
        >
          <span className="flex min-w-0 items-center gap-2">
            <CalendarIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">
              {!value
                ? "Never"
                : preset
                  ? `${preset.days} days`
                  : format(value, "MMM d, yyyy · HH:mm")}
            </span>
            {preset && value && (
              <span className="truncate text-muted-foreground">
                · {format(value, "MMM d, yyyy")}
              </span>
            )}
          </span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto p-0">
        <div className="flex items-center gap-1 border-b p-2">
          {EXPIRY_PRESETS.map((p) => (
            <Button
              key={p.days}
              type="button"
              size="xs"
              variant={preset?.days === p.days ? "secondary" : "ghost"}
              onClick={() => {
                setCustom(false);
                onChange(new Date(Date.now() + p.days * DAY_MS));
                setOpen(false);
              }}
            >
              <span>{p.days} days</span>
            </Button>
          ))}
          <Button
            type="button"
            size="xs"
            variant={!value ? "secondary" : "ghost"}
            onClick={() => {
              setCustom(false);
              onChange(null);
              setOpen(false);
            }}
          >
            <span>Never</span>
          </Button>
        </div>
        <DateTimeCalendar
          day={value ?? undefined}
          time={
            value
              ? [value.getHours(), value.getMinutes()]
              : [new Date().getHours(), 0]
          }
          disabledDate={
            disabledDate ??
            ((date) => date < new Date(new Date().toDateString()))
          }
          onChange={(date) => {
            setCustom(true);
            onChange(date);
          }}
          onDone={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRY_PRESETS = [{ days: 7 }, { days: 30 }, { days: 90 }] as const;
