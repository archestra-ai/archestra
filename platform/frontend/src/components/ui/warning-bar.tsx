import type { ReactNode } from "react";

interface WarningBarProps {
  icon?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
}

export function WarningBar({ icon, children, actions }: WarningBarProps) {
  return (
    <div
      role="alert"
      className="sticky top-0 z-50 relative bg-background border-b border-red-500/20 px-4 py-2 flex items-center justify-between gap-4 text-xs text-red-700 dark:text-red-400 before:absolute before:inset-0 before:bg-red-500/10 before:pointer-events-none"
    >
      <div className="flex items-center gap-2">
        {icon}
        <span>{children}</span>
      </div>
      {actions && <div className="flex items-center gap-3">{actions}</div>}
    </div>
  );
}
