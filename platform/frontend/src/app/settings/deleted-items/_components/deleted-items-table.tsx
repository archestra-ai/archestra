"use client";

import { ArchiveRestore } from "lucide-react";
import { useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { SettingsBlock } from "@/components/settings/settings-block";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  type DeletedItem,
  type DeletedItemEntityType,
  useDeletedItems,
  usePurgeDeletedItem,
  useRestoreDeletedItem,
} from "@/lib/deleted-items.query";

const ALL_TYPES = "all";
const PAGE_SIZE = 20;

const ENTITY_LABELS: Record<DeletedItemEntityType, string> = {
  agent: "Agent",
  app: "App",
  conversation: "Chat",
  project: "Project",
  skill: "Skill",
};

export function DeletedItemsTable() {
  const [entityType, setEntityType] = useState<
    DeletedItemEntityType | typeof ALL_TYPES
  >(ALL_TYPES);
  const [page, setPage] = useState(0);
  const [pendingPurge, setPendingPurge] = useState<DeletedItem | null>(null);

  const { data, isPending, isLoadingError, refetch } = useDeletedItems({
    entityTypes: entityType === ALL_TYPES ? undefined : [entityType],
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });

  const restore = useRestoreDeletedItem();
  const purge = usePurgeDeletedItem();

  const items = data?.data ?? [];
  const pagination = data?.pagination;

  return (
    <>
      <SettingsBlock
        title="Deleted items"
        description="Everything deleted in this organization that has not been cleaned up yet."
        control={
          <Select
            value={entityType}
            onValueChange={(value) => {
              setEntityType(value as DeletedItemEntityType | typeof ALL_TYPES);
              setPage(0);
            }}
          >
            <SelectTrigger aria-label="Filter by type" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_TYPES}>All types</SelectItem>
              {Object.entries(ENTITY_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}s
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      >
        {isLoadingError ? (
          <div className="py-8 text-center">
            <p className="text-sm text-muted-foreground">
              Could not load deleted items.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => refetch()}
            >
              Try again
            </Button>
          </div>
        ) : isPending ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Loading…
          </p>
        ) : items.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {entityType === ALL_TYPES
              ? "Nothing has been deleted."
              : `No deleted ${ENTITY_LABELS[entityType].toLowerCase()}s.`}
          </p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Deleted</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={`${item.entityType}:${item.id}`}>
                    <TableCell className="font-medium">
                      {item.name || <span className="italic">Untitled</span>}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">
                        {ENTITY_LABELS[item.entityType]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDeletedAt(item.deletedAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        {item.restorable && (
                          <PermissionButton
                            permissions={{ organizationSettings: ["update"] }}
                            variant="outline"
                            size="sm"
                            disabled={restore.isPending}
                            onClick={() =>
                              restore.mutate({
                                entityType: item.entityType,
                                id: item.id,
                              })
                            }
                          >
                            <ArchiveRestore className="size-4" />
                            Restore
                          </PermissionButton>
                        )}
                        <PermissionButton
                          permissions={{ organizationSettings: ["update"] }}
                          variant="outline"
                          size="sm"
                          onClick={() => setPendingPurge(item)}
                        >
                          Delete permanently
                        </PermissionButton>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {pagination && pagination.totalPages > 1 && (
              <div className="mt-4 flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  Page {pagination.currentPage} of {pagination.totalPages}
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!pagination.hasPrev}
                    onClick={() => setPage((current) => current - 1)}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!pagination.hasNext}
                    onClick={() => setPage((current) => current + 1)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </SettingsBlock>

      <DeleteConfirmDialog
        open={pendingPurge !== null}
        onOpenChange={(open) => !open && setPendingPurge(null)}
        title="Delete permanently?"
        description={purgeDescription(pendingPurge)}
        confirmLabel="Delete permanently"
        isPending={purge.isPending}
        onConfirm={() => {
          if (!pendingPurge) return;
          purge.mutate(
            { entityType: pendingPurge.entityType, id: pendingPurge.id },
            { onSuccess: () => setPendingPurge(null) },
          );
        }}
      />
    </>
  );
}

function purgeDescription(item: DeletedItem | null) {
  if (!item) return "";
  const label = ENTITY_LABELS[item.entityType].toLowerCase();
  const name = item.name ? `"${item.name}"` : `this ${label}`;
  return `Permanently delete ${name}, along with any files it stored. This cannot be undone.`;
}

function formatDeletedAt(deletedAt: string): string {
  const date = new Date(deletedAt);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
