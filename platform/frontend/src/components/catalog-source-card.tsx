import type { ReactNode } from "react";

/**
 * Primary source choice used at the beginning of catalog-backed create flows.
 * Skills, Plugins, and Agents intentionally share this surface so choosing a
 * curated template never feels like a separate kind of resource.
 */
export function CatalogSourceCard({
  icon,
  title,
  description,
  onClick,
  badge,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  onClick: () => void;
  badge?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex h-full flex-col gap-3 rounded-xl border bg-card p-5 text-left text-card-foreground shadow-sm transition-colors hover:border-primary/40 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-foreground transition-colors group-hover:bg-primary/10 group-hover:text-primary">
          {icon}
        </div>
        {badge}
      </div>
      <div className="space-y-1">
        <div className="font-medium leading-none">{title}</div>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
    </button>
  );
}
