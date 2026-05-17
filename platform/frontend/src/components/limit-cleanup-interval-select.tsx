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
  "1h": "Every hour",
  "12h": "Every 12 hours",
  "24h": "Every 24 hours",
  "1w": "Every week",
  "1m": "Every month",
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
