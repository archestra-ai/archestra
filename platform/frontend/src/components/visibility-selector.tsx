"use client";

import type { LucideIcon } from "lucide-react";
import { CheckIcon, ChevronDown } from "lucide-react";
import { useState } from "react";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export type VisibilityOption<Value extends string> = {
  value: Value;
  label: string;
  description: string;
  icon: LucideIcon;
  disabled?: boolean;
  disabledLabel?: string;
  disabledReason?: string;
};

export function VisibilitySelector<Value extends string>({
  label = "Visibility",
  heading,
  value,
  options,
  onValueChange,
  children,
}: {
  label?: string;
  heading?: string;
  value: Value;
  options: VisibilityOption<Value>[];
  onValueChange: (value: Value) => void;
  children?: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const selected =
    options.find((option) => option.value === value) ?? options[0];

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {heading ? (
          <h3 className="text-sm font-semibold">{heading}</h3>
        ) : (
          <Label>{label}</Label>
        )}

        {expanded ? (
          <div className="space-y-1.5">
            {options.map((option) => {
              const Icon = option.icon;
              const isSelected = value === option.value;
              const button = (
                <button
                  key={option.value}
                  type="button"
                  disabled={option.disabled}
                  onClick={() => {
                    if (!option.disabled) {
                      onValueChange(option.value);
                      setExpanded(false);
                    }
                  }}
                  className={`w-full flex items-center gap-3 rounded-lg border p-3 text-left transition-colors ${
                    option.disabled
                      ? "opacity-50 cursor-not-allowed"
                      : isSelected
                        ? "bg-primary text-primary-foreground border-primary"
                        : "hover:bg-muted/50 cursor-pointer"
                  }`}
                >
                  <div
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${
                      isSelected ? "bg-primary-foreground/20" : "bg-muted"
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">
                      {option.label}
                      {option.disabledLabel && (
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          {option.disabledLabel}
                        </span>
                      )}
                    </div>
                    <div
                      className={`text-xs ${
                        isSelected
                          ? "text-primary-foreground/70"
                          : "text-muted-foreground"
                      }`}
                    >
                      {option.description}
                    </div>
                  </div>
                  <div
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${
                      isSelected
                        ? "border-primary-foreground"
                        : "border-muted-foreground/30"
                    }`}
                  >
                    {isSelected && <CheckIcon className="h-2.5 w-2.5" />}
                  </div>
                </button>
              );

              if (!option.disabledReason) {
                return button;
              }

              return (
                <TooltipProvider key={option.value}>
                  <Tooltip>
                    <TooltipTrigger asChild>{button}</TooltipTrigger>
                    <TooltipContent>{option.disabledReason}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              );
            })}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="w-full cursor-pointer rounded-lg border p-3 text-left transition-colors hover:bg-muted/50"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
                <selected.icon className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{selected.label}</div>
                <div className="text-xs text-muted-foreground">
                  {selected.description}
                </div>
              </div>
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
            </div>
          </button>
        )}
      </div>

      {children}
    </div>
  );
}
