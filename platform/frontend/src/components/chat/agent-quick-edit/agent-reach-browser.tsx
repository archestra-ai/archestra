"use client";

import { useState } from "react";
import { AgentIcon } from "@/components/agent-icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useAgentOptionsPage } from "@/lib/agent-options.query";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";

/** Browse all eligible agents without downloading the roster on dialog mount. */
export function AgentReachBrowser({
  agentId,
  excludedIds,
}: {
  agentId: string;
  excludedIds: string[];
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [pageIndex, setPageIndex] = useState(0);
  const debouncedSearch = useDebouncedValue(search, 200);
  const query = useAgentOptionsPage({
    filters: {
      agentType: "agent",
      excludeBuiltIn: true,
      excludeIds: [agentId, ...excludedIds],
      sortBy: "name",
      searchMode: "name_or_description",
    },
    search: debouncedSearch,
    enabled: open,
  });
  const page = Math.min(
    pageIndex,
    Math.max(0, (query.data?.pages.length ?? 1) - 1),
  );
  const rows =
    search === debouncedSearch ? (query.data?.pages[page]?.data ?? []) : [];
  const hasNext =
    page + 1 < (query.data?.pages.length ?? 0) || query.hasNextPage;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="link" size="sm">
          Browse agents
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-2">
        <Input
          aria-label="Search available subagents"
          placeholder="Search agents"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPageIndex(0);
          }}
        />
        {query.isPending || search !== debouncedSearch ? (
          <p>Loading agents…</p>
        ) : query.isError ? (
          <Button onClick={() => query.refetch()}>Retry loading agents</Button>
        ) : (
          <ul className="max-h-72 overflow-y-auto">
            {rows.map((row) => (
              <li key={row.id} className="flex items-center gap-2 py-1 text-sm">
                <AgentIcon icon={row.icon} size={16} />
                <span>{row.name}</span>
              </li>
            ))}
            {rows.length === 0 && <li>No matching agents</li>}
          </ul>
        )}
        {(page > 0 || hasNext) && (
          <nav
            aria-label="Available subagent pages"
            className="flex justify-between"
          >
            <Button
              size="sm"
              variant="outline"
              disabled={page === 0}
              onClick={() => setPageIndex(page - 1)}
            >
              Previous agents
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!hasNext || query.isFetchingNextPage}
              onClick={async () => {
                if (page + 1 >= (query.data?.pages.length ?? 0))
                  await query.fetchNextPage();
                setPageIndex(page + 1);
              }}
            >
              Next agents
            </Button>
          </nav>
        )}
      </PopoverContent>
    </Popover>
  );
}
