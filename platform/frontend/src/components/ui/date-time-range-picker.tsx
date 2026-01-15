"use client";

import { CalendarIcon } from "lucide-react";
import type { DateRange } from "react-day-picker";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export interface DateTimeRangePickerProps {
  dateRange: DateRange | undefined;
  isDialogOpen: boolean;
  tempDateRange: DateRange | undefined;
  fromTime: string;
  toTime: string;
  displayText: string | null;
  onDialogOpenChange: (open: boolean) => void;
  onTempDateRangeChange: (range: DateRange | undefined) => void;
  onFromTimeChange: (time: string) => void;
  onToTimeChange: (time: string) => void;
  onOpenDialog: () => void;
  onApply: () => void;
  /** Optional ID prefix for input elements to avoid conflicts when multiple pickers exist */
  idPrefix?: string;
}

/**
 * A reusable date-time range picker component with a button trigger and dialog.
 * Includes a dual-month calendar for date selection and time inputs for precise filtering.
 */
export function DateTimeRangePicker({
  dateRange,
  isDialogOpen,
  tempDateRange,
  fromTime,
  toTime,
  displayText,
  onDialogOpenChange,
  onTempDateRangeChange,
  onFromTimeChange,
  onToTimeChange,
  onOpenDialog,
  onApply,
  idPrefix = "",
}: DateTimeRangePickerProps) {
  const fromTimeId = `${idPrefix}from-time`;
  const toTimeId = `${idPrefix}to-time`;

  return (
    <>
      <Button
        variant="outline"
        onClick={onOpenDialog}
        className={cn(
          "justify-start text-left font-normal",
          !dateRange && "text-muted-foreground",
        )}
      >
        <CalendarIcon className="mr-2 h-4 w-4 shrink-0" />
        {displayText || <span>Pick a date range</span>}
      </Button>

      <Dialog open={isDialogOpen} onOpenChange={onDialogOpenChange}>
        <DialogContent className="sm:max-w-[800px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Select Date and Time Range</DialogTitle>
            <DialogDescription>
              Choose a date range and optionally specify start and end times
              (UTC).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-6 py-4">
            <div className="space-y-3">
              <Label className="text-sm font-medium">Date Range</Label>
              <div className="flex justify-center">
                <Calendar
                  mode="range"
                  defaultMonth={tempDateRange?.from ?? new Date()}
                  selected={tempDateRange}
                  onSelect={onTempDateRangeChange}
                  numberOfMonths={2}
                  className="rounded-md border"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor={fromTimeId} className="text-sm font-medium">
                  From Time (UTC)
                </Label>
                <Input
                  id={fromTimeId}
                  type="time"
                  value={fromTime}
                  onChange={(e) => onFromTimeChange(e.target.value)}
                  className="w-full"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={toTimeId} className="text-sm font-medium">
                  To Time (UTC)
                </Label>
                <Input
                  id={toTimeId}
                  type="time"
                  value={toTime}
                  onChange={(e) => onToTimeChange(e.target.value)}
                  className="w-full"
                />
              </div>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => onDialogOpenChange(false)}>
              Cancel
            </Button>
            <Button
              onClick={onApply}
              disabled={!tempDateRange?.from || !tempDateRange?.to}
            >
              Apply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
