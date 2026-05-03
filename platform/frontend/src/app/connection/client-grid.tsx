"use client";

import { Check, ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ClientIcon } from "./client-icon";
import type { ConnectClient } from "./clients";

const CLIENT_PICKER_PAGE_SIZE = 8;

interface ClientPickerProps {
  clients: ConnectClient[];
  selected: string | null;
  onSelect: (id: string) => void;
}

export function ClientPicker({
  clients,
  selected,
  onSelect,
}: ClientPickerProps) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return clients;
    return clients.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        c.sub.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q),
    );
  }, [clients, query]);

  const totalPages = Math.max(
    1,
    Math.ceil(filtered.length / CLIENT_PICKER_PAGE_SIZE),
  );

  const safePage = Math.min(page, totalPages - 1);
  const start = safePage * CLIENT_PICKER_PAGE_SIZE;
  const pageItems = filtered.slice(start, start + CLIENT_PICKER_PAGE_SIZE);

  return (
    <section className="pb-5">
      <div className="flex flex-wrap items-center justify-between gap-3 pb-4">
        <h3 className="text-[17px] font-bold tracking-tight text-foreground">
          Select your client
        </h3>
        <div className="flex items-center gap-3">
          {totalPages > 1 && (
            <div className="flex items-center gap-1 font-mono text-xs text-muted-foreground">
              <button
                type="button"
                onClick={() => setPage(safePage - 1)}
                disabled={safePage === 0}
                aria-label="Previous page"
                className="flex size-6 items-center justify-center rounded transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-30"
              >
                <ChevronLeft className="size-3.5" />
              </button>
              <span className="px-1 tabular-nums">
                {safePage + 1} / {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage(safePage + 1)}
                disabled={safePage >= totalPages - 1}
                aria-label="Next page"
                className="flex size-6 items-center justify-center rounded transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-30"
              >
                <ChevronRight className="size-3.5" />
              </button>
            </div>
          )}
          {clients.length > CLIENT_PICKER_PAGE_SIZE && (
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(0);
                }}
                placeholder="Search"
                className="h-9 w-56 rounded-full pl-8"
              />
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4">
        {pageItems.map((c) => (
          <ClientTile
            key={c.id}
            client={c}
            selected={selected === c.id}
            onSelect={() => onSelect(c.id)}
          />
        ))}
        {pageItems.length === 0 && (
          <div className="col-span-full flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed bg-muted/20 p-8 text-center text-sm text-muted-foreground">
            <span>
              No clients match{" "}
              <span className="font-medium text-foreground">“{query}”</span>
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setQuery("");
                setPage(0);
              }}
            >
              <X className="size-3" />
              Clear
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

interface ClientTileProps {
  client: ConnectClient;
  selected: boolean;
  onSelect: () => void;
}

function ClientTile({ client, selected, onSelect }: ClientTileProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "relative flex items-center gap-3 rounded-lg border bg-card p-3 text-left shadow-sm transition-all hover:border-primary/50",
        selected && "border-primary ring-4 ring-primary/5",
      )}
    >
      <ClientIcon client={client} size={36} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold tracking-tight text-foreground">
          {client.label}
        </div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">
          {client.sub}
        </div>
      </div>
      {selected && (
        <div className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <Check className="size-2.5" strokeWidth={3} />
        </div>
      )}
    </button>
  );
}
