"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { useState } from "react";
import {
  CLEANUP_INTERVAL_LABELS,
  DEFAULT_LIMIT_CLEANUP_INTERVAL,
  LimitCleanupIntervalSelect,
} from "@/components/limit-cleanup-interval-select";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useCreateLimit,
  useDeleteLimit,
  useLimits,
  useUpdateLimit,
} from "@/lib/limits.query";
import { useTeamStatistics } from "@/lib/statistics.query";

type Team = archestraApiTypes.GetTeamResponses["200"];
type TeamLimit = archestraApiTypes.GetLimitsResponses["200"][number];
type ResetPeriod = NonNullable<TeamLimit["cleanupInterval"]>;

const dollars = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);

export function TeamBudgetsSection({
  team,
  open,
}: {
  team: Team;
  open: boolean;
}) {
  const limits = useLimits({
    enabled: open,
    filters: { entityType: "team", entityId: team.id },
  });
  const statistics = useTeamStatistics({
    timeframe: "30d",
    teamId: team.id,
    enabled: open,
  });
  const createLimit = useCreateLimit();
  const updateLimit = useUpdateLimit();
  const deleteLimit = useDeleteLimit();
  const [amount, setAmount] = useState("");
  const [period, setPeriod] = useState<ResetPeriod>(
    DEFAULT_LIMIT_CLEANUP_INTERVAL,
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editedAmount, setEditedAmount] = useState("");
  const [editedPeriod, setEditedPeriod] = useState<ResetPeriod>(
    DEFAULT_LIMIT_CLEANUP_INTERVAL,
  );
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const teamStatistics = statistics.data?.find((row) => row.teamId === team.id);
  const teamLimits = (limits.data ?? []).filter(
    (limit) => limit.limitType === "token_cost",
  );

  const create = async () => {
    const value = Number(amount);
    if (!Number.isInteger(value) || value <= 0) return;
    const result = await createLimit.mutateAsync({
      entityType: "team",
      entityId: team.id,
      limitType: "token_cost",
      limitValue: value,
      cleanupInterval: period,
      model: null,
    });
    if (result) setAmount("");
  };

  const save = async (limit: TeamLimit) => {
    const value = Number(editedAmount);
    if (!Number.isInteger(value) || value <= 0) return;
    const result = await updateLimit.mutateAsync({
      id: limit.id,
      limitValue: value,
      cleanupInterval: editedPeriod,
    });
    if (result) setEditingId(null);
  };

  return (
    <div className="space-y-6">
      <div className="rounded-lg border p-4">
        <p className="text-sm text-muted-foreground">
          Team spend · last 30 days
        </p>
        <p className="mt-1 text-2xl font-semibold">
          {statistics.isLoading
            ? "Loading…"
            : dollars(teamStatistics?.cost ?? 0)}
        </p>
        <p className="text-sm text-muted-foreground">
          {teamStatistics?.requests ?? 0} requests
        </p>
        {statistics.isError && (
          <InlineNotice variant="error">
            <span className="font-medium">Could not load team spend.</span>
          </InlineNotice>
        )}
      </div>

      <section className="space-y-3">
        <div>
          <h3 className="font-medium">Team spend limits</h3>
          <p className="text-sm text-muted-foreground">
            These limits apply only to {team.name}. Model-specific limits keep
            their model scope when edited.
          </p>
        </div>
        {limits.isLoading && (
          <p className="text-sm text-muted-foreground">Loading limits…</p>
        )}
        {limits.isError && (
          <InlineNotice variant="error">
            <span className="font-medium">Could not load team limits.</span>
            <InlineNoticeText>Try again in a moment.</InlineNoticeText>
          </InlineNotice>
        )}
        {!limits.isLoading && !limits.isError && teamLimits.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No limits for this team.
          </p>
        )}
        {teamLimits.map((limit) => {
          const usage =
            limit.modelUsage?.reduce((sum, model) => sum + model.cost, 0) ?? 0;
          const editing = editingId === limit.id;
          return (
            <div key={limit.id} className="space-y-3 rounded-lg border p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-medium">
                    Spend · {dollars(usage)} / {dollars(limit.limitValue)}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {
                      CLEANUP_INTERVAL_LABELS[
                        limit.cleanupInterval ?? DEFAULT_LIMIT_CLEANUP_INTERVAL
                      ]
                    }
                    {limit.model?.length
                      ? ` · ${limit.model.join(", ")}`
                      : " · All models"}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() => {
                      setEditingId(editing ? null : limit.id);
                      setEditedAmount(String(limit.limitValue));
                      setEditedPeriod(
                        limit.cleanupInterval ?? DEFAULT_LIMIT_CLEANUP_INTERVAL,
                      );
                      setDeletingId(null);
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() => {
                      setDeletingId(deletingId === limit.id ? null : limit.id);
                      setEditingId(null);
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </div>
              {editing && (
                <div className="flex flex-wrap items-end gap-2">
                  <div>
                    <Label htmlFor={`team-limit-${limit.id}`}>
                      Amount (USD)
                    </Label>
                    <Input
                      id={`team-limit-${limit.id}`}
                      type="number"
                      min="1"
                      step="1"
                      value={editedAmount}
                      onChange={(event) => setEditedAmount(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.preventDefault();
                      }}
                      className="w-32"
                    />
                  </div>
                  <LimitCleanupIntervalSelect
                    value={editedPeriod}
                    onValueChange={setEditedPeriod}
                  />
                  <Button
                    type="button"
                    size="sm"
                    disabled={
                      updateLimit.isPending ||
                      !Number.isInteger(Number(editedAmount)) ||
                      Number(editedAmount) <= 0
                    }
                    onClick={() => save(limit)}
                  >
                    Save
                  </Button>
                </div>
              )}
              {deletingId === limit.id && (
                <div className="flex items-center gap-2 text-sm">
                  <span>Delete this team limit?</span>
                  <Button
                    type="button"
                    size="xs"
                    variant="destructive"
                    disabled={deleteLimit.isPending}
                    onClick={async () => {
                      const result = await deleteLimit.mutateAsync({
                        id: limit.id,
                      });
                      if (result) setDeletingId(null);
                    }}
                  >
                    Confirm
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => setDeletingId(null)}
                  >
                    Cancel
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </section>

      <section className="space-y-3 border-t pt-4">
        <h3 className="font-medium">Add team spend limit</h3>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <Label htmlFor="new-team-budget">Amount (USD)</Label>
            <Input
              id="new-team-budget"
              type="number"
              min="1"
              step="1"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.preventDefault();
              }}
              placeholder="100"
              className="w-32"
            />
          </div>
          <LimitCleanupIntervalSelect
            value={period}
            onValueChange={setPeriod}
          />
          <Button
            type="button"
            size="sm"
            disabled={
              createLimit.isPending ||
              !Number.isInteger(Number(amount)) ||
              Number(amount) <= 0
            }
            onClick={create}
          >
            Add limit
          </Button>
        </div>
      </section>
    </div>
  );
}
