import type { ReactNode } from "react";

export function MetadataCard({
  title,
  badges,
  action,
  children,
}: {
  title: string;
  badges?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border p-4 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1 min-w-0 flex-1">
          <h2 className="text-lg font-semibold truncate">{title}</h2>
          {badges && (
            <div className="flex flex-wrap items-center gap-2">{badges}</div>
          )}
        </div>
        {action}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
        {children}
      </div>
    </div>
  );
}

export function MetadataItem({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <div>{children}</div>
    </div>
  );
}
