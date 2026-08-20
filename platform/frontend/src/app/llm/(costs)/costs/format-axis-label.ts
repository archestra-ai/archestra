import {
  getStatisticsAxisLabelPrecision,
  type StatisticsAxisLabelPrecision,
  type StatisticsTimeFrame,
} from "@archestra/shared";
import { format } from "date-fns";

/**
 * Label one bucket of a statistics time series for the chart's time axis.
 *
 * The label doubles as the chart's category key, so it has to be as precise as
 * the timeframe's bucket width: labelling six-hourly buckets with the day alone
 * repeats the same day on four consecutive ticks, and leaves the tooltip — which
 * is keyed off the same label — just as ambiguous.
 */
export function formatStatisticsAxisLabel(
  timestamp: string,
  timeframe: StatisticsTimeFrame,
): string {
  return format(
    new Date(timestamp),
    AXIS_LABEL_FORMATS[getStatisticsAxisLabelPrecision(timeframe)],
  );
}

/** date-fns patterns backing each axis-label precision. */
const AXIS_LABEL_FORMATS: Record<StatisticsAxisLabelPrecision, string> = {
  time: "HH:mm",
  dateTime: "MMM d, HH:mm",
  date: "MMM d",
  dateYear: "MMM d, yyyy",
  monthYear: "MMM yyyy",
};
