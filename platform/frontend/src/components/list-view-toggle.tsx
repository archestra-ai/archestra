"use client";

import { LayoutGrid, List } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type ListViewMode = "cards" | "table";

/**
 * Cards-or-table preference for a list page. Pure UI preference, persisted per
 * browser in localStorage under a per-page key. Renders the page's default
 * on the server and first client paint (localStorage is only readable after
 * mount), then adopts the stored choice.
 */
export function useListViewMode(
  storageKey: string,
  defaultMode: ListViewMode = "cards",
) {
  const [mode, setMode] = useState<ListViewMode>(defaultMode);

  useEffect(() => {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === "cards" || stored === "table") setMode(stored);
  }, [storageKey]);

  const select = useCallback(
    (value: ListViewMode) => {
      setMode(value);
      window.localStorage.setItem(storageKey, value);
    },
    [storageKey],
  );

  return [mode, select] as const;
}

export function ListViewToggle({
  value,
  onChange,
  order = ["cards", "table"],
}: {
  value: ListViewMode;
  onChange: (mode: ListViewMode) => void;
  /** The page's default view goes first. */
  order?: readonly [ListViewMode, ListViewMode];
}) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-md border p-0.5">
      {order.map((mode) => (
        <ListViewToggleButton
          key={mode}
          label={VIEW_LABELS[mode]}
          icon={
            mode === "cards" ? (
              <LayoutGrid className="h-4 w-4" />
            ) : (
              <List className="h-4 w-4" />
            )
          }
          active={value === mode}
          onClick={() => onChange(mode)}
        />
      ))}
    </div>
  );
}

const VIEW_LABELS: Record<ListViewMode, string> = {
  cards: "View as cards",
  table: "View as table",
};

// === internal components ===

function ListViewToggleButton({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={active ? "secondary" : "ghost"}
          size="icon-sm"
          aria-label={label}
          aria-pressed={active}
          className={cn(!active && "text-muted-foreground")}
          onClick={onClick}
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
