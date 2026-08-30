import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";

export function KnowledgeSettingsRow({
  label,
  children,
  htmlFor,
}: {
  label: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
      <Label
        htmlFor={htmlFor}
        className="shrink-0 text-sm text-muted-foreground sm:w-40"
      >
        {label}
      </Label>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
