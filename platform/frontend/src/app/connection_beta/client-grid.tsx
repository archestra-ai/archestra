"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { ClientIcon } from "./client-icon";
import type { ConnectClient } from "./clients";

interface ClientPickerProps {
  clients: ConnectClient[];
  selected: string | null;
  onSelect: (id: string) => void;
}

/** Card grid — the whole "step 1" of the wizard. */
export function ClientPicker({
  clients,
  selected,
  onSelect,
}: ClientPickerProps) {
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4">
      {clients.map((c) => (
        <ClientTile
          key={c.id}
          client={c}
          selected={selected === c.id}
          onSelect={() => onSelect(c.id)}
        />
      ))}
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
