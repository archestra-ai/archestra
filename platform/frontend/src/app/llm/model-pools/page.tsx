"use client";

import { Layers, Plus } from "lucide-react";
import { useState } from "react";
import { PageLayout } from "@/components/page-layout";
import { QueryLoadError } from "@/components/query-load-error";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { PermissionButton } from "@/components/ui/permission-button";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { type ModelPool, useModelPools } from "@/lib/model-pools.query";
import { cn } from "@/lib/utils/tailwind";
import { PoolEditor, ProviderName } from "./_parts/pool-editor";

const DESCRIPTION =
  "Send one model's traffic to several provider keys. Requests go to members by priority and weight, and move to the next member on rate limits and outages.";

/** "new" is a pool being created; otherwise the selected pool's id. */
type Selection = "new" | string | null;

export default function ModelPoolsPage() {
  // Benched members come back within a minute, so the list stays fresh.
  const {
    data: pools = [],
    isLoading,
    isLoadingError,
    error,
    refetch,
  } = useModelPools({ refetchInterval: 5_000, toastOnError: false });
  const [selection, setSelection] = useState<Selection>(null);

  const selected: ModelPool | null =
    selection === "new"
      ? null
      : (pools.find((pool) => pool.id === selection) ?? pools[0] ?? null);
  const editing = selection === "new" || selected !== null;

  const newPoolButton = (
    <PermissionButton
      size="sm"
      permissions={{ llmModel: ["update"] }}
      onClick={() => setSelection("new")}
    >
      <Plus />
      <span>New pool</span>
    </PermissionButton>
  );

  if (isLoadingError) {
    return (
      <PageLayout
        title="Model Pools"
        description={DESCRIPTION}
        actionButton={newPoolButton}
      >
        <QueryLoadError
          title="Couldn't load your model pools"
          description={error?.message}
          onRetry={() => refetch()}
        />
      </PageLayout>
    );
  }

  return (
    <PageLayout
      title="Model Pools"
      description={DESCRIPTION}
      actionButton={newPoolButton}
    >
      {!isLoading && pools.length === 0 && selection !== "new" ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Layers />
            </EmptyMedia>
            <EmptyTitle>No model pools yet</EmptyTitle>
            <EmptyDescription>
              A pool lets several provider keys serve one model, so a rate limit
              or an outage on one key doesn't reach your users.
            </EmptyDescription>
          </EmptyHeader>
          {newPoolButton}
        </Empty>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
          <nav
            aria-label="Model pools"
            className="grid content-start overflow-hidden rounded-lg border bg-card"
          >
            {selection === "new" ? (
              <PoolRow
                active
                title="New pool"
                subtitle="Not saved yet"
                onSelect={() => undefined}
              />
            ) : null}
            {pools.map((pool) => (
              <PoolRow
                key={pool.id}
                active={selection !== "new" && pool.id === selected?.id}
                title={pool.name}
                subtitle={
                  <span className="flex flex-wrap items-center gap-x-1.5">
                    <span className="font-mono">{pool.modelId}</span>
                    <span>·</span>
                    <span>{memberSummary(pool)}</span>
                  </span>
                }
                provider={pool.provider}
                onSelect={() => setSelection(pool.id)}
              />
            ))}
          </nav>
          {editing ? (
            <PoolEditor
              key={selection === "new" ? "new" : selected?.id}
              pool={selection === "new" ? null : selected}
              onSaved={(id) => setSelection(id)}
              onDeleted={() => setSelection(null)}
            />
          ) : null}
        </div>
      )}
    </PageLayout>
  );
}

function PoolRow({
  title,
  subtitle,
  provider,
  active,
  onSelect,
}: {
  title: string;
  subtitle: React.ReactNode;
  provider?: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <UnstyledButton
      onClick={onSelect}
      aria-current={active ? "true" : undefined}
      className={cn(
        "grid gap-1 border-b px-3 py-2.5 text-left last:border-b-0 hover:bg-muted/50",
        active && "bg-muted shadow-[inset_3px_0_0_var(--primary)]",
      )}
    >
      <span className="truncate text-sm font-medium">{title}</span>
      <span className="grid gap-1 text-xs text-muted-foreground">
        {provider ? <ProviderName provider={provider} /> : null}
        {subtitle}
      </span>
    </UnstyledButton>
  );
}

function memberSummary(pool: ModelPool): string {
  const on = pool.members.filter((member) => member.enabled).length;
  const benched = pool.members.filter(
    (member) =>
      member.enabled &&
      member.benchedUntil &&
      new Date(member.benchedUntil).getTime() > Date.now(),
  ).length;
  const keys = `${on} key${on === 1 ? "" : "s"}`;
  return benched > 0 ? `${keys}, ${benched} benched` : keys;
}
