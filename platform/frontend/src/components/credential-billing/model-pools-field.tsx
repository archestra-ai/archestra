"use client";

import { DocsPage, getDocsUrl } from "@archestra/shared";
import { ChevronRight, X } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import {
  poolAnswers,
  poolServes,
} from "@/components/credential-billing/model-pool-access";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { PoolProviderIcons } from "@/components/model-pools/pool-providers";
import { ProviderIcon } from "@/components/provider-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import { type ModelPool, useModelPools } from "@/lib/model-pools.query";
import { cn } from "@/lib/utils/tailwind";

/**
 * Whether a virtual key form shows {@link ModelPoolsField}: the feature is on
 * and the caller may change which keys reach a pool.
 */
export function useCanSetModelPools(): boolean {
  const enabled = useFeature("llmModelPoolsEnabled") === true;
  const { data: canUpdateModels } = useHasPermissions({
    llmModel: ["update"],
  });
  return enabled && canUpdateModels === true;
}

/**
 * The pools added to a credential by name, each removable, and a picker for
 * the rest. Each says what it serves and, opened, which providers serve it.
 * A pool answers with its own members' keys, so any pool can be added
 * whatever providers the credential maps.
 */
export function ModelPoolsField({
  value,
  onChange,
}: {
  /** Pools added by name. */
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const id = useId();
  const { data: pools = [] } = useModelPools();
  // A deleted pool can stay in `value` on an OAuth client; the first change
  // drops it, since saving an unknown pool fails.
  const listed = pools.filter((pool) => value.includes(pool.id));
  const addable = pools.filter((pool) => !value.includes(pool.id));
  const listedIds = listed.map((pool) => pool.id);

  return (
    <div className="space-y-2">
      <div className="flex min-h-8 items-center justify-between gap-2">
        <Label htmlFor={id}>Model pools</Label>
        <Button variant="link" size="xs" className="h-auto px-0" asChild>
          <Link href="/llm/model-pools">Manage pools</Link>
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        One model name served by several provider keys, so requests move to the
        next key when one fails or hits its rate limit.{" "}
        <ExternalDocsLink
          href={getDocsUrl(DocsPage.PlatformLlmProxyModelPools)}
          className="underline"
          showIcon={false}
        >
          How pools work
        </ExternalDocsLink>
      </p>
      {listed.length > 0 && (
        <div className="divide-y rounded-md border">
          {listed.map((pool) => (
            <PoolRow
              key={pool.id}
              pool={pool}
              onRemove={() =>
                onChange(listedIds.filter((poolId) => poolId !== pool.id))
              }
            />
          ))}
        </div>
      )}
      <SearchableSelect
        id={id}
        ariaLabel="Add a model pool"
        value=""
        onValueChange={(poolId) => onChange([...listedIds, poolId])}
        placeholder="Add a pool…"
        searchPlaceholder="Search pools..."
        emptyMessage={
          pools.length === 0 ? "No model pools yet." : "No other pools."
        }
        items={addable.map((pool) => ({
          value: pool.id,
          label: pool.name,
          disabled: !poolAnswers(pool),
          content: <PoolSummary pool={pool} />,
        }))}
        className="w-full"
      />
    </div>
  );
}

/** Name, what it serves first, its providers and, if off, that it won't answer. */
function PoolSummary({ pool }: { pool: ModelPool }) {
  const serves = poolServes(pool);
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <span className="truncate font-mono text-sm">{pool.name}</span>
      {serves.first && serves.first !== pool.name && (
        <span className="truncate font-mono text-xs text-muted-foreground">
          {serves.first}
        </span>
      )}
      {serves.otherModels > 0 && (
        <span className="shrink-0 text-xs text-muted-foreground">
          +{serves.otherModels} {serves.otherModels === 1 ? "model" : "models"}
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-2">
        <PoolProviderIcons pool={pool} />
        {!poolAnswers(pool) && (
          <Badge variant="outline" className="text-muted-foreground">
            Won&apos;t answer
          </Badge>
        )}
      </span>
    </span>
  );
}

function PoolRow({
  pool,
  onRemove,
}: {
  pool: ModelPool;
  onRemove: () => void;
}) {
  const catalog = useModelProviderCatalog();
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="flex items-center gap-2 px-2 py-1.5">
        <CollapsibleTrigger asChild>
          <UnstyledButton
            type="button"
            aria-label={`${open ? "Hide" : "Show"} ${pool.name} providers`}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            <ChevronRight
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform",
                open && "rotate-90",
              )}
              aria-hidden="true"
            />
            <PoolSummary pool={pool} />
          </UnstyledButton>
        </CollapsibleTrigger>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Remove ${pool.name}`}
          onClick={onRemove}
        >
          <X />
        </Button>
      </div>
      <CollapsibleContent>
        <div className="mx-2 mb-2 rounded-md bg-muted/50 p-2 text-xs">
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-x-3 gap-y-1.5">
            <span className="text-muted-foreground">Provider</span>
            <span className="text-muted-foreground">Serves</span>
            {[...pool.members]
              .sort((a, b) => a.priority - b.priority)
              .map((member) => (
                <MemberLine
                  key={member.id}
                  label={catalog.label(member.provider)}
                  member={member}
                />
              ))}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function MemberLine({
  label,
  member,
}: {
  label: string;
  member: ModelPool["members"][number];
}) {
  return (
    <>
      <span
        className={cn(
          "flex min-w-0 items-center gap-1.5",
          !member.enabled && "text-muted-foreground line-through",
        )}
      >
        <ProviderIcon provider={member.provider} size={14} />
        <span className="truncate">{label}</span>
      </span>
      <span className="truncate font-mono">{member.modelId}</span>
    </>
  );
}
