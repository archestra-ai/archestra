import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The chip the wizard and the detail pages both name things with — an MCP
 * server, an agent, a skill, a knowledge source. `count` is the wizard's
 * "(N)" and `note` its trailing detail ("78/98 disabled"); an `exclude` tone
 * carries the tool editor's red dot.
 *
 * `href` is opt-in because half of these name something with a page of its own
 * and half do not: a server, an agent, a skill and a knowledge connector are
 * all one click from their own record, while a header name, an environment
 * variable or a single tool has nowhere to go. A pill that leads somewhere
 * looks like it does; the rest stay inert rather than offering a dead click.
 */
export function EntityPill({
  icon,
  name,
  count,
  note,
  tone,
  href,
}: {
  icon?: ReactNode;
  name: string;
  count?: number;
  note?: string;
  tone?: "exclude";
  /** The named object's own page, when it has one. */
  href?: string;
}) {
  const shell = cn(
    "inline-flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-md border px-3 text-xs",
    href &&
      "transition-colors hover:bg-accent hover:text-accent-foreground outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
  );
  const content = (
    <>
      {tone === "exclude" && (
        <span className="size-2 shrink-0 rounded-full bg-red-500" />
      )}
      {icon}
      <span className="min-w-0 truncate font-medium">{name}</span>
      {count !== undefined && (
        <span className="shrink-0 tabular-nums text-muted-foreground">
          ({count})
        </span>
      )}
      {note && (
        <span className={cn("shrink-0 font-normal text-muted-foreground")}>
          {note}
        </span>
      )}
    </>
  );

  if (href) {
    return (
      <Link href={href} className={shell}>
        {content}
      </Link>
    );
  }
  return <span className={shell}>{content}</span>;
}
