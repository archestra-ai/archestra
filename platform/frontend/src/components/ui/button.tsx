import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * `aria-disabled` renders the disabled *look* without the disabled *behaviour*:
 * the control keeps pointer events, so it can be its own tooltip trigger and
 * show a not-allowed cursor, and it stays focusable so keyboard users reach the
 * reason. Because it still hovers, every variant restates its resting
 * appearance under `aria-disabled:hover:` to cancel its own hover rule.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 aria-disabled:opacity-50 aria-disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-primary/90 aria-disabled:hover:bg-primary",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60 aria-disabled:hover:bg-destructive dark:aria-disabled:hover:bg-destructive/60",
        outline:
          "border bg-background hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50 aria-disabled:hover:bg-background aria-disabled:hover:text-inherit dark:aria-disabled:hover:bg-input/30",
        "outline-transparent":
          "border bg-transparent hover:bg-accent/50 hover:text-accent-foreground aria-disabled:hover:bg-transparent aria-disabled:hover:text-inherit",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80 aria-disabled:hover:bg-secondary",
        ghost:
          "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50 aria-disabled:hover:bg-transparent aria-disabled:hover:text-inherit dark:aria-disabled:hover:bg-transparent",
        link: "text-primary underline-offset-4 hover:underline aria-disabled:hover:no-underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  };

export { Button, buttonVariants, type ButtonProps };
