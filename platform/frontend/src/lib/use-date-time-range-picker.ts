"use client";

import { useCallback, useState } from "react";
import type { DateRange } from "react-day-picker";

/**
 * Parses time string (HH:mm) from a Date object using UTC hours to avoid timezone issues.
 * This ensures that when URLs are shared across timezones, the time is interpreted consistently.
 */
function getUtcTimeString(date: Date): string {
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

/**
 * Creates a Date object with specified time in UTC.
 * This ensures consistent behavior across timezones when applying date ranges.
 */
function setUtcTime(
  date: Date,
  hours: number,
  minutes: number,
  seconds: number,
  ms: number,
): Date {
  const result = new Date(date);
  result.setUTCHours(hours, minutes, seconds, ms);
  return result;
}

export interface UseDateTimeRangePickerOptions {
  startDateFromUrl: string | null;
  endDateFromUrl: string | null;
  onDateRangeChange: (params: {
    startDate: string | null;
    endDate: string | null;
  }) => void;
}

export interface UseDateTimeRangePickerReturn {
  dateRange: DateRange | undefined;
  isDateDialogOpen: boolean;
  tempDateRange: DateRange | undefined;
  fromTime: string;
  toTime: string;
  setIsDateDialogOpen: (open: boolean) => void;
  setTempDateRange: (range: DateRange | undefined) => void;
  setFromTime: (time: string) => void;
  setToTime: (time: string) => void;
  openDateDialog: () => void;
  handleApplyDateRange: () => void;
  clearDateRange: () => void;
  getDateRangeDisplay: () => string | null;
  startDateParam: string | undefined;
  endDateParam: string | undefined;
}

/**
 * Custom hook for managing date-time range picker state and logic.
 * Handles URL persistence, timezone-safe date handling, and all picker interactions.
 */
export function useDateTimeRangePicker({
  startDateFromUrl,
  endDateFromUrl,
  onDateRangeChange,
}: UseDateTimeRangePickerOptions): UseDateTimeRangePickerReturn {
  // Date range state - initialized from URL params if present
  const [dateRange, setDateRange] = useState<DateRange | undefined>(() => {
    if (startDateFromUrl && endDateFromUrl) {
      return {
        from: new Date(startDateFromUrl),
        to: new Date(endDateFromUrl),
      };
    }
    return undefined;
  });

  // Dialog state
  const [isDateDialogOpen, setIsDateDialogOpen] = useState(false);
  const [tempDateRange, setTempDateRange] = useState<DateRange | undefined>(
    dateRange,
  );

  // Time inputs - use UTC time to ensure consistency across timezones when loaded from URL
  const [fromTime, setFromTime] = useState(() => {
    if (startDateFromUrl) {
      return getUtcTimeString(new Date(startDateFromUrl));
    }
    return "00:00";
  });
  const [toTime, setToTime] = useState(() => {
    if (endDateFromUrl) {
      return getUtcTimeString(new Date(endDateFromUrl));
    }
    return "23:59";
  });

  const openDateDialog = useCallback(() => {
    setTempDateRange(dateRange);
    if (dateRange?.from) {
      // Use UTC hours for consistent display when sharing URLs across timezones
      setFromTime(getUtcTimeString(dateRange.from));
    } else {
      setFromTime("00:00");
    }
    if (dateRange?.to) {
      setToTime(getUtcTimeString(dateRange.to));
    } else {
      setToTime("23:59");
    }
    setIsDateDialogOpen(true);
  }, [dateRange]);

  const handleApplyDateRange = useCallback(() => {
    if (!tempDateRange?.from || !tempDateRange?.to) {
      return;
    }

    const [fromHours, fromMinutes] = fromTime.split(":").map(Number);
    const [toHours, toMinutes] = toTime.split(":").map(Number);

    // Use UTC time setting to ensure consistent API calls across timezones
    const fromDateTime = setUtcTime(
      tempDateRange.from,
      fromHours,
      fromMinutes,
      0,
      0,
    );
    const toDateTime = setUtcTime(
      tempDateRange.to,
      toHours,
      toMinutes,
      59,
      999,
    );

    setDateRange({ from: fromDateTime, to: toDateTime });
    onDateRangeChange({
      startDate: fromDateTime.toISOString(),
      endDate: toDateTime.toISOString(),
    });
    setIsDateDialogOpen(false);
  }, [tempDateRange, fromTime, toTime, onDateRangeChange]);

  const clearDateRange = useCallback(() => {
    setDateRange(undefined);
    setTempDateRange(undefined);
    setFromTime("00:00");
    setToTime("23:59");
    onDateRangeChange({
      startDate: null,
      endDate: null,
    });
  }, [onDateRangeChange]);

  // Build date params for API call - simply serialize existing dates
  const startDateParam = dateRange?.from
    ? dateRange.from.toISOString()
    : undefined;
  const endDateParam = dateRange?.to ? dateRange.to.toISOString() : undefined;

  // Format date range display using UTC hours for consistency
  const getDateRangeDisplay = useCallback(() => {
    if (!dateRange?.from || !dateRange?.to) {
      return null;
    }

    const fromUtcHours = dateRange.from.getUTCHours();
    const fromUtcMinutes = dateRange.from.getUTCMinutes();
    const toUtcHours = dateRange.to.getUTCHours();
    const toUtcMinutes = dateRange.to.getUTCMinutes();

    const hasCustomTime =
      fromUtcHours !== 0 ||
      fromUtcMinutes !== 0 ||
      toUtcHours !== 23 ||
      toUtcMinutes !== 59;

    // Format dates using UTC to ensure consistency across timezones
    const fromDateStr = dateRange.from.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
    const toDateStr = dateRange.to.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });

    if (hasCustomTime) {
      const fromTimeStr = `${String(fromUtcHours).padStart(2, "0")}:${String(fromUtcMinutes).padStart(2, "0")}`;
      const toTimeStr = `${String(toUtcHours).padStart(2, "0")}:${String(toUtcMinutes).padStart(2, "0")}`;
      return `${fromDateStr} ${fromTimeStr} - ${toDateStr} ${toTimeStr} UTC`;
    }

    return `${fromDateStr} - ${toDateStr}`;
  }, [dateRange]);

  return {
    dateRange,
    isDateDialogOpen,
    tempDateRange,
    fromTime,
    toTime,
    setIsDateDialogOpen,
    setTempDateRange,
    setFromTime,
    setToTime,
    openDateDialog,
    handleApplyDateRange,
    clearDateRange,
    getDateRangeDisplay,
    startDateParam,
    endDateParam,
  };
}
