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
  forTools,
  groupBySource,
  isWired,
  runsAs,
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
 * that declares it, with who runs it, what it may lift and which tools it
 * may act on.
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
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
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
        ...remedy.tags,
        ...coverChips(remedy).map((chip) => chip.value),
      ].some((text) => text.toLowerCase().includes(needle)));
  const groups = groupBySource(view)
    .map((group) => ({
      ...group,
      remedies: group.remedies.filter(shown),
    }))
    .filter((group) => group.remedies.length > 0);
  const batteries = groupBySource(view).filter((group) => group.battery).length;

  return (
    <>
      <DialogHeader className="shrink-0 space-y-3 border-b px-5 pt-5 pb-4 text-left">
        <div className="space-y-1">
          <DialogTitle>Authorities and sanitizers</DialogTitle>
          <DialogDescription>
            {`${all.length} declared by the root policy${batteries > 0 ? ` and ${batteries} ${batteries === 1 ? "battery" : "batteries"}` : ""}. Each is offered only when it is wired to an implementation.`}
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
              placeholder="Search by name, mark, tag or battery"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-8 pl-8 text-sm"
            />
          </div>
          {FILTERS.map((each) => (
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
      <DialogBody className="min-h-0 flex-1 overflow-auto p-0">
        {groups.length === 0 ? (
          <p className="text-muted-foreground px-5 py-10 text-center text-sm">
            Nothing matches.
          </p>
        ) : (
          <Table className="table-auto">
            <TableHeader>
              <TableRow className="whitespace-nowrap">
                <TableHead className="pl-5">Name</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Runs as</TableHead>
                <TableHead className="w-[38%]">Covers</TableHead>
                <TableHead className="w-[22%]">For</TableHead>
                <TableHead className="pr-5">Last used</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((group) => (
                <Fragment key={group.key}>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableCell
                      colSpan={6}
                      className="text-muted-foreground py-2 pl-5 text-xs font-medium"
                    >
                      <span>
                        {group.battery
                          ? batteryDisplayName(group.battery)
                          : "Root policy"}
                      </span>
                      <span className="font-normal">{` · ${group.remedies.length}`}</span>
                    </TableCell>
                  </TableRow>
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
  const runner = runsAs(remedy);
  const scope = forTools(remedy);
  return (
    <TableRow>
      <TableCell className="pl-5 font-mono text-xs font-medium whitespace-nowrap">
        <Link href={policyLineHref(remedy.source)} className="hover:underline">
          {remedy.name}
        </Link>
      </TableCell>
      <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
        {remedy.kind === "authority" ? "Authority" : "Sanitizer"}
      </TableCell>
      <TableCell className="text-xs whitespace-nowrap">
        {runner ? (
          <span className="text-muted-foreground">{runner}</span>
        ) : (
          <span className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
            <TriangleAlert aria-hidden className="size-3.5" />
            <span>not wired</span>
          </span>
        )}
      </TableCell>
      <TableCell>
        <span className="flex flex-wrap gap-1.5">
          {coverChips(remedy).map((chip) => (
            <Chip key={`${chip.lock}:${chip.value}`} chip={chip} />
          ))}
        </span>
      </TableCell>
      <TableCell className="text-muted-foreground text-xs">
        <span className="flex flex-wrap items-center gap-1.5">
          {scope.prefix && <span>{scope.prefix}</span>}
          {scope.tags.length === 0 ? (
            <span>any tool</span>
          ) : (
            scope.tags.map((tag) => (
              <Chip key={tag} chip={{ lock: "Tag", value: tag, code: true }} />
            ))
          )}
        </span>
      </TableCell>
      <TableCell className="text-muted-foreground pr-5 text-xs">
        {remedy.lastConsult
          ? `${formatRelativeTimeFromNow(remedy.lastConsult.at)} · ${remedy.lastConsult.outcome}`
          : "never"}
      </TableCell>
    </TableRow>
  );
}

/** `Lock · value`: the grey lock name, then what may be done about it. */
function Chip({ chip }: { chip: Omit<CoverChip, "lock"> & { lock: string } }) {
  return (
    <Badge variant="outline" className="gap-1 whitespace-nowrap font-normal">
      <span className="text-muted-foreground">{`${chip.lock} ·`}</span>
      <span className={cn(chip.code && "font-mono")}>{chip.value}</span>
    </Badge>
  );
}
