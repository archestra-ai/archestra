// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { Bot, UserRound, Users } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useMembersPaginated } from "@/lib/member.query";
import { useServiceAccounts } from "@/lib/service-account.query";
import { useTeams } from "@/lib/teams/team.query";

type Role = archestraApiTypes.GetRoleResponses["200"];

const PAGE_SIZE = 20;

/**
 * Who holds the role: the teams that pass it to their members, the users it
 * is assigned to directly, and the service accounts that act with it. Users
 * come a page at a time, since an organization's default role is held by
 * nearly everyone.
 */
export function RoleUsage({ role }: { role: Role }) {
  const { data: teams, isPending: teamsPending } = useTeams({
    includeRelations: false,
  });
  const { data: accounts, isPending: accountsPending } = useServiceAccounts();
  const [page, setPage] = useState(0);
  const { data: members, isPending: membersPending } = useMembersPaginated({
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    role: role.role,
  });
  const holdingTeams = (teams ?? []).filter((team) =>
    team.roles?.includes(role.role),
  );
  const holdingAccounts = (accounts ?? []).filter((account) =>
    account.role.split(",").includes(role.role),
  );
  const total = members?.pagination.total ?? 0;
  const pageCount = members?.pagination.totalPages ?? 0;

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Assign the role from a user's row in Users, a team's inherited roles, or
        a service account.
      </p>
      <UsageGroup
        icon={Users}
        title="Teams"
        count={holdingTeams.length}
        pending={teamsPending}
        empty="No team passes this role to its members."
        rows={holdingTeams.map((team) => ({
          id: team.id,
          name: team.name,
          detail: team.description || "Grants the role to its members",
        }))}
      />
      <UsageGroup
        icon={UserRound}
        title="Users"
        count={total}
        pending={membersPending}
        empty="No user holds this role directly."
        rows={(members?.data ?? []).map((member) => ({
          id: member.id,
          name: member.name || member.email,
          detail: member.name ? member.email : "",
        }))}
        pager={
          pageCount > 1 ? (
            <div className="flex items-center justify-between gap-3 bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
              <span>
                Page {page + 1} of {pageCount}
              </span>
              <div className="flex gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={page === 0}
                  onClick={() => setPage((current) => current - 1)}
                >
                  Previous
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={page + 1 >= pageCount}
                  onClick={() => setPage((current) => current + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          ) : null
        }
      />
      <UsageGroup
        icon={Bot}
        title="Service accounts"
        count={holdingAccounts.length}
        pending={accountsPending}
        empty="No service account acts with this role."
        rows={holdingAccounts.map((account) => ({
          id: account.id,
          name: account.name,
          detail: account.disabled ? "Disabled" : "",
        }))}
      />
    </div>
  );
}

function UsageGroup({
  icon: Icon,
  title,
  count,
  pending,
  empty,
  rows,
  pager,
}: {
  icon: typeof Users;
  title: string;
  count: number;
  pending: boolean;
  empty: string;
  rows: Array<{ id: string; name: string; detail: string }>;
  pager?: React.ReactNode;
}) {
  return (
    <section aria-label={title} className="space-y-2">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
        <span>{title}</span>
        {!pending && (
          <span className="font-normal text-muted-foreground tabular-nums">
            {count}
          </span>
        )}
      </h3>
      {pending ? (
        <Skeleton className="h-10 w-full" />
      ) : rows.length === 0 ? (
        <p className="rounded-lg border px-3 py-2.5 text-[13px] text-muted-foreground">
          {empty}
        </p>
      ) : (
        <div className="divide-y divide-border/60 overflow-hidden rounded-lg border bg-card text-[13px]">
          {rows.map((row) => (
            <div
              key={row.id}
              className="flex min-h-9 items-center gap-2 px-3 py-1.5"
            >
              <span className="truncate font-medium">{row.name}</span>
              {row.detail && (
                <span className="truncate text-muted-foreground">
                  {row.detail}
                </span>
              )}
            </div>
          ))}
          {pager}
        </div>
      )}
    </section>
  );
}
