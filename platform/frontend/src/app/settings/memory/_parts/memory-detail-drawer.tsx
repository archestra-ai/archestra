"use client";

import {
  Check,
  PackageMinus,
  PackageOpen,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import {
  useApproveMemory,
  useArchiveMemory,
  useDeleteMemory,
  useMemory,
  useUnarchiveMemory,
} from "@/lib/memory.query";
import {
  useActiveMemberRole,
  useActiveOrganization,
} from "@/lib/organization.query";
import { useTeams } from "@/lib/teams/team.query";
import { formatDate, formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import {
  canApproveMemoryByScope,
  getMemoryKindLabel,
  getMemoryPolicyFlagLabel,
  getMemoryScopeLabel,
  getMemoryStatusLabel,
  type MemoryListItem,
} from "./memory-utils";

export function MemoryDetailDrawer({
  memoryId,
  open,
  onOpenChange,
  onReject,
  onRepropose,
}: {
  memoryId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReject?: (item: MemoryListItem) => void;
  onRepropose?: (item: MemoryListItem) => void;
}) {
  const { data: memory, isPending } = useMemory(memoryId ?? "");
  const { data: session } = useSession();
  const { data: activeOrganization } = useActiveOrganization();
  const { data: activeMemberRole } = useActiveMemberRole(
    activeOrganization?.id,
  );
  const { data: teams = [] } = useTeams();
  const { data: canApprovePermission = false } = useHasPermissions({
    memory: ["approve"],
  });
  const { data: canUpdatePermission = false } = useHasPermissions({
    memory: ["update"],
  });
  const { data: canDeletePermission = false } = useHasPermissions({
    memory: ["delete"],
  });

  const approveMemory = useApproveMemory();
  const archiveMemory = useArchiveMemory();
  const unarchiveMemory = useUnarchiveMemory();
  const deleteMemory = useDeleteMemory();

  const currentUserId = session?.user?.id;
  const currentUserDisplayName =
    session?.user?.name ?? session?.user?.email ?? null;
  const reviewerRole = activeMemberRole ?? "member";
  const currentTeamIds = useMemo(() => teams.map((t) => t.id), [teams]);

  const scopeGuard = memory
    ? canApproveMemoryByScope({
        item: memory,
        currentUserId,
        currentRole: reviewerRole,
        organizationId: activeOrganization?.id,
        teamIds: currentTeamIds,
      })
    : false;

  const canApproveAction = canApprovePermission && scopeGuard;
  const canLifecycleAction = canUpdatePermission && scopeGuard;
  const canDeleteAction = canDeletePermission && scopeGuard;

  const reviewerDisplay = memory?.reviewedBy
    ? memory.reviewedBy === currentUserId && currentUserDisplayName
      ? currentUserDisplayName
      : `${memory.reviewedBy.slice(0, 8)}…`
    : "—";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Memory details</SheetTitle>
          <SheetDescription>
            Full metadata, source evidence, policy flags, and review history.
          </SheetDescription>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
          {isPending ? (
            <p className="text-sm text-muted-foreground">
              Loading memory details...
            </p>
          ) : !memory ? (
            <p className="text-sm text-muted-foreground">
              Memory item not found.
            </p>
          ) : (
            <>
              <section className="space-y-2">
                <h3 className="text-sm font-semibold">Content</h3>
                <p className="rounded-md border bg-muted/30 p-3 text-sm">
                  {memory.content}
                </p>
              </section>

              <Separator />

              <section className="space-y-2">
                <h3 className="text-sm font-semibold">Metadata</h3>
                <div className="grid grid-cols-[120px_1fr] gap-x-2 gap-y-1 text-sm">
                  <span className="text-muted-foreground">Scope</span>
                  <span>{getMemoryScopeLabel(memory.scopeType)}</span>

                  <span className="text-muted-foreground">Scope ID</span>
                  <span className="font-mono text-xs">{memory.scopeId}</span>

                  <span className="text-muted-foreground">Kind</span>
                  <span>{getMemoryKindLabel(memory.kind)}</span>

                  <span className="text-muted-foreground">Status</span>
                  <span>{getMemoryStatusLabel(memory.status)}</span>

                  <span className="text-muted-foreground">Confidence</span>
                  <span>{memory.confidenceBand ?? "Not set"}</span>

                  <span className="text-muted-foreground">Language</span>
                  <span>{memory.language ?? "Not set"}</span>

                  <span className="text-muted-foreground">Expires</span>
                  <span>
                    {memory.expiresAt
                      ? formatDate({ date: memory.expiresAt })
                      : "Never"}
                  </span>
                </div>
              </section>

              <Separator />

              <section className="space-y-2">
                <h3 className="text-sm font-semibold">Source Evidence</h3>
                {memory.sourceConversationId ? (
                  <Link
                    href={`/chat/${memory.sourceConversationId}`}
                    className="text-sm text-primary underline underline-offset-4"
                  >
                    Open source conversation
                  </Link>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No source conversation attached.
                  </p>
                )}
                {memory.sourceMessageIds?.length ? (
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">
                      Source message IDs
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {memory.sourceMessageIds.map((sourceMessageId) => (
                        <Badge
                          key={sourceMessageId}
                          variant="outline"
                          className="font-mono text-[11px]"
                        >
                          {sourceMessageId}
                        </Badge>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Source snippet is not available for this memory item.
                  </p>
                )}
              </section>

              <Separator />

              <section className="space-y-2">
                <h3 className="text-sm font-semibold">Policy Flags</h3>
                {memory.policyFlags.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {memory.policyFlags.map((flag) => (
                      <Badge key={flag} variant="secondary">
                        {getMemoryPolicyFlagLabel(flag)}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No policy flags.
                  </p>
                )}
              </section>

              <Separator />

              <section className="space-y-2">
                <h3 className="text-sm font-semibold">History</h3>
                <div className="grid grid-cols-[140px_1fr] gap-x-2 gap-y-1 text-sm">
                  <span className="text-muted-foreground">Created</span>
                  <span>{formatRelativeTimeFromNow(memory.createdAt)}</span>

                  <span className="text-muted-foreground">Updated</span>
                  <span>{formatRelativeTimeFromNow(memory.updatedAt)}</span>

                  <span className="text-muted-foreground">Reviewed</span>
                  <span>
                    {memory.reviewedAt
                      ? formatRelativeTimeFromNow(memory.reviewedAt)
                      : "Not reviewed"}
                  </span>

                  <span className="text-muted-foreground">Reviewer</span>
                  <span>{reviewerDisplay}</span>

                  <span className="text-muted-foreground">Last Verified</span>
                  <span>
                    {memory.lastVerifiedAt
                      ? formatRelativeTimeFromNow(memory.lastVerifiedAt)
                      : "Not verified"}
                  </span>

                  {memory.rejectionReason ? (
                    <>
                      <span className="text-muted-foreground">
                        Rejection Reason
                      </span>
                      <span>{memory.rejectionReason}</span>
                    </>
                  ) : null}
                  {memory.rejectionComment ? (
                    <>
                      <span className="text-muted-foreground">
                        Rejection Comment
                      </span>
                      <span>{memory.rejectionComment}</span>
                    </>
                  ) : null}
                </div>
              </section>

              <Separator />

              <section className="space-y-2">
                <h3 className="text-sm font-semibold">Actions</h3>
                <div className="flex flex-wrap gap-2">
                  {memory.status === "candidate" && (
                    <>
                      <Button
                        size="sm"
                        disabled={!canApproveAction || approveMemory.isPending}
                        onClick={() =>
                          void approveMemory.mutateAsync(memory.id)
                        }
                      >
                        <Check className="h-4 w-4" />
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!canApproveAction || !onReject}
                        onClick={() => onReject?.(memory as MemoryListItem)}
                      >
                        <X className="h-4 w-4" />
                        Reject
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          !canLifecycleAction || archiveMemory.isPending
                        }
                        onClick={() =>
                          void archiveMemory.mutateAsync(memory.id)
                        }
                        className="text-destructive hover:text-destructive"
                      >
                        <PackageMinus className="h-4 w-4" />
                        Archive
                      </Button>
                    </>
                  )}

                  {memory.status === "approved" && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          !canLifecycleAction || archiveMemory.isPending
                        }
                        onClick={() =>
                          void archiveMemory.mutateAsync(memory.id)
                        }
                      >
                        <PackageMinus className="h-4 w-4" />
                        Archive
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!onRepropose}
                        onClick={() => onRepropose?.(memory as MemoryListItem)}
                      >
                        <RotateCcw className="h-4 w-4" />
                        Re-propose
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!canApproveAction || !onReject}
                        onClick={() => onReject?.(memory as MemoryListItem)}
                      >
                        <X className="h-4 w-4" />
                        Reject
                      </Button>
                    </>
                  )}

                  {memory.status === "archived" && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          !canLifecycleAction || unarchiveMemory.isPending
                        }
                        onClick={() =>
                          void unarchiveMemory.mutateAsync(memory.id)
                        }
                      >
                        <PackageOpen className="h-4 w-4" />
                        Restore
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!onRepropose}
                        onClick={() => onRepropose?.(memory as MemoryListItem)}
                      >
                        <RotateCcw className="h-4 w-4" />
                        Re-propose
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={!canDeleteAction || deleteMemory.isPending}
                        onClick={async () => {
                          const result = await deleteMemory.mutateAsync(
                            memory.id,
                          );
                          if (result) onOpenChange(false);
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                        Delete
                      </Button>
                    </>
                  )}

                  {memory.status === "rejected" && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!onRepropose}
                        onClick={() => onRepropose?.(memory as MemoryListItem)}
                      >
                        <RotateCcw className="h-4 w-4" />
                        Re-propose
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          !canLifecycleAction || archiveMemory.isPending
                        }
                        onClick={() =>
                          void archiveMemory.mutateAsync(memory.id)
                        }
                        className="text-destructive hover:text-destructive"
                      >
                        <PackageMinus className="h-4 w-4" />
                        Archive
                      </Button>
                    </>
                  )}
                </div>
              </section>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
