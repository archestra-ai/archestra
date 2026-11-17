"use client";

import { Check, ChevronsUpDown, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Fragment, type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils/tailwind";

export type SectionNavItem = {
  href: string;
  label: string;
  Icon?: LucideIcon;
  /**
   * Pages inside this section, listed under it while it is the active one. A
   * component rather than data, so whatever it fetches (a status per page,
   * say) loads only on that section's pages.
   */
  subnav?: ReactNode;
};

/**
 * Switcher for a settings surface's sections. From `lg` it is a column
 * beside the content, with the active section's pages listed under it. Below
 * `lg` a 15-entry column would push the content off the first screen and a
 * row of them scrolled most sections out of sight, so it is one button naming
 * where the reader is, which opens a searchable list of every section.
 *
 * Matching is left to the caller through `activeHref` — routed surfaces have
 * to resolve a nested path back to its section, while a single-route surface
 * only compares a query param.
 */
export function SectionNav({
  items,
  activeHref,
  label,
}: {
  items: SectionNavItem[];
  activeHref: string;
  label: string;
}) {
  return (
    <nav aria-label={label}>
      <div className="lg:hidden">
        <SectionPicker items={items} activeHref={activeHref} />
      </div>
      <div className="hidden flex-col gap-1 rounded-lg border border-border bg-card p-1 lg:flex">
        {items.map(({ href, label: itemLabel, Icon, subnav }) => {
          const isActive = href === activeHref;
          return (
            <Fragment key={href}>
              <Link
                href={href}
                aria-current={isActive && !subnav ? "page" : undefined}
                className={cn(
                  "flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm transition-colors",
                  isActive && !subnav
                    ? "bg-accent font-medium text-accent-foreground"
                    : isActive
                      ? "font-medium text-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                {Icon && <Icon className="size-4 shrink-0" />}
                {itemLabel}
              </Link>
              {isActive && subnav}
            </Fragment>
          );
        })}
      </div>
    </nav>
  );
}

/** One page inside a section, indented under it in {@link SectionNav}. */
export function SectionSubnavLink({
  href,
  active,
  icon,
  label,
  status,
  badge,
}: {
  href: string;
  active: boolean;
  icon: ReactNode;
  label: string;
  /** A short marker after the label, such as a Beta badge. */
  badge?: ReactNode;
  /** A short state for the page, shown as a dot with its text for readers. */
  status?: { label: string; ok: boolean };
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2 whitespace-nowrap rounded-md py-1.5 pr-3 pl-9 text-sm transition-colors",
        active
          ? "bg-accent font-medium text-accent-foreground"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
      )}
    >
      {icon}
      <span className="flex-1">{label}</span>
      {badge}
      {status && (
        <span
          title={status.label}
          className={cn(
            "size-2 shrink-0 rounded-full",
            status.ok ? "bg-green-600" : "bg-muted-foreground/40",
          )}
        >
          <span className="sr-only">{status.label}</span>
        </span>
      )}
    </Link>
  );
}

// ===================================================================
// Internal
// ===================================================================

/**
 * The sections on a phone or tablet: one button naming the section (and the
 * page inside it) the reader is on. It opens a list of every section as wide
 * as the button, with a search field on top and the active section's pages
 * under it.
 */
function SectionPicker({
  items,
  activeHref,
}: {
  items: SectionNavItem[];
  activeHref: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const active = items.find((item) => item.href === activeHref);
  const ActiveIcon = active?.Icon;
  const subPage =
    pathname && pathname !== activeHref ? subPageLabel(pathname) : null;

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setSearch("");
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-start gap-2 bg-card px-2.5 font-normal"
        >
          <span className="sr-only">Current section:</span>
          {ActiveIcon && <ActiveIcon className="size-4 shrink-0" />}
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5 text-left">
            <span className="truncate font-medium">
              {active?.label ?? "Settings"}
            </span>
            {subPage && (
              <>
                <span aria-hidden className="text-muted-foreground/60">
                  /
                </span>
                <span className="truncate text-muted-foreground">
                  {subPage}
                </span>
              </>
            )}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-(--radix-popover-trigger-width) min-w-64 p-0"
        // Leave focus on the button: focusing the search field would raise
        // the phone keyboard over half the list before the reader asked.
        onOpenAutoFocus={(event) => event.preventDefault()}
        // A section's own pages are plain links; close once one is followed.
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("a")) onOpenChange(false);
        }}
      >
        <Command defaultValue={active?.label}>
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder="Search settings..."
            // 16px on phones so iOS does not zoom the page on focus.
            className="text-base md:text-sm"
          />
          <CommandList className="max-h-[min(24rem,calc(var(--radix-popover-content-available-height)-3rem))]">
            <CommandEmpty>No matching section.</CommandEmpty>
            <CommandGroup>
              {items.map(({ href, label, Icon, subnav }) => {
                const isActive = href === activeHref;
                return (
                  <div key={href}>
                    <CommandItem
                      value={label}
                      keywords={[href.split("/").pop() ?? ""]}
                      aria-current={isActive && !subnav ? "page" : undefined}
                      onSelect={() => {
                        onOpenChange(false);
                        if (href !== pathname) router.push(href);
                      }}
                      className={cn("min-h-9 py-2", isActive && "font-medium")}
                    >
                      {Icon ? (
                        <Icon
                          className={cn(
                            "size-4",
                            isActive && "text-foreground",
                          )}
                        />
                      ) : (
                        <span className="size-4 shrink-0" />
                      )}
                      <span className="flex-1 truncate">{label}</span>
                      {isActive && <Check className="size-4 text-foreground" />}
                    </CommandItem>
                    {/* The section's own pages. They are not searchable, so
                        they step aside while a query narrows the list. */}
                    {isActive && subnav && !search && (
                      <div className="[&_a]:min-h-9 [&_a]:rounded-sm [&_a]:py-2 [&_a]:pr-2">
                        {subnav}
                      </div>
                    )}
                  </div>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** "/settings/agents/runtimes" names its page "Runtimes". */
function subPageLabel(pathname: string) {
  const segment = pathname.split("/").filter(Boolean).pop() ?? "";
  return decodeURIComponent(segment)
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
