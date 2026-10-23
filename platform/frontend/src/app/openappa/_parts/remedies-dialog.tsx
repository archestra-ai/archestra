"use client";

import { Search, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { Fragment, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { RemediesView, Remedy } from "@/lib/openappa-remedies.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { cn } from "@/lib/utils/tailwind";
import { batteryDisplayName } from "./battery-display-name";
import { policyLineHref } from "./policy-line-href";
import {
  type CoverChip,
  coverChips,
  groupBySource,
  isWired,
} from "./remedies.utils";

export type RemedyFilter = "all" | "authority" | "sanitizer" | "unwired";

const FILTERS: { key: RemedyFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "authority", label: "Authorities" },
  { key: "sanitizer", label: "Sanitizers" },
  { key: "unwired", label: "Not wired" },
];

/**
 * Every authority and sanitizer the policy declares, grouped by the file
 * that declares it, with what each may unblock and when it was last used.
 */
export function RemediesDialog({
  view,
  filter,
  onClose,
}: {
  view: RemediesView;
  /** The filter to open on; null keeps the dialog closed. */
  filter: RemedyFilter | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={filter !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {filter !== null && (
          <RemediesDialogContent view={view} initialFilter={filter} />
        )}
      </DialogContent>
    </Dialog>
  );
}

// =============================================================================
// Internal components
// =============================================================================

function RemediesDialogContent({
  view,
  initialFilter,
}: {
  view: RemediesView;
  initialFilter: RemedyFilter;
}) {
  const [filter, setFilter] = useState(initialFilter);
  const [search, setSearch] = useState("");
  const all = [...view.authorities, ...view.sanitizers];
  const counts: Record<RemedyFilter, number> = {
    all: all.length,
    authority: view.authorities.length,
    sanitizer: view.sanitizers.length,
    unwired: all.filter((remedy) => !isWired(remedy)).length,
  };
  const needle = search.trim().toLowerCase();
  const shown = (remedy: Remedy) =>
    (filter === "all" ||
      (filter === "unwired" ? !isWired(remedy) : remedy.kind === filter)) &&
    (needle === "" ||
      [
        remedy.name,
        remedy.source.battery ?? "",
        ...coverChips(remedy).map((chip) => chip.value),
      ].some((text) => text.toLowerCase().includes(needle)));
  const groups = groupBySource(view)
    .map((group) => ({
      ...group,
      remedies: group.remedies.filter(shown),
    }))
    .filter((group) => group.remedies.length > 0);
  const sources = groupBySource(view);
  const batteries = sources.filter((group) => group.battery).length;
  const filters = FILTERS.filter(
    (each) =>
      each.key !== "unwired" || counts.unwired > 0 || filter === each.key,
  );

  return (
    <>
      <DialogHeader className="shrink-0 space-y-4 border-b px-6 pt-6 pb-4 text-left">
        <div className="space-y-1">
          <DialogTitle>Authorities and sanitizers</DialogTitle>
          <DialogDescription>
            {`Who can unblock a blocked call, and what each one may unblock. ${all.length} declared by the root policy${batteries > 0 ? ` and ${batteries} ${batteries === 1 ? "battery" : "batteries"}` : ""}.`}
          </DialogDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-72">
            <Search
              aria-hidden
              className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2"
            />
            <Input
              aria-label="Search authorities and sanitizers"
              placeholder="Search by name, mark or battery"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-8 pl-8 text-sm"
            />
          </div>
          {filters.map((each) => (
            <Button
              key={each.key}
              size="sm"
              variant={filter === each.key ? "default" : "outline"}
              className={cn(
                "rounded-full",
                each.key === "unwired" &&
                  counts.unwired > 0 &&
                  filter !== each.key &&
                  "text-amber-600 dark:text-amber-400",
              )}
              onClick={() => setFilter(each.key)}
            >
              <span>{`${each.label} ${counts[each.key]}`}</span>
            </Button>
          ))}
        </div>
      </DialogHeader>
      <DialogBody className="min-h-0 flex-1 overflow-auto p-0 pb-6">
        {groups.length === 0 ? (
          <p className="text-muted-foreground px-6 py-10 text-center text-sm">
            Nothing matches.
          </p>
        ) : (
          <Table className="table-auto">
            <TableHeader>
              <TableRow className="bg-muted/40 text-muted-foreground whitespace-nowrap text-xs hover:bg-muted/40">
                <TableHead className="text-muted-foreground w-[30%] pl-6 md:pl-6">
                  Name
                </TableHead>
                <TableHead className="text-muted-foreground">
                  Can unblock
                </TableHead>
                <TableHead className="text-muted-foreground w-[18%] pr-6 text-right md:pr-6">
                  Last used
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="[&_tr:last-child]:border-b">
              {groups.map((group) => (
                <Fragment key={group.key}>
                  {sources.length > 1 && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell
                        colSpan={3}
                        className="text-muted-foreground pt-4 pb-2 pl-6 text-xs font-medium md:pl-6"
                      >
                        <span>
                          {group.battery
                            ? batteryDisplayName(group.battery)
                            : "Root policy"}
                        </span>
                        <span className="font-normal">{` · ${group.remedies.length}`}</span>
                      </TableCell>
                    </TableRow>
                  )}
                  {group.remedies.map((remedy) => (
                    <RemedyRow key={remedy.name} remedy={remedy} />
                  ))}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        )}
      </DialogBody>
    </>
  );
}

function RemedyRow({ remedy }: { remedy: Remedy }) {
  return (
    <TableRow>
      <TableCell className="py-3.5 pl-6 align-top md:pl-6">
        <span className="flex flex-col gap-0.5">
          <Link
            href={policyLineHref(remedy.source)}
            className="font-mono text-[13px] font-semibold hover:underline"
          >
            {remedy.name}
          </Link>
          <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <span>
              {remedy.kind === "authority" ? "Authority" : "Sanitizer"}
            </span>
            {!isWired(remedy) && (
              <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                <TriangleAlert aria-hidden className="size-3" />
                <span>not wired</span>
              </span>
            )}
          </span>
        </span>
      </TableCell>
      <TableCell className="py-3.5 align-top">
        <span className="flex flex-wrap gap-1.5">
          {coverChips(remedy).map((chip) => (
            <Chip key={`${chip.lock}:${chip.value}`} chip={chip} />
          ))}
        </span>
      </TableCell>
      <TableCell className="text-muted-foreground py-3.5 pr-6 text-right align-top text-sm whitespace-nowrap md:pr-6">
        {remedy.lastConsult ? (
          <span className="flex flex-col">
            <span>{formatRelativeTimeFromNow(remedy.lastConsult.at)}</span>
            <span className="text-xs">{remedy.lastConsult.outcome}</span>
          </span>
        ) : (
          <span>Never</span>
        )}
      </TableCell>
    </TableRow>
  );
}

/** `lock value`: the grey policy lock name, then what may be done about it. */
function Chip({ chip }: { chip: CoverChip }) {
  return (
    <Badge
      variant="outline"
      className="h-6 gap-1.5 rounded-md px-2 whitespace-nowrap font-normal"
    >
      <span className="text-muted-foreground font-mono">{chip.lock}</span>
      <span className={cn(chip.code && "font-mono")}>{chip.value}</span>
    </Badge>
  );
}
