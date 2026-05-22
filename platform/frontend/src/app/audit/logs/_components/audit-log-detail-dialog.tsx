"use client";

import type { ReactNode } from "react";
import { useMemo } from "react";
import { CopyButton } from "@/components/copy-button";
import { FormDialog } from "@/components/form-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DialogStickyFooter } from "@/components/ui/dialog";
import type { AuditLog } from "@/lib/audit-log/audit-log.query";
import { formatDate, formatRelativeTimeFromNow } from "@/lib/utils";
import {
  ACTION_BADGE_VARIANT,
  ACTOR_TYPE_LABEL,
  formatAction,
  formatResourceType,
  OUTCOME_BADGE_VARIANT,
  OUTCOME_LABEL,
} from "./audit-log-action-labels";
import {
  AuditLogDiffView,
  summarizeAuditDiffHints,
} from "./audit-log-diff-view";

interface AuditLogDetailDialogProps {
  event: AuditLog | null;
  onClose: () => void;
}

export function AuditLogDetailDialog({
  event,
  onClose,
}: AuditLogDetailDialogProps) {
  const open = event !== null;

  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Event details"
      size="large"
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {event && <AuditLogDetailBody event={event} />}
      </div>
      <DialogStickyFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Close
        </Button>
      </DialogStickyFooter>
    </FormDialog>
  );
}

function AuditLogDetailBody({ event }: { event: AuditLog }) {
  const isAuthEvent = event.resourceType === "auth";
  const diffSummary = useMemo(
    () => summarizeAuditDiffHints(event.before ?? null, event.after ?? null),
    [event],
  );

  return (
    <div className="space-y-6">
      <DetailGrid>
        <DetailRow label="When">
          <WhenBlock event={event} />
        </DetailRow>

        <DetailRow label="Actor">
          <ActorBlock event={event} />
        </DetailRow>

        <DetailRow label="Action">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={ACTION_BADGE_VARIANT[event.action]}>
              {formatAction(event.action)}
            </Badge>
            <Badge variant={OUTCOME_BADGE_VARIANT[event.outcome]}>
              {OUTCOME_LABEL[event.outcome]}
            </Badge>
          </div>
        </DetailRow>

        <DetailRow label="Resource">
          <ResourceBlock event={event} />
        </DetailRow>

        {!isAuthEvent && (
          <DetailRow label="Where">
            <WhereBlock event={event} />
          </DetailRow>
        )}

        <DetailRow label="Source">
          <SourceBlock event={event} />
        </DetailRow>
      </DetailGrid>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">Changes</h3>
        {diffSummary && (
          <p className="text-xs text-muted-foreground">{diffSummary}</p>
        )}
        <AuditLogDiffView
          before={event.before ?? null}
          after={event.after ?? null}
        />
      </section>
    </div>
  );
}

// === Internal helpers

function DetailGrid({ children }: { children: ReactNode }) {
  return (
    <dl className="grid grid-cols-1 gap-y-4 sm:grid-cols-[140px_minmax(0,1fr)] sm:gap-x-6">
      {children}
    </dl>
  );
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </>
  );
}

function WhenBlock({ event }: { event: AuditLog }) {
  const occurredTs = new Date(event.occurredAt).getTime();
  const createdTs = new Date(event.createdAt).getTime();
  const isSame = occurredTs === createdTs;

  return (
    <div className="space-y-2">
      <div>
        <div className="text-xs text-muted-foreground uppercase tracking-wide mb-0.5">
          Occurred
        </div>
        <div className="font-mono text-xs">
          {formatDate({ date: event.occurredAt })}
        </div>
        <div className="text-xs text-muted-foreground">
          {formatRelativeTimeFromNow(event.occurredAt)}
        </div>
      </div>
      <div>
        <div className="text-xs text-muted-foreground uppercase tracking-wide mb-0.5">
          Recorded
        </div>
        {isSame ? (
          <div className="text-xs text-muted-foreground italic">
            same as occurred
          </div>
        ) : (
          <div className="font-mono text-xs">
            {formatDate({ date: event.createdAt })}
          </div>
        )}
      </div>
    </div>
  );
}

function ActorBlock({ event }: { event: AuditLog }) {
  const { actorName, actorEmail, actorType } = event;
  if (!actorName && !actorEmail) {
    return <span className="text-muted-foreground">Deleted user</span>;
  }
  return (
    <div className="space-y-0.5">
      {actorName && <div>{actorName}</div>}
      {actorEmail && (
        <div className="text-xs text-muted-foreground">{actorEmail}</div>
      )}
      <div className="text-xs text-muted-foreground">
        {ACTOR_TYPE_LABEL[actorType]}
      </div>
    </div>
  );
}

function ResourceBlock({ event }: { event: AuditLog }) {
  if (!event.resourceType && !event.resourceId) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {event.resourceType && (
        <Badge variant="secondary">
          {formatResourceType(event.resourceType)}
        </Badge>
      )}
      {event.resourceId && (
        <code className="break-all font-mono text-xs">{event.resourceId}</code>
      )}
    </div>
  );
}

function WhereBlock({ event }: { event: AuditLog }) {
  return (
    <div className="space-y-1 text-xs">
      {event.httpMethod && event.httpPath && (
        <div>
          <Badge variant="outline" className="mr-2 font-mono">
            {event.httpMethod}
          </Badge>
          <code className="break-all font-mono">{event.httpPath}</code>
        </div>
      )}
      {event.httpRoute && (
        <div className="text-muted-foreground">
          Route: <code className="font-mono">{event.httpRoute}</code>
        </div>
      )}
      {event.httpStatus !== null && (
        <div className="text-muted-foreground">
          Status: <code className="font-mono">{event.httpStatus}</code>
        </div>
      )}
      {event.requestId && (
        <div className="flex items-center gap-1 text-muted-foreground">
          <span>Request ID:</span>
          <code className="font-mono">{event.requestId}</code>
          <CopyButton text={event.requestId} size={12} />
        </div>
      )}
    </div>
  );
}

function SourceBlock({ event }: { event: AuditLog }) {
  if (!event.sourceIp && !event.userAgent) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <div className="space-y-1 text-xs">
      {event.sourceIp && (
        <div>
          IP: <code className="font-mono">{event.sourceIp}</code>
        </div>
      )}
      {event.userAgent && (
        <div className="break-all text-muted-foreground">{event.userAgent}</div>
      )}
    </div>
  );
}
