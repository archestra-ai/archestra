"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useMemory } from "@/lib/memory.query";
import { formatDate, formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import {
  getMemoryKindLabel,
  getMemoryPolicyFlagLabel,
  getMemoryScopeLabel,
  getMemoryStatusLabel,
} from "./memory-utils";

export function MemoryDetailDrawer({
  memoryId,
  open,
  onOpenChange,
}: {
  memoryId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: memory, isPending } = useMemory(memoryId ?? "");

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
                  <span className="font-mono text-xs">
                    {memory.reviewedBy ?? "—"}
                  </span>

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
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
