"use client";

import { Label } from "@/components/ui/label";
import {
  RadioGroup,
  RadioGroupItem,
  radioCardClass,
} from "@/components/ui/radio-group";
import { cn } from "@/lib/utils/tailwind";

/** A labelled pick-one row of radio cards, each with an icon and a line. */
export function ChoiceCards<Value extends string>({
  label,
  value,
  onValueChange,
  options,
  idPrefix,
  columns = 2,
}: {
  label: string;
  value: Value;
  onValueChange: (value: Value) => void;
  options: Array<{
    value: Value;
    title: string;
    description: string;
    icon?: React.ReactNode;
  }>;
  idPrefix: string;
  columns?: 1 | 2;
}) {
  return (
    <div className="space-y-2">
      <span className="font-medium text-sm">{label}</span>
      <RadioGroup
        aria-label={label}
        value={value}
        onValueChange={(next) => onValueChange(next as Value)}
        className={cn("grid gap-2", columns === 2 && "sm:grid-cols-2")}
      >
        {options.map((option) => {
          const id = `${idPrefix}-${option.value}`;
          return (
            <Label
              key={option.value}
              htmlFor={id}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-lg p-3 font-normal",
                radioCardClass(),
              )}
            >
              <RadioGroupItem id={id} value={option.value} className="mt-0.5" />
              <span className="min-w-0 flex-1 space-y-1">
                <span className="flex items-center gap-2 font-medium">
                  {option.icon}
                  {option.title}
                </span>
                <span className="block text-xs text-muted-foreground leading-relaxed">
                  {option.description}
                </span>
              </span>
            </Label>
          );
        })}
      </RadioGroup>
    </div>
  );
}
