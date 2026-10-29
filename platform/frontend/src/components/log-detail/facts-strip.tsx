import type { ReactNode } from "react";
import { cn } from "@/lib/utils/tailwind";

// The facts card under a log detail page's header: label/value pairs with no
// tiles, in one bordered card. Phones get an aligned two-column grid with a
// hairline between rows; from `lg` it is one strip of hairline-separated
// facts. An optional second row under a hairline carries the record's
// identity (the session page's trajectory, a tool call's links).

export function FactsStrip({
  label,
  children,
  footer,
  footerLabel,
}: {
  /** Names the strip for assistive technologies. */
  label: string;
  children: ReactNode;
  /** A thin second row of the same card. */
  footer?: ReactNode;
  footerLabel?: string;
}) {
  return (
    <section
      aria-label={label}
      className="rounded-lg border border-border/70 bg-card"
    >
      <div className="px-4 py-1 lg:py-3">
        {/* Clips the hairline that would start each wrapped line. */}
        <div className="overflow-hidden">
          <dl className="grid grid-cols-2 lg:-ml-px lg:flex lg:flex-wrap lg:gap-y-3">
            {children}
          </dl>
        </div>
      </div>
      {footer ? (
        <section
          aria-label={footerLabel}
          className="rounded-b-lg border-t border-border/70 bg-muted/20 px-4 py-2.5 lg:py-2"
        >
          {footer}
        </section>
      ) : null}
    </section>
  );
}

export function Fact({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  // Phones: a hairline above every row but the first. Wide: every fact
  // carries a left hairline; the strip's -ml-px plus its clipping hides the
  // one that would start each wrapped line.
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-0.5 border-border/70 py-2 max-lg:border-t max-lg:odd:pr-3 max-lg:even:pl-3 max-lg:[&:nth-child(-n+2)]:border-t-0",
        "lg:flex-[1_1_140px] lg:border-l lg:px-4 lg:py-0 lg:first:pl-0",
        className,
      )}
    >
      <dt className="text-xs leading-4 text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

export function FactValue({
  children,
  muted,
}: {
  children: ReactNode;
  muted?: boolean;
}) {
  return (
    <span
      className={cn(
        "flex min-w-0 flex-nowrap items-center gap-x-2 text-base leading-5 font-semibold tracking-tight whitespace-nowrap tabular-nums",
        muted && "text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

export function FactSub({ children }: { children: ReactNode }) {
  return (
    <span className="block truncate text-xs leading-4 text-muted-foreground tabular-nums">
      {children}
    </span>
  );
}
