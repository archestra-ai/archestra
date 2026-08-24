"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { KeyRound, Laptop, LogOut, Smartphone, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { UAParser } from "ua-parser-js";
import { QueryLoadError } from "@/components/query-load-error";
import { TableRowActions } from "@/components/table-row-actions";
import { BulkActionsBar } from "@/components/ui/bulk-actions-bar";
import { createSelectColumn } from "@/components/ui/bulk-select-column";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { useSession } from "@/lib/auth/auth.query";
import {
  StaleSessionError,
  useBulkRevokeSessions,
  useListSessions,
  useRevokeSessionMutation,
} from "@/lib/auth/sessions.query";
import { reportBulkOutcome } from "@/lib/bulk-action";
import { useBulkSelection } from "@/lib/hooks/use-bulk-selection";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";

type AccountSession = NonNullable<
  ReturnType<typeof useListSessions>["data"]
>[number];

/**
 * The account's active sessions, as a table so it reads like every other list
 * in settings. Other sessions can be revoked individually or in a batch;
 * revoking the current one signs the user out and so stays a row action.
 */
export function SessionsCard() {
  const router = useRouter();
  const { data: session } = useSession();
  // isLoadingError, not isError: a failed background refetch keeps the last
  // good list on screen rather than replacing a working card with an error.
  const {
    data: sessions,
    isFetching,
    isLoadingError,
    error,
    refetch,
  } = useListSessions();
  const revokeSession = useRevokeSessionMutation();
  const bulkRevoke = useBulkRevokeSessions();

  const currentSessionId = session?.session?.id;
  const isCurrent = (row: AccountSession) => row.id === currentSessionId;

  const rows = sessions ?? [];
  const {
    rowSelection,
    setRowSelection,
    onPageRowIdsChange,
    clearSelection,
    selected,
    selectAllMatching,
  } = useBulkSelection({
    rows,
    getId: (row) => row.id,
    canSelect: (row) => !isCurrent(row),
    // Sessions carry no filters, so the escalation never needs invalidating.
    filterSignature: "sessions",
    matchDescription: "your account is signed in to",
  });

  const selectedSessions = selected.map((row) => ({
    token: row.token,
    label: row.ipAddress ?? describeUserAgent(row.userAgent).label,
  }));

  const columns: ColumnDef<AccountSession>[] = [
    createSelectColumn<AccountSession>({
      rowLabel: (row) => `Select session ${row.ipAddress ?? row.id}`,
      allLabel: "Select all sessions on this page",
      // Signing yourself out is the row's own action; doing it inside a batch
      // would kill the request revoking the rest.
      canSelect: (row) => !isCurrent(row),
      disabledReason: () => "Use Sign out for your current session",
    }),
    {
      id: "device",
      header: "Device",
      size: 320,
      cell: ({ row }) => {
        const { deviceType, label } = describeUserAgent(row.original.userAgent);
        return (
          <div className="flex items-center gap-3">
            {deviceType === "mobile" ? (
              <Smartphone className="h-4 w-4 shrink-0 text-muted-foreground" />
            ) : (
              <Laptop className="h-4 w-4 shrink-0 text-muted-foreground" />
            )}
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">
                {isCurrent(row.original)
                  ? "Current session"
                  : (row.original.ipAddress ?? "Unknown")}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {label}
              </div>
            </div>
          </div>
        );
      },
    },
    {
      id: "signed-in",
      header: "Signed in",
      size: 130,
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {formatRelativeTimeFromNow(row.original.createdAt)}
        </span>
      ),
    },
    {
      id: "expires",
      header: "Expires",
      size: 130,
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {formatRelativeTimeFromNow(row.original.expiresAt)}
        </span>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      size: 90,
      cell: ({ row }) => (
        <TableRowActions
          itemName={row.original.ipAddress ?? "this session"}
          actions={[
            {
              icon: isCurrent(row.original) ? (
                <LogOut className="h-4 w-4" />
              ) : (
                <Trash2 className="h-4 w-4" />
              ),
              label: isCurrent(row.original) ? "Sign out" : "Revoke",
              variant: "destructive" as const,
              disabled: revokeSession.isPending,
              onClick: () => {
                if (isCurrent(row.original)) {
                  router.push("/auth/sign-out");
                  return;
                }
                revokeSession.mutate({ token: row.original.token });
              },
            },
          ]}
        />
      ),
    },
  ];

  return (
    <section className="w-full space-y-5">
      <div className="space-y-1">
        <h2 className="text-sm font-medium leading-5">Sessions</h2>
        <p className="text-sm leading-5 text-muted-foreground">
          Manage where your account is signed in.
        </p>
      </div>
      {isLoadingError && error instanceof StaleSessionError ? (
        <Empty className="py-6">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <KeyRound />
            </EmptyMedia>
            <EmptyTitle>Sign in again to manage your sessions</EmptyTitle>
            <EmptyDescription>
              {/* 24 hours mirrors Better Auth's session.freshAge default,
                    pinned by backend/src/auth/list-sessions-freshness.test.ts */}
              For your security, this list is only available for the first 24
              hours after you sign in. Sign out and back in to see where your
              account is signed in.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              variant="outline"
              onClick={() => router.push("/auth/sign-out")}
            >
              Sign Out
            </Button>
          </EmptyContent>
        </Empty>
      ) : isLoadingError ? (
        <QueryLoadError
          className="py-6"
          title="Couldn't load your sessions"
          onRetry={() => refetch()}
        />
      ) : (
        <>
          <BulkActionsBar
            count={selectedSessions.length}
            noun="session"
            onClear={clearSelection}
            selectAllMatching={selectAllMatching}
            busy={bulkRevoke.isPending}
            className="mb-3"
          >
            <Button
              variant="destructive"
              size="sm"
              onClick={() =>
                bulkRevoke.mutate(selectedSessions, {
                  onSuccess: (outcome) => {
                    reportBulkOutcome({
                      outcome,
                      verb: "Revoked",
                      failureVerb: "revoke",
                      noun: "session",
                    });
                    if (outcome.failed.length === 0) clearSelection();
                  },
                })
              }
            >
              <span>Revoke</span>
            </Button>
          </BulkActionsBar>

          <DataTable
            columns={columns}
            data={rows}
            getRowId={(row) => row.id}
            rowSelection={rowSelection}
            onRowSelectionChange={setRowSelection}
            onPageRowIdsChange={onPageRowIdsChange}
            hideSelectedCount
            isLoading={isFetching}
            emptyMessage="No active sessions."
            hidePaginationWhenSinglePage
            fixedWidthColumnIds={["signed-in", "expires", "actions"]}
            flexibleColumnIds={["device"]}
          />
        </>
      )}
    </section>
  );
}

function describeUserAgent(userAgent: string | null | undefined): {
  deviceType: "mobile" | "desktop";
  label: string;
} {
  if (!userAgent) {
    return { deviceType: "desktop", label: "Unknown device" };
  }

  const parsed = UAParser(userAgent);
  const parts = [parsed.os.name, parsed.browser.name].filter(Boolean);

  return {
    deviceType: parsed.device.type === "mobile" ? "mobile" : "desktop",
    label: parts.length > 0 ? parts.join(", ") : userAgent,
  };
}
