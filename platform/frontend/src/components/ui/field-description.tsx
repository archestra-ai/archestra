import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The single place input descriptions ("help text") are styled.
 *
 * Descriptions belong directly beneath the field's label and above the control,
 * one step smaller than the label, so a form reads label -> explanation ->
 * input. Render this rather than a hand-rolled muted paragraph; inside a
 * `<FormItem>` render `<FormDescription>`, which wraps this and adds the
 * `aria-describedby` wiring.
 */
function FieldDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="field-description"
      className={cn("text-muted-foreground text-xs", className)}
      {...props}
    />
  );
}

export { FieldDescription };
