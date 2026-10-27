import type { ReactNode } from "react";
import { typeRole } from "@/lib/design/type-scale";
import { cn } from "@/lib/utils/tailwind";

/**
 * The one shape every Profile section's content takes: a single bordered
 * list of rows. Each section used to invent its own — a bare input, loose
 * chips, a card inside a card, a full-width table — and the page read as a
 * collage. One shape, repeated, is what makes it read as a page.
 */
export function AccountRows({
  children,
  label,
}: {
  children: ReactNode;
  /** Accessible name for the list; the section heading usually says it. */
  label?: string;
}) {
  return (
    <ul
      aria-label={label}
      className="divide-y overflow-hidden rounded-lg border bg-card"
    >
      {children}
    </ul>
  );
}

/**
 * Label, its current value, and at most one action. The action stays on the
 * right at every width; on narrow screens only the label and value stack, so
 * a row never grows a line just to hold its button.
 */
export function AccountRow({
  label,
  children,
  action,
  className,
}: {
  label: ReactNode;
  /** The current value. Omit for a row whose action is the whole point. */
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <li className={cn("flex min-h-14 items-center gap-4 px-4 py-3", className)}>
      <div className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:gap-6">
        <div
          className={cn(
            typeRole({ role: "section-title" }),
            "sm:w-40 sm:shrink-0",
          )}
        >
          {label}
        </div>
        <div className={cn(typeRole({ role: "body" }), "min-w-0 flex-1")}>
          {children}
        </div>
      </div>
      {action && <div className="flex shrink-0 items-center">{action}</div>}
    </li>
  );
}

/** A value that is a status rather than data — "None", "Off" — read second. */
export function AccountRowMuted({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}
