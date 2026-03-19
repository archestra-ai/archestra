"use client";

import { format } from "date-fns";
import { useCallback, useState } from "react";

export interface UseDateTimeRangePickerOptions {
  startDateFromUrl: string | null;
  endDateFromUrl: string | null;
  onDateRangeChange: (params: {
    startDate: string | null;
    endDate: string | null;
  }) => void;
}

export interface UseDateTimeRangePickerReturn {
  startDate: Date | undefined;
  endDate: Date | undefined;
  isDateDialogOpen: boolean;
  tempStartDate: Date | undefined;
  tempEndDate: Date | undefined;
  setIsDateDialogOpen: (open: boolean) => void;
  setTempStartDate: (date: Date | undefined) => void;
  setTempEndDate: (date: Date | undefined) => void;
  openDateDialog: () => void;
  handleApplyDateRange: () => void;
  clearDateRange: () => void;
  getDateRangeDisplay: () => string | null;
  startDateParam: string | undefined;
  endDateParam: string | undefined;
}

export function useDateTimeRangePicker({
  startDateFromUrl,
  endDateFromUrl,
  onDateRangeChange,
}: UseDateTimeRangePickerOptions): UseDateTimeRangePickerReturn {
  const [startDate, setStartDate] = useState<Date | undefined>(() =>
    startDateFromUrl ? new Date(startDateFromUrl) : undefined,
  );
  const [endDate, setEndDate] = useState<Date | undefined>(() =>
    endDateFromUrl ? new Date(endDateFromUrl) : undefined,
  );
  const [isDateDialogOpen, setIsDateDialogOpen] = useState(false);
  const [tempStartDate, setTempStartDate] = useState<Date | undefined>(
    startDate,
  );
  const [tempEndDate, setTempEndDate] = useState<Date | undefined>(endDate);

  const openDateDialog = useCallback(() => {
    setTempStartDate(startDate);
    setTempEndDate(endDate);
    setIsDateDialogOpen(true);
  }, [startDate, endDate]);

  const handleApplyDateRange = useCallback(() => {
    if (!tempStartDate || !tempEndDate) {
      return;
    }

    const nextStartDate = new Date(tempStartDate);
    const nextEndDate = new Date(tempEndDate);
    nextEndDate.setSeconds(59, 999);

    setStartDate(nextStartDate);
    setEndDate(nextEndDate);
    onDateRangeChange({
      startDate: nextStartDate.toISOString(),
      endDate: nextEndDate.toISOString(),
    });
    setIsDateDialogOpen(false);
  }, [tempStartDate, tempEndDate, onDateRangeChange]);

  const clearDateRange = useCallback(() => {
    setStartDate(undefined);
    setEndDate(undefined);
    setTempStartDate(undefined);
    setTempEndDate(undefined);
    onDateRangeChange({
      startDate: null,
      endDate: null,
    });
  }, [onDateRangeChange]);

  const getDateRangeDisplay = useCallback(() => {
    if (!startDate || !endDate) {
      return null;
    }

    const hasCustomTime =
      startDate.getHours() !== 0 ||
      startDate.getMinutes() !== 0 ||
      endDate.getHours() !== 23 ||
      endDate.getMinutes() !== 59;

    if (hasCustomTime) {
      return `${format(startDate, "MMM d, yyyy HH:mm")} - ${format(endDate, "MMM d, yyyy HH:mm")}`;
    }

    return `${format(startDate, "MMM d, yyyy")} - ${format(endDate, "MMM d, yyyy")}`;
  }, [startDate, endDate]);

  return {
    startDate,
    endDate,
    isDateDialogOpen,
    tempStartDate,
    tempEndDate,
    setIsDateDialogOpen,
    setTempStartDate,
    setTempEndDate,
    openDateDialog,
    handleApplyDateRange,
    clearDateRange,
    getDateRangeDisplay,
    startDateParam: startDate?.toISOString(),
    endDateParam: endDate?.toISOString(),
  };
}
