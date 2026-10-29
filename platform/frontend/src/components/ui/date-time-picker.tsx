"use client";

import { format } from "date-fns";
import { CalendarIcon } from "lucide-react";
import * as React from "react";
import { parseTimeExpression } from "@/components/time-range-picker/time-range";
import { Button } from "@/components/ui/button";
import { DateTimeCalendar } from "@/components/ui/date-time-calendar";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils/tailwind";

interface DateTimePickerProps {
  value: Date | undefined;
  onChange: (date: Date | undefined) => void;
  /** Disable specific dates in the calendar (e.g. past dates) */
  disabledDate?: (date: Date) => boolean;
  placeholder?: string;
  className?: string;
  /** Id of the text field, for a `<Label htmlFor>`. */
  id?: string;
}

/**
 * A date and time you can type ("2026-10-13 14:30", or "now-6h") or pick from
 * the calendar. Typed text is applied on Enter or when the field loses focus;
 * text that names no date stays in the field, marked invalid, until fixed.
 */
function DateTimePicker({
  value,
  onChange,
  disabledDate,
  placeholder = "Pick date and time",
  className,
  id,
}: DateTimePickerProps) {
  const [isOpen, setIsOpen] = React.useState(false);
  const [text, setText] = React.useState(() => formatValue(value));
  const [invalid, setInvalid] = React.useState(false);
  const valueTime = value?.getTime();

  // A value set from outside (the calendar, a preset, a reset) replaces
  // whatever is typed.
  React.useEffect(() => {
    setText(
      formatValue(valueTime === undefined ? undefined : new Date(valueTime)),
    );
    setInvalid(false);
  }, [valueTime]);

  const commitText = () => {
    const trimmed = text.trim();
    if (!trimmed) {
      setInvalid(false);
      if (value) onChange(undefined);
      return;
    }
    const parsed = parseTimeExpression(trimmed, new Date());
    if (!parsed || disabledDate?.(parsed)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (parsed.getTime() !== valueTime) onChange(parsed);
    else setText(formatValue(parsed));
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      {/* The calendar opens under the whole field, not just its icon. */}
      <PopoverAnchor className={cn("relative", className)}>
        <Input
          id={id}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setInvalid(false);
          }}
          onBlur={commitText}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            // Enter applies the typed text; it must not also submit the form
            // around the field with the previous value.
            event.preventDefault();
            commitText();
          }}
          placeholder={TEXT_FORMAT_HINT}
          aria-label={placeholder}
          aria-invalid={invalid || undefined}
          spellCheck={false}
          autoComplete="off"
          className="pr-9 font-mono text-sm tabular-nums"
        />
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Open calendar: ${placeholder}`}
            className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground"
          >
            <CalendarIcon className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
      </PopoverAnchor>
      <PopoverContent className="w-auto p-0" align="start">
        <DateTimeCalendar
          day={value}
          // Without a value yet, a picked day lands on the current hour.
          time={
            value
              ? [value.getHours(), value.getMinutes()]
              : [new Date().getHours(), 0]
          }
          disabledDate={disabledDate}
          onChange={onChange}
          onDone={() => setIsOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

function formatValue(value: Date | undefined) {
  return value ? format(value, TEXT_FORMAT) : "";
}

const TEXT_FORMAT = "yyyy-MM-dd HH:mm";
const TEXT_FORMAT_HINT = "YYYY-MM-DD HH:mm";

export { DateTimePicker };
