"use client";

import type { ComponentProps } from "react";
import type { StandardFormDialog } from "@/components/standard-dialog";
import { cn } from "@/lib/utils";

type StandardFormDialogProps = ComponentProps<typeof StandardFormDialog>;

/** The install/reauth form body without a modal, for entity detail pages. */
export function InlineCredentialFormShell({
  title,
  description,
  children,
  footer,
  onSubmit,
  bodyClassName,
}: StandardFormDialogProps) {
  return (
    <form
      className="overflow-hidden rounded-lg border bg-muted/20"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit?.(event);
      }}
      data-testid="inline-mcp-reauthentication-form"
    >
      <div className="border-b px-4 py-3">
        <h3 className="font-medium">{title}</h3>
        {description && (
          <div className="mt-1 text-sm text-muted-foreground">
            {description}
          </div>
        )}
      </div>
      <div className={cn("space-y-4 p-4", bodyClassName)}>{children}</div>
      {footer && (
        <div className="flex justify-end gap-2 border-t bg-background/60 px-4 py-3">
          {footer}
        </div>
      )}
    </form>
  );
}
