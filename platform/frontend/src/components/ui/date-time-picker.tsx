"use client";

import { format } from "date-fns";
import { CalendarIcon } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface DateTimePickerProps {
  value: Date | undefined;
  onChange: (date: Date | undefined) => void;
  /** Disable specific dates in the calendar (e.g. past dates) */
  disabledDate?: (date: Date) => boolean;
  placeholder?: string;
  className?: string;
}

function DateTimePicker({
  value,
  onChange,
  disabledDate,
  placeholder = "Pick date and time",
  className,
}: DateTimePickerProps) {
  const [isOpen, setIsOpen] = React.useState(false);

  const handleDateSelect = (selectedDate: Date | undefined) => {
    if (!selectedDate) return;
    const newDate = new Date(selectedDate);
    if (value) {
      newDate.setHours(value.getHours(), value.getMinutes());
    }
    onChange(newDate);
  };

  const handleTimeChange = (type: "hour" | "minute", val: string) => {
    const current =
      value ??
      (() => {
        const d = new Date();
        d.setMinutes(0, 0, 0);
        return d;
      })();
    const newDate = new Date(current);
    if (type === "hour") {
      newDate.setHours(Number.parseInt(val, 10));
    } else if (type === "minute") {
      newDate.setMinutes(Number.parseInt(val, 10));
    }
    onChange(newDate);
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn(
            "justify-start text-left font-normal",
            !value && "text-muted-foreground",
            className,
          )}
        >
          <CalendarIcon className="mr-2 h-4 w-4" />
          {value ? format(value, "MM/dd/yyyy HH:mm") : placeholder}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <div className="sm:flex">
          <Calendar
            mode="single"
            selected={value}
            defaultMonth={value ?? new Date()}
            onSelect={handleDateSelect}
            disabled={disabledDate}
          />
          <div className="flex flex-col sm:flex-row divide-y sm:divide-y-0 sm:divide-x">
            <div
              className="max-h-[300px] overflow-y-auto p-2"
              onWheel={handleContainerScroll}
            >
              <div className="flex sm:flex-col">
                {HOURS.map((hour) => (
                  <Button
                    key={hour}
                    size="icon"
                    variant={
                      value && value.getHours() === hour ? "default" : "ghost"
                    }
                    className="sm:w-full shrink-0 aspect-square"
                    onClick={() => handleTimeChange("hour", hour.toString())}
                  >
                    {hour.toString().padStart(2, "0")}
                  </Button>
                ))}
              </div>
            </div>
            <div
              className="max-h-[300px] overflow-y-auto p-2"
              onWheel={handleContainerScroll}
            >
              <div className="flex sm:flex-col">
                {MINUTES.map((minute) => (
                  <Button
                    key={minute}
                    size="icon"
                    variant={
                      value && value.getMinutes() === minute
                        ? "default"
                        : "ghost"
                    }
                    className="sm:w-full shrink-0 aspect-square"
                    onClick={() =>
                      handleTimeChange("minute", minute.toString())
                    }
                  >
                    {minute.toString().padStart(2, "0")}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Manually scroll the container on wheel events.
 * Radix Dialog's scroll lock blocks native wheel scrolling on portaled
 * Popover content, so we handle it ourselves.
 */
function handleContainerScroll(e: React.WheelEvent<HTMLDivElement>) {
  e.currentTarget.scrollTop += e.deltaY;
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5);

export { DateTimePicker };
