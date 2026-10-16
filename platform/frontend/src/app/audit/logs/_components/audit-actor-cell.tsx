"use client";

import { CreatedByCell } from "@/components/created-by-cell";
import type { AuditLog } from "@/lib/audit-log/audit-log.query";
import { ACTOR_TYPE_LABEL } from "./audit-log-action-labels";

export function AuditActorCell({
  event,
}: {
  event: Pick<
    AuditLog,
    | "actorId"
    | "actorName"
    | "actorEmail"
    | "actorType"
    | "impersonatedBy"
    | "impersonatedByEmail"
  >;
}) {
  return (
    <CreatedByCell
      createdBy={{
        id: event.actorId ?? "",
        name:
          event.actorName ??
          event.actorEmail ??
          (event.actorType === "system" ? "System" : "Deleted user"),
        email: event.actorEmail,
        type:
          event.actorType === "service_account" ? "service_account" : undefined,
      }}
      showServiceAccountBadge={false}
      secondaryText={
        event.impersonatedBy
          ? `via ${event.impersonatedByEmail ?? "deleted user"}`
          : ACTOR_TYPE_LABEL[event.actorType]
      }
      className="text-xs"
    />
  );
}
