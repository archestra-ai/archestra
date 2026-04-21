"use client";

import { Badge } from "@/components/ui/badge";
import type { AuditEventType } from "./audit-log.types";

const AUDIT_EVENT_TYPE_BADGE_CLASSNAME: Record<AuditEventType, string> = {
  LLM: "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-300",
  MCP: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300",
};

export function AuditEventTypeBadge({ type }: { type: AuditEventType }) {
  return (
    <Badge variant="outline" className={AUDIT_EVENT_TYPE_BADGE_CLASSNAME[type]}>
      {type}
    </Badge>
  );
}
