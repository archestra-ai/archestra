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
      className="bg-red-500/10 border-b border-red-500/20 px-4 py-2 flex items-center justify-between gap-4 text-xs text-red-700 dark:text-red-400"
    >
      <div className="flex items-center gap-2">
        {icon}
        <span>{children}</span>
      </div>
      {actions && <div className="flex items-center gap-3">{actions}</div>}
    </div>
  );
}
