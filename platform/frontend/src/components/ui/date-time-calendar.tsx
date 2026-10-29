"use client";

import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";

/**
 * A month calendar with a time field under it, for popovers that pick one
 * moment. Picking a day keeps the time; changing the time keeps the day (today
 * when none is picked yet). The popover stays open for both, and Done closes
 * it.
 */
export function DateTimeCalendar({
  day,
  time,
  onChange,
  onDone,
  disabledDate,
}: {
  /** The picked day, if any; only its date is read. */
  day: Date | undefined;
  /** Hour and minute shown in the time field and given to a picked day. */
  time: [number, number];
  onChange: (date: Date) => void;
  onDone: () => void;
  /** Days that cannot be picked (e.g. past or future ones). */
  disabledDate?: (date: Date) => boolean;
}) {
  const timeId = useId();
  const commit = (base: Date, [hours, minutes]: [number, number]) => {
    const next = new Date(base);
    next.setHours(hours, minutes, 0, 0);
    onChange(next);
  };
  return (
    <div>
      <Calendar
        mode="single"
        selected={day}
        defaultMonth={day ?? new Date()}
        disabled={disabledDate}
        onSelect={(picked) => {
          if (picked) commit(picked, time);
        }}
      />
      <div className="flex items-center gap-2 border-t px-3 py-2.5">
        <label htmlFor={timeId} className="text-xs text-muted-foreground">
          Time
        </label>
        <Input
          id={timeId}
          type="time"
          value={`${pad(time[0])}:${pad(time[1])}`}
          onChange={(event) => {
            const [hours, minutes] = event.target.value.split(":").map(Number);
            if (Number.isNaN(hours) || Number.isNaN(minutes)) return;
            commit(day ?? new Date(), [hours, minutes]);
          }}
          className="h-8 w-28 font-mono text-sm"
        />
        <Button type="button" size="sm" className="ml-auto" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}
