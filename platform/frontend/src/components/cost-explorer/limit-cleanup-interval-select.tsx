import type { archestraApiTypes } from "@archestra/shared";
import { useRef } from "react";
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

export type LimitCleanupInterval = Exclude<
  NonNullable<archestraApiTypes.CreateLimitData["body"]["cleanupInterval"]>,
  "minute"
>;

export const DEFAULT_LIMIT_CLEANUP_INTERVAL: LimitCleanupInterval =
  "calendar_month";

export const CLEANUP_INTERVAL_LABELS: Record<
  LimitCleanupInterval | "minute",
  string
> = {
  minute: "Per minute",
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
    label: "Rolling",
    options: ["1h", "12h", "24h", "1w", "1m"],
  },
  {
    label: "Calendar",
    options: [
      "calendar_day",
      "calendar_week_sunday",
      "calendar_week_monday",
      "calendar_month",
    ],
  },
];

type LimitCleanupIntervalSelectProps = {
  id?: string;
  ariaLabel?: string;
  disabled?: boolean;
  minuteDisabled?: boolean;
  onExplicitSelection?: () => void;
} & (
  | {
      includeMinute: true;
      value: LimitCleanupInterval | "minute";
      onValueChange: (value: LimitCleanupInterval | "minute") => void;
    }
  | {
      includeMinute?: false;
      value: LimitCleanupInterval;
      onValueChange: (value: LimitCleanupInterval) => void;
    }
);

export function LimitCleanupIntervalSelect(
  props: LimitCleanupIntervalSelectProps,
) {
  const { id, value, disabled, ariaLabel = "Reset period" } = props;
  const pressedOption = useRef<string | null>(null);
  const finishPointerSelection = (value: string) => {
    if (pressedOption.current === value) props.onExplicitSelection?.();
    pressedOption.current = null;
  };
  return (
    <Select
      value={value}
      onValueChange={(value) => {
        if (value === "minute") {
          if (props.includeMinute) props.onValueChange(value);
        } else {
          props.onValueChange(value as LimitCleanupInterval);
        }
      }}
      disabled={disabled}
    >
      <SelectTrigger id={id} aria-label={ariaLabel} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {props.includeMinute && (
          <>
            <SelectGroup>
              <SelectLabel>Rate</SelectLabel>
              <SelectItem
                value="minute"
                disabled={props.minuteDisabled}
                onPointerDown={() => {
                  if (!props.minuteDisabled) pressedOption.current = "minute";
                }}
                onPointerUp={() => finishPointerSelection("minute")}
                onPointerCancel={() => {
                  pressedOption.current = null;
                }}
                onClick={
                  props.minuteDisabled ? undefined : props.onExplicitSelection
                }
                onKeyDown={(event) => {
                  if (
                    !props.minuteDisabled &&
                    (event.key === "Enter" || event.key === " ")
                  ) {
                    props.onExplicitSelection?.();
                  }
                }}
              >
                Per minute
              </SelectItem>
            </SelectGroup>
            <SelectSeparator />
          </>
        )}
        {CLEANUP_INTERVAL_GROUPS.map((group, index) => (
          <SelectGroup key={group.label}>
            <SelectLabel>{group.label}</SelectLabel>
            {group.options.map((value) => (
              <SelectItem
                key={value}
                value={value}
                onPointerDown={() => {
                  pressedOption.current = value;
                }}
                onPointerUp={() => finishPointerSelection(value)}
                onPointerCancel={() => {
                  pressedOption.current = null;
                }}
                onClick={props.onExplicitSelection}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    props.onExplicitSelection?.();
                  }
                }}
              >
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
