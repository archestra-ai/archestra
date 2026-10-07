"use client";

import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { CircleIcon } from "lucide-react";
import type * as React from "react";

import { cn } from "@/lib/utils/tailwind";

function RadioGroup({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="radio-group"
      className={cn("grid gap-3", className)}
      {...props}
    />
  );
}

function RadioGroupItem({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={cn(
        "border-input text-primary focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:bg-input/30 aspect-square size-4 shrink-0 rounded-full border shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator
        data-slot="radio-group-indicator"
        className="relative flex items-center justify-center"
      >
        <CircleIcon className="fill-primary absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2" />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  );
}

/**
 * Surface and state styling for a selectable option card (a "radio card"):
 * a raised card on the page, a 2px primary edge when selected, a
 * flat dashed card when unavailable. Callers keep their own layout (flex,
 * padding, radius).
 *
 * State comes from the radio inside the card (`data-state`, `disabled`), so a
 * `Label` wrapping a `RadioGroupItem` needs no props. Cards that are not radios
 * (a button tile) pass `checked` / `disabled` instead.
 */
function radioCardClass({
  checked,
  disabled,
}: {
  checked?: boolean;
  disabled?: boolean;
} = {}) {
  return cn(
    "border border-border bg-raised transition-colors hover:border-primary/40",
    "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
    // Selected: a 2px primary edge (border + 1px ring, so nothing shifts) on
    // the same white fill. A tint read as greyed out next to white cards.
    "has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:ring-1 has-[[data-state=checked]]:ring-primary has-[[data-state=checked]]:hover:border-primary",
    "has-[:disabled]:cursor-not-allowed has-[:disabled]:border-dashed has-[:disabled]:bg-transparent has-[:disabled]:text-muted-foreground has-[:disabled]:hover:border-border",
    checked && "border-primary ring-1 ring-primary hover:border-primary",
    disabled &&
      "cursor-not-allowed border-dashed bg-transparent text-muted-foreground hover:border-border",
  );
}

export { RadioGroup, RadioGroupItem, radioCardClass };
