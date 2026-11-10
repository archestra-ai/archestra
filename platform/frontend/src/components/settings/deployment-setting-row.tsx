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
 * One deployment setting with a few choices. While an environment variable
 * sets it, the choice is locked and the row names the variable, its value,
 * and the values it takes, as the Break the glass settings do.
 */
export function DeploymentSettingRow<T extends string>(props: {
  title: string;
  description: ReactNode;
  value: T | undefined;
  disabled: boolean;
  options: { value: T; label: string; description?: string }[];
  /** The environment variable that sets this setting, while one does. */
  environmentVariable?: string;
  onChange: (value: T) => void;
}) {
  const noteId = `${props.title.replaceAll(" ", "-").toLowerCase()}-env-note`;
  return (
    <div
      className={cn(
        "grid gap-3 p-4 lg:items-center lg:gap-8",
        props.environmentVariable
          ? "lg:grid-cols-[minmax(0,1fr)_max-content]"
          : "lg:grid-cols-[minmax(0,1fr)_minmax(16rem,20rem)]",
      )}
    >
      <div className="min-w-0 space-y-1">
        <h3 className="text-sm font-medium leading-5">{props.title}</h3>
        <div className="text-sm leading-5 text-muted-foreground">
          {props.description}
        </div>
      </div>
      {props.value ? (
        <div className="min-w-0 space-y-1.5">
          <Select
            value={props.value}
            disabled={props.disabled || props.environmentVariable !== undefined}
            onValueChange={(value) => {
              const option = props.options.find((each) => each.value === value);
              if (option) props.onChange(option.value);
            }}
          >
            <SelectTrigger
              aria-label={props.title}
              aria-describedby={props.environmentVariable ? noteId : undefined}
              className="w-full"
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
          {props.environmentVariable ? (
            <div className="space-y-1 text-xs leading-4 text-muted-foreground">
              <p className="lg:whitespace-nowrap">
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
              </p>
              <p id={noteId}>
                Unset the environment variable to edit this setting.
              </p>
            </div>
          ) : null}
        </div>
      ) : (
        <Skeleton className="h-9 w-full" />
      )}
    </div>
  );
}
