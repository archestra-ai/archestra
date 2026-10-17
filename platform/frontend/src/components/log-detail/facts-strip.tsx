import type { ReactNode } from "react";
import { cn } from "@/lib/utils/tailwind";

// The hairline facts strip under a log detail page's header: label/value
// pairs with no tiles. Phones get an aligned two-column grid with a hairline
// under each row; from `lg` it is one strip of hairline-separated facts.

export function FactsStrip({
  label,
  children,
}: {
  /** Names the strip for assistive technologies. */
  label: string;
  children: ReactNode;
}) {
  return (
    <section aria-label={label} className="overflow-hidden">
      <dl className="grid grid-cols-2 lg:-ml-px lg:flex lg:flex-wrap lg:gap-y-4">
        {children}
      </dl>
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
  // Wide: every fact carries a left hairline; the strip's -ml-px plus its
  // overflow clipping hides the one that would start each wrapped line.
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1 border-b border-border/70 py-3 max-lg:odd:pr-4 max-lg:even:pl-4",
        "lg:flex-[1_1_150px] lg:border-b-0 lg:border-l lg:px-5 lg:py-0 lg:first:pl-0",
        className,
      )}
    >
      <dt className="text-xs text-muted-foreground">{label}</dt>
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
        "flex flex-wrap items-center gap-x-2 text-lg leading-6 font-semibold tracking-tight tabular-nums lg:flex-nowrap",
        muted && "text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

export function FactSub({ children }: { children: ReactNode }) {
  return (
    <span className="block text-xs leading-4 text-muted-foreground tabular-nums">
      {children}
    </span>
  );
}
