"use client";

// The "Only these" plugin picker: a pane over the whole "Choose what to
// include" dialog, so the dialog never grows with the plugin count.

import { ChevronLeft, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { cn } from "@/lib/utils/tailwind";
import type { ConnectPlugin } from "./connect-page-data";

/**
 * Portaled into the dialog's content, so focus and scrolling stay inside it.
 * Back, Done and Escape all return to the dialog.
 */
export function PluginPickPane({
  container,
  clientLabel,
  plugins,
  pickedIds,
  onToggle,
  onClear,
  onClose,
}: {
  container: HTMLElement;
  clientLabel: string;
  plugins: ConnectPlugin[];
  pickedIds: ReadonlySet<string>;
  onToggle: (id: string, picked: boolean) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const paneRef = useRef<HTMLElement>(null);
  const [query, setQuery] = useState("");

  // Escape closes the pane, not the dialog: window capture runs before the
  // dialog's own listener.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // Keep focus in the pane: the rest of the dialog goes inert.
  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const siblings = Array.from(container.children).filter(
      (el) => el !== paneRef.current,
    );
    for (const el of siblings) el.setAttribute("inert", "");
    return () => {
      for (const el of siblings) el.removeAttribute("inert");
      if (opener?.isConnected) opener.focus();
    };
  }, [container]);

  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      q
        ? plugins.filter((p) =>
            [p.name, p.slug, p.description ?? "", p.source ?? ""].some((s) =>
              s.toLowerCase().includes(q),
            ),
          )
        : plugins,
    [plugins, q],
  );
  const total = plugins.length;

  return (
    <section
      ref={paneRef}
      aria-label="Pick plugins"
      className="absolute inset-0 z-50 flex flex-col bg-background animate-in fade-in-0 slide-in-from-right-2 duration-150"
    >
      <div className="space-y-3 border-b px-4 pt-4 pb-3">
        <div className="flex items-start gap-2">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Back"
            className="-ml-1 shrink-0"
            onClick={onClose}
          >
            <ChevronLeft />
          </Button>
          <div className="min-w-0 pt-1">
            <p className="text-sm font-semibold">
              Pick plugins for {clientLabel}
            </p>
            <p className="text-xs text-muted-foreground">
              Only these are included. Plugins approved later stay out until you
              add them.
            </p>
          </div>
        </div>
        <InputGroup>
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${total} plugins…`}
            aria-label="Search plugins"
          />
        </InputGroup>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {visible.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            <span>No plugins match “{query.trim()}”.</span>
          </p>
        ) : (
          <ul className="divide-y">
            {visible.map((p) => {
              const id = `pick-plugin-${p.id}`;
              const checked = pickedIds.has(p.id);
              return (
                <li key={p.id}>
                  <label
                    htmlFor={id}
                    className={cn(
                      "flex cursor-pointer items-start gap-3 px-4 py-2.5 transition-colors hover:bg-muted/50",
                      checked && "bg-primary/5 hover:bg-primary/10",
                    )}
                  >
                    <Checkbox
                      id={id}
                      className="mt-0.5"
                      checked={checked}
                      onCheckedChange={(v) => onToggle(p.id, v === true)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className="truncate text-sm font-medium">
                          {p.name}
                        </span>
                        {p.source && (
                          <span className="ml-auto shrink-0 truncate text-xs text-muted-foreground">
                            {p.source}
                          </span>
                        )}
                      </span>
                      {p.description && (
                        <span className="line-clamp-2 text-xs text-muted-foreground">
                          {p.description}
                        </span>
                      )}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex items-center gap-2 border-t px-4 py-3">
        <span className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{pickedIds.size}</span>
          <span> of {total} picked</span>
        </span>
        {pickedIds.size > 0 && (
          <Button size="xs" variant="ghost" onClick={onClear}>
            Clear
          </Button>
        )}
        <Button className="ml-auto" onClick={onClose}>
          Done
        </Button>
      </div>
    </section>
  );
}
