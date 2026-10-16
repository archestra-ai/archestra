"use client";

import type { ClientFamily, InteractionSource } from "@archestra/shared";
import { ClientIcon } from "@/components/provider-icon";
import { SourceLabel } from "@/components/source-badge";

export function SourceFilterOption({ source }: { source: InteractionSource }) {
  return (
    <span className="flex items-center min-w-0">
      <SourceLabel source={source} className="flex items-center min-w-0" />
    </span>
  );
}

export function ClientFilterOption({
  client,
}: {
  client: Pick<ClientFamily, "label" | "provider" | "icon" | "mark">;
}) {
  return (
    <span className="flex items-center gap-2 min-w-0">
      <ClientIcon client={client} size={16} />
      <span className="truncate">{client.label}</span>
    </span>
  );
}
