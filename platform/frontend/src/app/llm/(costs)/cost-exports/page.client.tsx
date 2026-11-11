"use client";

import type { Permissions } from "@archestra/shared";
import { FileSpreadsheet, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  type CostExport,
  useCostExports,
  useDeleteCostExport,
  useRunCostExport,
} from "@/lib/cost-export.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { useSetCostsAction } from "../layout";
import { CostExportDialog } from "./_parts/cost-export-dialog";

const EDIT: Permissions = {
  llmCost: ["read"],
  organizationSettings: ["update"],
};

export default function CostExportsPageClient() {
  const setActionButton = useSetCostsAction();
  const { data: exports = [], isLoading } = useCostExports();
  const [editing, setEditing] = useState<CostExport | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState<CostExport | null>(null);
  const remove = useDeleteCostExport();
  const run = useRunCostExport();

  useEffect(() => {
    setActionButton(
      <PermissionButton
        permissions={EDIT}
        size="sm"
        onClick={() => {
          setEditing(null);
          setDialogOpen(true);
        }}
      >
        <Plus className="h-4 w-4" />
        Schedule export
      </PermissionButton>,
    );
    return () => setActionButton(null);
  }, [setActionButton]);

  return (
    <div className="space-y-4">
      {!isLoading && exports.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileSpreadsheet />
            </EmptyMedia>
            <EmptyTitle>No cost exports yet</EmptyTitle>
            <EmptyDescription>
              Send hourly or daily FOCUS cost and usage files to your own
              bucket, for the FinOps tools you already use.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <PermissionButton
              permissions={EDIT}
              size="sm"
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
            >
              <Plus className="h-4 w-4" />
              Schedule export
            </PermissionButton>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Destination</TableHead>
                <TableHead>Schedule</TableHead>
                <TableHead className="w-72">Last run</TableHead>
                <TableHead className="w-44" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {exports.map((costExport) => (
                <TableRow key={costExport.id}>
                  <TableCell className="font-medium">
                    <span>{costExport.name}</span>
                    {!costExport.enabled && (
                      <Badge variant="outline" className="ml-2">
                        Paused
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">
                    <span>{costExport.blobProviderName}</span>
                    <span className="block font-mono text-xs text-muted-foreground">
                      {costExport.pathPrefix || "/"}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm capitalize">
                    {costExport.schedule}
                  </TableCell>
                  <TableCell className="text-sm">
                    <LastRun costExport={costExport} />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <PermissionButton
                        permissions={EDIT}
                        variant="outline"
                        size="xs"
                        disabled={run.isPending}
                        onClick={() => run.mutate(costExport.id)}
                      >
                        <Play className="h-3.5 w-3.5" />
                        <span>
                          {run.isPending && run.variables === costExport.id
                            ? "Running…"
                            : "Run now"}
                        </span>
                      </PermissionButton>
                      <PermissionButton
                        permissions={EDIT}
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Edit ${costExport.name}`}
                        onClick={() => {
                          setEditing(costExport);
                          setDialogOpen(true);
                        }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </PermissionButton>
                      <PermissionButton
                        permissions={EDIT}
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Delete ${costExport.name}`}
                        onClick={() => setDeleting(costExport)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </PermissionButton>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <CostExportDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        costExport={editing}
      />
      <DeleteConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete cost export"
        description={`Stop ${deleting?.name ?? "this export"}? Files already written stay in the bucket.`}
        isPending={remove.isPending}
        onConfirm={() => {
          if (!deleting) return;
          remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) });
        }}
      />
    </div>
  );
}

function LastRun({ costExport }: { costExport: CostExport }) {
  if (!costExport.lastRunAt) {
    return (
      <span className="block whitespace-normal text-muted-foreground">
        Not yet. The first file starts at{" "}
        {new Date(costExport.exportedThrough).toLocaleString()}.
      </span>
    );
  }
  const failed = costExport.lastRunStatus === "failed";
  return (
    <div className="min-w-0 space-y-1 whitespace-normal">
      <div className="flex items-center gap-2">
        <Badge variant={failed ? "destructive" : "secondary"}>
          {failed ? "Failed" : "Succeeded"}
        </Badge>
        <span className="text-muted-foreground">
          {formatRelativeTimeFromNow(costExport.lastRunAt)}
        </span>
      </div>
      {failed && costExport.lastRunError ? (
        <p className="line-clamp-3 break-words text-xs text-destructive">
          {costExport.lastRunError}
        </p>
      ) : costExport.lastObjectKey ? (
        <p
          className="truncate font-mono text-xs text-muted-foreground"
          title={costExport.lastObjectKey}
        >
          {costExport.lastObjectKey.split("/").at(-1)}
        </p>
      ) : null}
    </div>
  );
}
