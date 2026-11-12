"use client";

import { Info } from "lucide-react";
import type { ReactNode } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { cn } from "@/lib/utils/tailwind";

/**
 * One deployment setting with a few choices. Release 1.4: while an
 * environment variable sets it, the row only shows the value and names the
 * variable, as the Break the glass settings do; otherwise it is a select.
 */
export function DeploymentSettingRow<T extends string>(props: {
  /** Names the setting in labels. */
  title: string;
  /** The heading as shown, when it carries markup; the title otherwise. */
  heading?: ReactNode;
  /** A control on the heading's line, in place of the value. */
  action?: ReactNode;
  description: ReactNode;
  value: T | undefined;
  disabled: boolean;
  options: { value: T; label: string; description?: string }[];
  /** The environment variable that sets this setting, while one does. */
  environmentVariable?: string;
  /**
   * Inside a card: the value sits on the title's line at every width, with
   * no padding of its own, and the variable's note runs under the text.
   */
  compact?: boolean;
  /** The description already names the value: no value column. */
  hideValue?: boolean;
  onChange?: (value: T) => void;
}) {
  const current = props.options.find((option) => option.value === props.value);
  const note = props.environmentVariable ? (
    <p
      className={cn(
        "text-xs leading-4 text-muted-foreground",
        !props.compact && "lg:whitespace-nowrap",
      )}
    >
      <span>Set with </span>
      <code className="font-mono">
        {/* Wrap a long name only after an underscore. */}
        {props.environmentVariable.split("_").map((part, index) => (
          <span key={part}>
            {index > 0 ? (
              <>
                _<wbr />
              </>
            ) : null}
            {part}
          </span>
        ))}
        <span>={props.value}</span>
      </code>
      {props.options.length > 1 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <UnstyledButton
              aria-label={`${props.title} environment values`}
              className="ml-1 inline-flex align-middle"
            >
              <Info className="size-3.5" />
            </UnstyledButton>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm space-y-2" align="end">
            {props.options.map((option) => (
              <div key={option.value}>
                <code className="font-mono">{option.value}</code>
                <span> — {option.label}.</span>
                {option.description ? (
                  <p className="mt-1">{option.description}</p>
                ) : null}
              </div>
            ))}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </p>
  ) : null;
  return (
    <div
      className={cn(
        props.compact
          ? "flex items-start justify-between gap-6"
          : "grid gap-3 p-4 lg:items-center lg:gap-8",
        !props.compact &&
          (props.environmentVariable
            ? "lg:grid-cols-[minmax(0,1fr)_max-content]"
            : "lg:grid-cols-[minmax(0,1fr)_minmax(16rem,20rem)]"),
      )}
    >
      <div className="min-w-0 space-y-1">
        <h3 className="text-sm font-medium leading-5">
          {props.heading ?? props.title}
        </h3>
        <div className="text-sm leading-5 text-muted-foreground">
          {props.description}
        </div>
        {props.compact ? note : null}
      </div>
      {props.action ? (
        <div className="shrink-0">{props.action}</div>
      ) : props.value &&
        props.environmentVariable &&
        props.hideValue ? null : props.value && props.environmentVariable ? (
        <div
          className={cn(
            "min-w-0 space-y-1",
            props.compact ? "shrink-0 text-right" : "lg:text-right",
          )}
        >
          <p className="text-sm font-medium leading-5">
            {current?.label ?? props.value}
          </p>
          {props.compact ? null : note}
        </div>
      ) : props.value ? (
        <Select
          value={props.value}
          disabled={props.disabled}
          onValueChange={(value) => {
            const option = props.options.find((each) => each.value === value);
            if (option) props.onChange?.(option.value);
          }}
        >
          <SelectTrigger
            aria-label={props.title}
            size={props.compact ? "sm" : undefined}
            className={props.compact ? "w-28 shrink-0" : "w-full"}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="end">
            {props.options.map((option) => (
              <SelectItem
                key={option.value}
                value={option.value}
                description={option.description}
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Skeleton className="h-9 w-full" />
      )}
    </div>
  );
}
