"use client";

import { CalendarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CustomDateTimeRangeDialog } from "@/components/ui/custom-date-time-range-dialog";
import { cn } from "@/lib/utils";

export interface DateTimeRangePickerProps {
  startDate: Date | undefined;
  endDate: Date | undefined;
  isDialogOpen: boolean;
  tempStartDate: Date | undefined;
  tempEndDate: Date | undefined;
  displayText: string | null;
  onDialogOpenChange: (open: boolean) => void;
  onTempStartDateChange: (date: Date | undefined) => void;
  onTempEndDateChange: (date: Date | undefined) => void;
  onOpenDialog: () => void;
  onApply: () => void;
  /** Trigger styling — filter bars pass `filterControlClass()`. */
  className?: string;
}

export function DateTimeRangePicker({
  startDate,
  endDate,
  isDialogOpen,
  tempStartDate,
  tempEndDate,
  displayText,
  onDialogOpenChange,
  onTempStartDateChange,
  onTempEndDateChange,
  onOpenDialog,
  onApply,
  className,
}: DateTimeRangePickerProps) {
  return (
    <>
      <Button
        variant="outline"
        onClick={onOpenDialog}
        className={cn("justify-start text-left font-normal", className)}
      >
        <CalendarIcon className="h-4 w-4 shrink-0" />
        <span className="truncate">{displayText || "Date range"}</span>
      </Button>

      <CustomDateTimeRangeDialog
        open={isDialogOpen}
        onOpenChange={onDialogOpenChange}
        startDate={tempStartDate ?? startDate}
        endDate={tempEndDate ?? endDate}
        onStartDateChange={onTempStartDateChange}
        onEndDateChange={onTempEndDateChange}
        onApply={onApply}
        title="Custom timeframe"
        description="Set a custom time period for the logs view."
      />
    </>
  );
}
