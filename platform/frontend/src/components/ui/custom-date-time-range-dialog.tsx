"use client";

import { StandardFormDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { DateTimePicker } from "@/components/ui/date-time-picker";
import { Label } from "@/components/ui/label";

interface CustomDateTimeRangeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  startDate: Date | undefined;
  endDate: Date | undefined;
  onStartDateChange: (date: Date | undefined) => void;
  onEndDateChange: (date: Date | undefined) => void;
  onApply: () => void;
  title?: string;
  description?: string;
  applyLabel?: string;
}

export function CustomDateTimeRangeDialog({
  open,
  onOpenChange,
  startDate,
  endDate,
  onStartDateChange,
  onEndDateChange,
  onApply,
  title = "Custom timeframe",
  description = "Set a custom time period.",
  applyLabel = "Apply",
}: CustomDateTimeRangeDialogProps) {
  return (
    <StandardFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      size="small"
      onSubmit={() => onApply()}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={!startDate || !endDate}>
            {applyLabel}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label className="text-sm font-medium">From</Label>
          <DateTimePicker
            value={startDate}
            onChange={onStartDateChange}
            placeholder="Start date & time"
            className="w-full"
          />
        </div>
        <div className="space-y-2">
          <Label className="text-sm font-medium">To</Label>
          <DateTimePicker
            value={endDate}
            onChange={onEndDateChange}
            placeholder="End date & time"
            className="w-full"
          />
        </div>
      </div>
    </StandardFormDialog>
  );
}
