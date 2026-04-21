"use client";

import { ShieldCheck, ShieldX } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { AuditEventStatus } from "./audit-log.types";

export function AuditStatusBadge({ status }: { status: AuditEventStatus }) {
  if (status === "Allowed") {
    return (
      <Badge
        variant="outline"
        className="border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300"
      >
        <ShieldCheck className="h-3 w-3" />
        Allowed
      </Badge>
    );
  }

  if (status === "Denied") {
    return (
      <Badge
        variant="outline"
        className="border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300"
      >
        <ShieldX className="h-3 w-3" />
        Denied
      </Badge>
    );
  }

  return (
    <Badge variant="destructive">
      <ShieldX className="h-3 w-3" />
      Failed
    </Badge>
  );
}
