import type { archestraApiTypes } from "@shared";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type LimitCleanupInterval = NonNullable<
  NonNullable<
    archestraApiTypes.UpdateLlmSettingsData["body"]
  >["defaultUserLimitCleanupInterval"]
>;

export const DEFAULT_LIMIT_CLEANUP_INTERVAL: LimitCleanupInterval = "1w";

export const CLEANUP_INTERVAL_LABELS: Record<LimitCleanupInterval, string> = {
  "1h": "Rolling hour",
  "12h": "Rolling 12 hours",
  "24h": "Rolling day",
  "1w": "Rolling week",
  "1m": "Rolling month",
  calendar_day: "Calendar day",
  calendar_week_sunday: "Calendar week (Sun-Sat)",
  calendar_week_monday: "Calendar week (Mon-Sun)",
  calendar_month: "Calendar month",
};

type LimitCleanupIntervalSelectProps = {
  value: LimitCleanupInterval;
  onValueChange: (value: LimitCleanupInterval) => void;
  disabled?: boolean;
};

export function LimitCleanupIntervalSelect({
  value,
  onValueChange,
  disabled,
}: LimitCleanupIntervalSelectProps) {
  return (
    <Select value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {Object.entries(CLEANUP_INTERVAL_LABELS).map(([value, label]) => (
          <SelectItem key={value} value={value}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
