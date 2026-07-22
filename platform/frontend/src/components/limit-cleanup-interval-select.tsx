import type { archestraApiTypes } from "@archestra/shared";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type LimitCleanupInterval = NonNullable<
  archestraApiTypes.CreateLimitData["body"]["cleanupInterval"]
>;

export const DEFAULT_LIMIT_CLEANUP_INTERVAL: LimitCleanupInterval =
  "calendar_month";

export const CLEANUP_INTERVAL_LABELS: Record<LimitCleanupInterval, string> = {
  calendar_day: "Calendar day",
  calendar_week_sunday: "Calendar week (Sun-Sat)",
  calendar_week_monday: "Calendar week (Mon-Sun)",
  calendar_month: "Calendar month",
  "1h": "Rolling hour",
  "12h": "Rolling 12 hours",
  "24h": "Rolling day",
  "1w": "Rolling week",
  "1m": "Rolling month",
};

const CLEANUP_INTERVAL_GROUPS: Array<{
  label: string;
  options: LimitCleanupInterval[];
}> = [
  {
    label: "Calendar",
    options: [
      "calendar_day",
      "calendar_week_sunday",
      "calendar_week_monday",
      "calendar_month",
    ],
  },
  {
    label: "Rolling",
    options: ["1h", "12h", "24h", "1w", "1m"],
  },
];

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
        {CLEANUP_INTERVAL_GROUPS.map((group, index) => (
          <SelectGroup key={group.label}>
            <SelectLabel>{group.label}</SelectLabel>
            {group.options.map((value) => (
              <SelectItem key={value} value={value}>
                {CLEANUP_INTERVAL_LABELS[value]}
              </SelectItem>
            ))}
            {index < CLEANUP_INTERVAL_GROUPS.length - 1 && <SelectSeparator />}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}
