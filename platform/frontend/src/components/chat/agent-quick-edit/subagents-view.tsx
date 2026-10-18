"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { ExternalLink, Loader2, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AgentIcon } from "@/components/agent-icon";
import { agentNewHref } from "@/components/agent-pages/agent-page-config";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OverlappedIcons } from "@/components/ui/overlapped-icons";
import { useAgentOptionsPage } from "@/lib/agent-options.query";
import {
  useAgentDelegations,
  useAllProfileTools,
  useSyncAgentDelegations,
} from "@/lib/agent-tools.query";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { useInternalMcpCatalog } from "@/lib/mcp/internal-mcp-catalog.query";
import { cn } from "@/lib/utils/tailwind";
import { QuickEditFooter, QuickEditViewHeader } from "./view-header";

type CatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

export function SubagentsView({
  agentId,
  agentName,
  onBack,
}: {
  agentId: string;
  agentName: string;
  onBack: () => void;
}) {
  const { data: delegations = [], isSuccess: delegationsLoaded } =
    useAgentDelegations(agentId);
  const syncDelegations = useSyncAgentDelegations();
  const [search, setSearch] = useState("");
  const [pageIndex, setPageIndex] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const seededRef = useRef(false);

  const saved = useMemo(
    () => new Set(delegations.map((delegation) => delegation.id)),
    [delegations],
  );

  // Seed only from a successful read: saving replaces the whole list, so a
  // failed read seeded as empty would delete every subagent.
  useEffect(() => {
    if (seededRef.current || !delegationsLoaded) return;
    seededRef.current = true;
    setSelected(new Set(saved));
  }, [delegationsLoaded, saved]);

  const debouncedSearch = useDebouncedValue(search, 200);
  const candidates = useAgentOptionsPage({
    filters: {
      agentType: "agent",
      excludeBuiltIn: true,
      excludeIds: [agentId],
      sortBy: "name",
      searchMode: "name_or_description",
    },
    search: debouncedSearch,
    limit: SUBAGENTS_PAGE_SIZE,
  });
  const page = Math.min(
    pageIndex,
    Math.max(0, (candidates.data?.pages.length ?? 1) - 1),
  );
  const visibleCandidates =
    search === debouncedSearch
      ? (candidates.data?.pages[page]?.data ?? [])
      : [];
  const hasNext =
    page + 1 < (candidates.data?.pages.length ?? 0) || candidates.hasNextPage;
  const nextPage = async () => {
    setPageIndex(page + 1);
    if (page + 1 >= (candidates.data?.pages.length ?? 0))
      await candidates.fetchNextPage();
  };

  const adding = [...selected].filter((id) => !saved.has(id));
  const removing = [...saved].filter((id) => !selected.has(id));
  const hasChanges = adding.length > 0 || removing.length > 0;

  const toggle = (id: string, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });

  const save = () =>
    syncDelegations.mutate(
      { agentId, targetAgentIds: [...selected] },
      { onSuccess: (result) => result && onBack() },
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <QuickEditViewHeader
        backLabel={agentName}
        onBack={onBack}
        title="Subagents"
      />
      <div className="shrink-0 space-y-3 px-5 pt-4 pb-2">
        <p className="text-sm text-muted-foreground">
          {agentName} can hand work to these agents. Their tools become usable
          by everyone chatting with {agentName}.
        </p>
        <div className="relative">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search agents"
            aria-label="Search agents"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPageIndex(0);
            }}
            className="pl-9"
            autoFocus
          />
        </div>
        {search && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch("");
              setPageIndex(0);
            }}
          >
            Clear search
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-5 pt-1 pb-4">
        {!delegationsLoaded ||
        candidates.isPending ||
        search !== debouncedSearch ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            <span>Loading agents…</span>
          </div>
        ) : candidates.isError ? (
          <Button variant="outline" onClick={() => candidates.refetch()}>
            Retry loading agents
          </Button>
        ) : visibleCandidates.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No agents match "{search}"
          </p>
        ) : (
          visibleCandidates.map((agent) => {
            const checked = selected.has(agent.id);
            return (
              <Label
                key={agent.id}
                className={cn(
                  "flex cursor-pointer items-center gap-3 rounded-lg border bg-background py-2 pr-3 pl-3 font-normal",
                  checked && "border-primary ring-1 ring-inset ring-primary",
                )}
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={(value) => toggle(agent.id, value === true)}
                />
                <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
                  <AgentIcon icon={agent.icon} size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <span className="truncate">{agent.name}</span>
                    {checked && !saved.has(agent.id) && (
                      <Badge variant="secondary">Adding</Badge>
                    )}
                    {!checked && saved.has(agent.id) && (
                      <Badge variant="destructive">Removing</Badge>
                    )}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {agent.description || "No description"}
                  </div>
                </div>
                <AgentToolAvatars agentId={agent.id} />
              </Label>
            );
          })
        )}
        <a
          href={agentNewHref("agent")}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 pt-1 text-sm underline-offset-4 hover:underline"
        >
          Create a new agent
          <ExternalLink className="size-3" />
        </a>
      </div>
      {(page > 0 || hasNext) && (
        <nav
          aria-label="Subagent pages"
          className="flex items-center justify-between gap-2 px-5 py-2"
        >
          <Button
            variant="outline"
            size="sm"
            disabled={page === 0}
            onClick={() => setPageIndex(page - 1)}
          >
            Previous agents
          </Button>
          <span className="text-xs text-muted-foreground">Page {page + 1}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={
              !hasNext ||
              candidates.isFetchingNextPage ||
              search !== debouncedSearch
            }
            onClick={nextPage}
          >
            Next agents
          </Button>
        </nav>
      )}
      <QuickEditFooter>
        <span className="text-xs text-muted-foreground">
          {changeSummary(selected.size, adding.length, removing.length)}
        </span>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onBack}>
            Cancel
          </Button>
          <Button
            onClick={save}
            disabled={!hasChanges || syncDelegations.isPending}
          >
            {syncDelegations.isPending && <Loader2 className="animate-spin" />}
            <span>Save</span>
          </Button>
        </div>
      </QuickEditFooter>
    </div>
  );
}

/** "2 selected · 1 to add · 1 to remove", omitting the parts that are zero. */
export function changeSummary(
  selectedCount: number,
  addCount: number,
  removeCount: number,
) {
  return [
    `${selectedCount} selected`,
    addCount > 0 ? `${addCount} to add` : null,
    removeCount > 0 ? `${removeCount} to remove` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function AgentToolAvatars({ agentId }: { agentId: string }) {
  const { data: catalogItems = [] } = useInternalMcpCatalog();
  const { data: assignedToolsData } = useAllProfileTools({
    filters: { agentId },
    skipPagination: true,
    includeToolDetails: false,
    enabled: !!agentId,
  });

  const catalogs = useMemo(() => {
    const ids = new Set<string>();
    for (const assignment of assignedToolsData?.data ?? []) {
      if (assignment.tool.catalogId) ids.add(assignment.tool.catalogId);
    }
    return catalogItems.filter((catalog: CatalogItem) => ids.has(catalog.id));
  }, [assignedToolsData, catalogItems]);

  if (catalogs.length === 0) return null;
  return (
    <OverlappedIcons
      icons={catalogs.map((catalog) => ({
        key: catalog.id,
        icon: (
          <McpCatalogIcon
            icon={catalog.icon}
            catalogId={catalog.id}
            size={12}
          />
        ),
        tooltip: catalog.name,
      }))}
      maxVisible={3}
      size="sm"
    />
  );
}

const SUBAGENTS_PAGE_SIZE = 20;
