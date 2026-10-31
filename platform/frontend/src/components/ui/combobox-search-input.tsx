import type * as React from "react";
import { cn } from "@/lib/utils/tailwind";

/** Borderless search field inside a combobox popover's search row.
 * The caller owns the icon, listbox navigation and filtering.
 */
export function ComboboxSearchInput({
  className,
  ...props
}: React.ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "flex w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}
