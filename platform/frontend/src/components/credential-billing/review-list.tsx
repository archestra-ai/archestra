"use client";

import { Button } from "@/components/ui/button";

/** A create flow's last step: each chosen value with a way back to it. */
export function ReviewList({ children }: { children: React.ReactNode }) {
  return <dl className="divide-y rounded-lg border px-4">{children}</dl>;
}

export function ReviewListRow({
  label,
  onEdit,
  children,
}: {
  label: string;
  onEdit?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-11 items-center gap-3 py-2">
      <dt className="w-28 shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 text-sm">{children}</dd>
      {onEdit && (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-8 px-0 text-muted-foreground"
          aria-label={`Edit ${label}`}
          onClick={onEdit}
        >
          Edit
        </Button>
      )}
    </div>
  );
}
