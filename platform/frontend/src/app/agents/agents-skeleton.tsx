import { PageLayout } from "@/components/page-layout";
import { PinnedTiles } from "@/components/pinned-tiles";
import { TableSectionHeading } from "@/components/table-section-heading";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// The Agents page before anything has loaded, drawn at the loaded page's
// sizes so nothing moves when the real parts replace it.

export const AGENTS_PAGE_DESCRIPTION =
  "Build and manage AI agents, and connect external A2A agents for them to use as subagents.";

export function AgentsPageSkeleton() {
  return (
    <div className="w-full h-full">
      <PageLayout
        title="Agents"
        description={
          <p className="text-sm text-muted-foreground">
            {AGENTS_PAGE_DESCRIPTION}
          </p>
        }
        actionButton={
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-28" />
            <Skeleton className="h-8 w-32" />
            <Skeleton className="size-8" />
          </div>
        }
      >
        <output aria-busy="true" aria-label="Loading agents" className="block">
          <div className="mb-3 flex flex-wrap gap-2">
            <Skeleton className="h-8 w-80" />
            <Skeleton className="h-8 w-52" />
            <Skeleton className="h-8 w-38" />
            <Skeleton className="h-8 w-21" />
          </div>
          <div className="space-y-6">
            <PinnedTiles tiles={[]} isLoading />
            <section className="space-y-3">
              <TableSectionHeading title="All agents" bulkActions={null} />
              <AgentsTableSkeleton />
            </section>
          </div>
        </output>
      </PageLayout>
    </div>
  );
}

/** The table while its first page loads: its columns, and rows to come. */
export function AgentsTableSkeleton({
  rows = 10,
  showEnvironment = false,
}: {
  rows?: number;
  /** The table adds this column when the organization has environments. */
  showEnvironment?: boolean;
}) {
  const columns = showEnvironment
    ? [...COLUMNS.slice(0, -1), ENVIRONMENT_COLUMN, ...COLUMNS.slice(-1)]
    : COLUMNS;
  return (
    <div className="w-full space-y-4">
      <div className="overflow-x-auto rounded-md border">
        <Table aria-busy="true">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-12" />
              <TableHead>Name</TableHead>
              {columns.map(({ label, width }) => (
                <TableHead key={label} className={width}>
                  {label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from({ length: rows }, (_, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
              <TableRow key={index} className="hover:bg-transparent">
                <TableCell>
                  <Skeleton className="size-4 rounded-sm" />
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Skeleton className="size-6 shrink-0" />
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <Skeleton className="h-4 w-40 max-w-full" />
                      <Skeleton className="h-3 w-64 max-w-full" />
                    </div>
                  </div>
                </TableCell>
                {columns.map(({ label }) => (
                  <TableCell key={label}>
                    <Skeleton className="h-4 w-10" />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="flex justify-end">
        <Skeleton className="h-8 w-80" />
      </div>
    </div>
  );
}

// ===

const COLUMNS = [
  { label: "Tools", width: "w-[90px]" },
  { label: "Subagents", width: "w-[100px]" },
  { label: "Last used", width: "w-[140px]" },
  { label: "Provider", width: "w-[96px]" },
  { label: "Actions", width: "w-[150px]" },
];

// Between Provider and Actions, as in the table.
const ENVIRONMENT_COLUMN = { label: "Environment", width: "w-[120px]" };
