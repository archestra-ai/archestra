"use client";

import type { Column } from "@tanstack/react-table";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";

/** A column header that sorts its table: ascending first, then descending. */
export function SortableHeader<TData>({
  column,
  label,
}: {
  column: Column<TData>;
  label: string;
}) {
  return (
    <Button
      variant="ghost"
      className="h-auto !p-0 font-medium whitespace-nowrap hover:bg-transparent"
      onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
    >
      <span>{label}</span>
      <SortIcon isSorted={column.getIsSorted()} />
    </Button>
  );
}

function SortIcon({ isSorted }: { isSorted: "asc" | "desc" | false }) {
  const upArrow = <ChevronUp className="h-3 w-3" />;
  const downArrow = <ChevronDown className="h-3 w-3" />;
  if (isSorted === "asc") return upArrow;
  if (isSorted === "desc") return downArrow;
  return (
    <div className="text-muted-foreground flex flex-col items-center">
      {upArrow}
      <span className="mt-[-4px]">{downArrow}</span>
    </div>
  );
}
