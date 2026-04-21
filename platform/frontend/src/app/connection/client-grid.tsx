"use client";

import { Check, ChevronLeft, ChevronRight, Terminal } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ConnectClient } from "./clients";

const CLIENTS_PER_PAGE = 6;

interface ClientGridProps {
  clients: ConnectClient[];
  selected: string | null;
  onSelect: (id: string) => void;
}

export function ClientGrid({ clients, selected, onSelect }: ClientGridProps) {
  const [page, setPage] = useState(0);

  const totalPages = Math.max(1, Math.ceil(clients.length / CLIENTS_PER_PAGE));
  const safePage = Math.min(page, totalPages - 1);
  const start = safePage * CLIENTS_PER_PAGE;
  const pageItems = clients.slice(start, start + CLIENTS_PER_PAGE);

  return (
    <div>
      {totalPages > 1 && (
        <div className="mb-3.5 flex items-center justify-end">
          <span className="font-mono text-[11px] tracking-wider text-muted-foreground">
            {safePage + 1} / {totalPages}
          </span>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-5">
        {pageItems.map((c) => (
          <ClientTile
            key={c.id}
            client={c}
            selected={selected === c.id}
            onSelect={() => onSelect(c.id)}
          />
        ))}
      </div>

      {totalPages > 1 && (
        <div className="mt-3.5 flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={safePage === 0}
            onClick={() => setPage(safePage - 1)}
          >
            <ChevronLeft className="size-3" />
            Prev
          </Button>
          <span className="min-w-12 text-center font-mono text-xs text-muted-foreground">
            {safePage + 1} / {totalPages}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={safePage >= totalPages - 1}
            onClick={() => setPage(safePage + 1)}
          >
            Next
            <ChevronRight className="size-3" />
          </Button>
        </div>
      )}
    </div>
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
        <div className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
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

interface ClientIconProps {
  client: ConnectClient;
  size?: number;
}

export function ClientIcon({ client, size = 36 }: ClientIconProps) {
  const radius = Math.round(size / 4.25);
  return (
    <div
      className="flex shrink-0 items-center justify-center border"
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: client.tileBg || "var(--muted)",
      }}
    >
      {client.svg ? (
        <svg
          viewBox="0 0 24 24"
          width={size * 0.6}
          height={size * 0.6}
          role="img"
          aria-label={`${client.label} logo`}
        >
          <path d={client.svg} fill={client.iconColor || "currentColor"} />
        </svg>
      ) : client.iconOverride ? (
        <div
          className="flex size-full items-center justify-center font-mono font-bold"
          style={{
            background: client.iconOverride.bg,
            color: client.iconOverride.fg,
            borderRadius: Math.round(size / 5),
            fontSize:
              client.iconOverride.glyph.length > 1 ? size * 0.27 : size * 0.42,
            letterSpacing: "-0.02em",
          }}
        >
          {client.iconOverride.glyph}
        </div>
      ) : (
        <Terminal className="size-1/2 text-foreground" strokeWidth={1.8} />
      )}
    </div>
  );
}
