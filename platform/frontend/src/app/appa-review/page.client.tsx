"use client";

import type { Permissions } from "@archestra/shared";
import { AlertTriangle, Check, Eye, ShieldAlert, X } from "lucide-react";
import { useEffect, useState } from "react";
import { JsonCodeBlock } from "@/components/json-code-block";
import { QueryLoadError } from "@/components/query-load-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  useAcknowledgeAppaQuarantine,
  useAppaApprovals,
  useAppaQuarantine,
  useAppaQuarantines,
  useDecideAppaApproval,
} from "@/lib/appa-review.query";

const REVIEW_PERMISSION: Permissions = { agentSettings: ["update"] };

export default function AppaReviewPage() {
  const [selectedQuarantineId, setSelectedQuarantineId] = useState<
    string | null
  >(null);
  const approvals = useAppaApprovals();
  const quarantines = useAppaQuarantines();
  const decideApproval = useDecideAppaApproval();
  const now = useApprovalExpiryClock(approvals.data);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 md:p-8">
      <header className="space-y-2">
        <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <ShieldAlert className="size-4" />
          <span>Operator controls</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">
          OpenAPPA review
        </h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Approve or deny only the exact pending action shown below. Quarantined
          sessions remain restricted: this page records investigation, not a
          retry, reset, or recovery.
        </p>
      </header>

      <section className="space-y-3" aria-labelledby="approvals-heading">
        <div className="flex items-center gap-2">
          <h2 id="approvals-heading" className="text-lg font-semibold">
            Approval requests
          </h2>
          <Badge variant="secondary">{approvals.data?.length ?? 0}</Badge>
        </div>
        {approvals.isError ? (
          <QueryLoadError
            title="Couldn't load approval requests"
            onRetry={() => approvals.refetch()}
          />
        ) : approvals.isPending ? (
          <ReviewLoading />
        ) : approvals.data?.length === 0 ? (
          <EmptyState message="No approval requests are available for profiles you can review." />
        ) : (
          <div className="grid gap-4">
            {approvals.data?.map((approval) => {
              const isPending =
                approval.status === "pending" &&
                new Date(approval.expiresAt).getTime() > now;
              const status =
                approval.status === "pending" && !isPending
                  ? "expired"
                  : approval.status;
              return (
                <Card key={approval.id} data-testid={`approval-${approval.id}`}>
                  <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="space-y-1">
                      <CardTitle className="font-mono text-base">
                        {approval.tool}
                      </CardTitle>
                      <p className="text-sm text-muted-foreground">
                        Requested {formatTime(approval.createdAt)}. Expires{" "}
                        {formatTime(approval.expiresAt)}.
                      </p>
                    </div>
                    <ApprovalStatus status={status} />
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div>
                      <p className="text-sm font-medium">Exact arguments</p>
                      <p className="text-xs text-muted-foreground">
                        The decision applies only to this normalized action.
                      </p>
                      <JsonCodeBlock
                        value={approval.args}
                        maxHeightClassName="max-h-64 overflow-auto"
                      />
                    </div>
                    {isPending ? (
                      <div className="flex flex-wrap gap-2">
                        <PermissionButton
                          permissions={REVIEW_PERMISSION}
                          variant="default"
                          disabled={decideApproval.isPending}
                          tooltip="Records approval for this exact action only"
                          onClick={() => {
                            if (
                              new Date(approval.expiresAt).getTime() <=
                              Date.now()
                            ) {
                              return;
                            }
                            decideApproval.mutate({
                              id: approval.id,
                              decision: "approve",
                            });
                          }}
                        >
                          <Check className="size-4" />
                          <span>Approve action</span>
                        </PermissionButton>
                        <PermissionButton
                          permissions={REVIEW_PERMISSION}
                          variant="outline"
                          disabled={decideApproval.isPending}
                          tooltip="Prevents this pending action from being approved"
                          onClick={() => {
                            if (
                              new Date(approval.expiresAt).getTime() <=
                              Date.now()
                            ) {
                              return;
                            }
                            decideApproval.mutate({
                              id: approval.id,
                              decision: "deny",
                            });
                          }}
                        >
                          <X className="size-4" />
                          <span>Deny action</span>
                        </PermissionButton>
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        This request is no longer actionable.
                      </p>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      <section className="space-y-3" aria-labelledby="quarantines-heading">
        <div className="flex items-center gap-2">
          <h2 id="quarantines-heading" className="text-lg font-semibold">
            Quarantined sessions
          </h2>
          <Badge variant="destructive">{quarantines.data?.length ?? 0}</Badge>
        </div>
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="flex gap-3 pt-6 text-sm text-muted-foreground">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
            <p>
              A remote result was not proven. Payloads, credentials, and proxy
              correlation data are never displayed here. Recording an
              acknowledgment or reconciliation does not release the quarantine.
            </p>
          </CardContent>
        </Card>
        {quarantines.isError ? (
          <QueryLoadError
            title="Couldn't load quarantined sessions"
            onRetry={() => quarantines.refetch()}
          />
        ) : quarantines.isPending ? (
          <ReviewLoading />
        ) : quarantines.data?.length === 0 ? (
          <EmptyState message="No quarantined sessions are available for profiles you can review." />
        ) : (
          <div className="grid gap-3">
            {quarantines.data?.map((quarantine) => (
              <Card
                key={quarantine.id}
                data-testid={`quarantine-row-${quarantine.id}`}
              >
                <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="space-y-1">
                    <p className="font-medium">Remote outcome unknown</p>
                    <p className="text-sm text-muted-foreground">
                      Quarantined {formatTime(quarantine.updatedAt)}
                    </p>
                    <p className="font-mono text-xs text-muted-foreground">
                      Quarantine ID: {quarantine.id}
                    </p>
                    <p className="font-mono text-xs text-muted-foreground">
                      Profile ID: {quarantine.profileId}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    aria-label={`Inspect quarantine ${quarantine.id}`}
                    aria-controls={`quarantine-detail-${quarantine.id}`}
                    aria-pressed={selectedQuarantineId === quarantine.id}
                    data-testid={`inspect-quarantine-${quarantine.id}`}
                    onClick={() => setSelectedQuarantineId(quarantine.id)}
                  >
                    <Eye className="size-4" />
                    <span>Inspect safely</span>
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
        <QuarantineDetail id={selectedQuarantineId} />
      </section>
    </main>
  );
}

function QuarantineDetail({ id }: { id: string | null }) {
  const quarantine = useAppaQuarantine(id);
  const acknowledge = useAcknowledgeAppaQuarantine();

  if (!id) return null;
  if (quarantine.isError) {
    return (
      <QueryLoadError
        title="Couldn't load quarantine details"
        onRetry={() => quarantine.refetch()}
      />
    );
  }
  if (quarantine.isPending || !quarantine.data) return <ReviewLoading />;

  return (
    <Card
      id={`quarantine-detail-${id}`}
      data-testid={`quarantine-detail-${id}`}
      className="border-amber-500/40"
    >
      <CardHeader>
        <CardTitle>Safe inspection record</CardTitle>
        <p className="text-sm text-muted-foreground">
          The session is still quarantined. No execution control is available.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">State</dt>
            <dd className="font-medium">Quarantined</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Detected</dt>
            <dd className="font-medium">
              {formatTime(quarantine.data.updatedAt)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Quarantine ID</dt>
            <dd className="break-all font-mono text-xs">
              {quarantine.data.id}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Profile ID</dt>
            <dd className="break-all font-mono text-xs">
              {quarantine.data.profileId}
            </dd>
          </div>
        </dl>
        <div className="space-y-3">
          <div>
            <h3 className="text-sm font-medium">Recorded action summary</h3>
            <p className="text-xs text-muted-foreground">
              Ledger metadata only. Arguments, outputs, and execution controls
              are not available.
            </p>
          </div>
          {quarantine.data.actions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No action summaries were retained for this quarantine.
            </p>
          ) : (
            <div className="grid gap-2">
              {quarantine.data.actions.map((action) => (
                <div
                  key={action.callRef}
                  className="rounded-md border p-3 text-sm"
                  data-testid={`quarantine-action-${action.callRef}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-mono font-medium">{action.tool}</p>
                    <Badge variant="outline">{action.state}</Badge>
                  </div>
                  <dl className="mt-2 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                    <div>
                      <dt>Outcome status</dt>
                      <dd className="font-medium text-foreground">
                        {action.outcome ?? "Not recorded"}
                      </dd>
                    </div>
                    <div>
                      <dt>Opaque call reference</dt>
                      <dd className="break-all font-mono">{action.callRef}</dd>
                    </div>
                    <div>
                      <dt>Created</dt>
                      <dd>{formatTime(action.createdAt)}</dd>
                    </div>
                    <div>
                      <dt>Updated</dt>
                      <dd>{formatTime(action.updatedAt)}</dd>
                    </div>
                  </dl>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <PermissionButton
            permissions={REVIEW_PERMISSION}
            variant="outline"
            disabled={acknowledge.isPending}
            tooltip="Records that the quarantine was reviewed; it remains restricted"
            onClick={() =>
              acknowledge.mutate({ id, acknowledgment: "acknowledged" })
            }
          >
            <Check className="size-4" />
            <span>Record acknowledgment</span>
          </PermissionButton>
          <PermissionButton
            permissions={REVIEW_PERMISSION}
            variant="outline"
            disabled={acknowledge.isPending}
            tooltip="Records external reconciliation; it does not resume execution"
            onClick={() =>
              acknowledge.mutate({ id, acknowledgment: "reconciled" })
            }
          >
            <ShieldAlert className="size-4" />
            <span>Record reconciliation</span>
          </PermissionButton>
        </div>
      </CardContent>
    </Card>
  );
}

function ApprovalStatus({ status }: { status: string }) {
  const variant =
    status === "approved"
      ? "default"
      : status === "pending"
        ? "secondary"
        : "outline";
  return <Badge variant={variant}>{status}</Badge>;
}

function EmptyState({ message }: { message: string }) {
  return (
    <Card>
      <CardContent className="py-8 text-sm text-muted-foreground">
        {message}
      </CardContent>
    </Card>
  );
}

function ReviewLoading() {
  return (
    <Card>
      <CardContent className="py-8 text-sm text-muted-foreground">
        <span>Loading review records...</span>
      </CardContent>
    </Card>
  );
}

function formatTime(value: Date | string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function useApprovalExpiryClock(
  approvals:
    | ReadonlyArray<{ id: string; status: string; expiresAt: string }>
    | undefined,
) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    const nextExpiry = Math.min(
      ...(approvals ?? [])
        .filter((approval) => approval.status === "pending")
        .map((approval) => new Date(approval.expiresAt).getTime())
        .filter((expiresAt) => expiresAt > Date.now()),
    );
    if (!Number.isFinite(nextExpiry)) return;

    const timeout = window.setTimeout(
      () => setNow(Date.now()),
      Math.max(0, nextExpiry - Date.now()) + 1,
    );
    return () => window.clearTimeout(timeout);
  }, [approvals]);

  return now;
}
