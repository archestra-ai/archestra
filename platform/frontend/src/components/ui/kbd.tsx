import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * A single keycap for rendering a keyboard shortcut — inside a tooltip, a
 * command-palette footer, etc. Use one <Kbd> per key so multi-key shortcuts
 * read as separate caps: `<Kbd>⌘</Kbd><Kbd>K</Kbd>`. Shared so every shortcut
 * hint in the app renders with the same styling.
 */
export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-[20px] items-center justify-center rounded border border-border/50 bg-muted px-1.5 font-sans text-[10px] font-medium text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}
