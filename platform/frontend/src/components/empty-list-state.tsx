import { Plus } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

/**
 * The empty state of an editable list: a dashed box that holds the action
 * which fills it. Once the list has rows, render {@link AddListItemButton}
 * below them instead, so the action always sits where the next row goes
 * rather than floating above the list.
 */
export function EmptyListState({
  message,
  action,
}: {
  message: ReactNode;
  action: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed px-4 py-3">
      <p className="text-sm text-muted-foreground">{message}</p>
      {action}
    </div>
  );
}

export function AddListItemButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <Button type="button" variant="outline" size="sm" onClick={onClick}>
      <Plus className="h-4 w-4" />
      <span>{label}</span>
    </Button>
  );
}
