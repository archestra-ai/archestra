"use client";

import { Check, ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { cn } from "@/lib/utils/tailwind";
import { ClientIcon } from "./client-icon";
import type { ConnectClient } from "./clients";

interface ClientPickerProps {
  clients: ConnectClient[];
  selected: string | null;
  onSelect: (id: string) => void;
}

const FALLBACK_CLIENT_ID = "generic";

/**
 * App dropdown — the whole "step 1" of the wizard. The trigger shows the
 * selected app's icon; the menu has a search field. A search that matches no
 * app offers "Any client" instead of showing empty results. Searching never
 * changes the page; only picking an entry does.
 */
export function ClientPicker({
  clients,
  selected,
  onSelect,
}: ClientPickerProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const selectedClient = clients.find((c) => c.id === selected) ?? null;
  const fallback = clients.find((c) => c.id === FALLBACK_CLIENT_ID) ?? null;

  const matches = useMemo(
    () => filterClients(clients, query),
    [clients, query],
  );
  const noMatch = query.trim() !== "" && matches.length === 0;
  const options = noMatch && fallback ? [fallback] : matches;

  const choose = (id: string) => {
    onSelect(id);
    setQuery("");
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <UnstyledButton
          type="button"
          aria-label="Choose your app"
          className="flex w-full max-w-md items-center gap-3 rounded-lg border bg-card p-2.5 text-left shadow-sm transition-colors hover:border-primary/50 data-[state=open]:border-primary"
        >
          {selectedClient ? (
            <>
              <ClientIcon client={selectedClient} size={36} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold tracking-tight">
                  {selectedClient.label}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {selectedClient.sub}
                </div>
              </div>
            </>
          ) : (
            <span className="flex-1 text-sm text-muted-foreground">
              Choose your app
            </span>
          )}
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </UnstyledButton>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-(--radix-popover-trigger-width) p-1"
      >
        <Input
          autoFocus
          aria-label="Search apps"
          value={query}
          placeholder="Type to search…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && options[0]) choose(options[0].id);
          }}
          className="mb-1 h-9 border-0 shadow-none focus-visible:ring-0"
        />
        {noMatch && (
          <p className="px-2 pb-1 text-xs text-muted-foreground">
            No app matches &ldquo;{query.trim()}&rdquo;. Any client works with
            the generic instructions.
          </p>
        )}
        <ul className="max-h-80 overflow-y-auto">
          {options.map((c) => (
            <li key={c.id}>
              <UnstyledButton
                type="button"
                aria-pressed={selected === c.id}
                onClick={() => choose(c.id)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-accent",
                  (noMatch || selected === c.id) && "bg-accent/60",
                )}
              >
                <ClientIcon client={c} size={28} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{c.label}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {c.sub}
                  </div>
                </div>
                {selected === c.id && <Check className="size-4 text-primary" />}
              </UnstyledButton>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function filterClients(clients: ConnectClient[], query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return clients;
  return clients.filter(
    (c) =>
      c.id !== FALLBACK_CLIENT_ID &&
      (c.label.toLowerCase().includes(q) || c.sub.toLowerCase().includes(q)),
  );
}
