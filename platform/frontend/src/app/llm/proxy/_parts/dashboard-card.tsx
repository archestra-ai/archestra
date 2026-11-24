"use client";

import type { SupportedProvider } from "@archestra/shared";
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { PROVIDER_CONFIG } from "@/components/llm-provider-api-key-form";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { cn } from "@/lib/utils/tailwind";

/**
 * One section of the LLM Proxy dashboard: a title with its count, an optional
 * status badge for a section not set up yet, the content, and a footer row of
 * actions pinned to the bottom so cards in a row line up.
 */
export function DashboardCard({
  id,
  title,
  count,
  status,
  note,
  footer,
  className,
  children,
}: {
  id: string;
  title: string;
  count?: number;
  status?: ReactNode;
  /** One line under the title saying what the section is for. */
  note?: string;
  footer?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className={cn(
        "flex min-w-0 flex-col gap-3.5 rounded-xl border bg-card px-5 py-[18px]",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <h2 id={id} className="text-[15px] font-semibold">
          {title}
        </h2>
        {count !== undefined && <CountPill>{count}</CountPill>}
        {status && <span className="ml-auto">{status}</span>}
      </div>
      {note && (
        <p className="-mt-2 text-[12.5px] text-muted-foreground">{note}</p>
      )}
      {children}
      {footer && (
        <div className="mt-auto flex items-center gap-3.5 border-t border-border/60 pt-3 text-[13px] whitespace-nowrap">
          {footer}
        </div>
      )}
    </section>
  );
}

function CountPill({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full bg-muted px-2 py-px text-xs font-medium text-muted-foreground tabular-nums">
      {children}
    </span>
  );
}

/** "Not set up", "Optional", "Not ready": shown only while a section is empty. */
export function NotSetUpBadge({ children }: { children: string }) {
  return (
    <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-muted px-2.5 text-xs font-medium whitespace-nowrap text-muted-foreground">
      <span
        aria-hidden
        className="size-1.5 rounded-full border-[1.5px] border-muted-foreground/60"
      />
      {children}
    </span>
  );
}

/** The chips of a card: one per item, then "+N more". */
export function ChipRow({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-wrap gap-1.5">{children}</div>;
}

const chipClass =
  "inline-flex h-[30px] max-w-full min-w-0 items-center gap-[7px] rounded-lg bg-muted px-2.5 text-[13px] whitespace-nowrap text-foreground transition-colors hover:bg-accent";

/** An item of a card that opens its own page, filtered to it. */
export function ChipLink({ className, ...props }: ComponentProps<typeof Link>) {
  return <Link className={cn(chipClass, className)} {...props} />;
}

/** A chip that acts on this page, such as adding a provider key. */
export function ChipButton({
  className,
  ...props
}: ComponentProps<typeof UnstyledButton>) {
  return (
    <UnstyledButton
      type="button"
      className={cn(chipClass, "border bg-card", className)}
      {...props}
    />
  );
}

/** "+N more": the full list on its own page, so the card never grows. */
export function MoreLink({ href, count }: { href: string; count: number }) {
  if (count <= 0) return null;
  return (
    <Link
      href={href}
      className="inline-flex h-[30px] items-center px-1.5 text-[12.5px] text-primary hover:underline"
    >
      +{count} more
    </Link>
  );
}

export function ProviderLogo({
  provider,
  className,
}: {
  provider: SupportedProvider;
  className?: string;
}) {
  return (
    <img
      src={PROVIDER_CONFIG[provider].icon}
      alt=""
      className={cn(
        "size-[15px] shrink-0 rounded object-contain dark:invert",
        className,
      )}
    />
  );
}

/** Up to three provider logos side by side. */
export function ProviderStack({
  providers,
}: {
  providers: SupportedProvider[];
}) {
  return (
    <span className="inline-flex gap-[3px]">
      {[...new Set(providers)].slice(0, 3).map((provider) => (
        <ProviderLogo key={provider} provider={provider} className="size-3.5" />
      ))}
    </span>
  );
}

/** The empty state inside a card. */
export function EmptyBox({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5 rounded-[10px] border border-dashed bg-muted/30 p-3.5">
      {children}
    </div>
  );
}

/** A footer action that opens a dialog on this page. */
export function FooterAction({
  className,
  ...props
}: ComponentProps<typeof UnstyledButton>) {
  return (
    <UnstyledButton
      type="button"
      className={cn("text-primary hover:underline", className)}
      {...props}
    />
  );
}

/** A footer link to another page, pushed right. */
export function FooterLink({
  className,
  ...props
}: ComponentProps<typeof Link>) {
  return (
    <Link
      className={cn("text-muted-foreground hover:underline", className)}
      {...props}
    />
  );
}
