import type { ReactNode } from "react";

/** A titled block inside an OpenAPPA dialog, with an optional action on the right. */
export function DialogSection({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="space-y-3">
      {/* The action shares the title's row only, so the description keeps
          the full width instead of wrapping in a narrow column beside it. */}
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-4">
          <h3 className="text-sm font-medium">{title}</h3>
          {action}
        </div>
        {description && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}
