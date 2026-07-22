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
 * browser in localStorage under a per-page key. Renders "cards" on the server
 * and first client paint (localStorage is only readable after mount), then
 * adopts the stored choice.
 */
export function useListViewMode(storageKey: string) {
  const [mode, setMode] = useState<ListViewMode>("cards");

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
}: {
  value: ListViewMode;
  onChange: (mode: ListViewMode) => void;
}) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-md border p-0.5">
      <ListViewToggleButton
        label="View as cards"
        icon={<LayoutGrid className="h-4 w-4" />}
        active={value === "cards"}
        onClick={() => onChange("cards")}
      />
      <ListViewToggleButton
        label="View as table"
        icon={<List className="h-4 w-4" />}
        active={value === "table"}
        onClick={() => onChange("table")}
      />
    </div>
  );
}

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
