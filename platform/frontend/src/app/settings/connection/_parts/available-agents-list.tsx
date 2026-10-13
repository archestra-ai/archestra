"use client";

import { ClientIcon } from "@/app/connection/client-icon";
import type { ConnectClient } from "@/app/connection/clients";
import { SortableAgentList } from "@/components/settings/sortable-agent-list";

export function AvailableAgentsList(props: {
  clients: ConnectClient[];
  shownClientIds: string[];
  onShownClientIdsChange: (ids: string[]) => void;
  onOrderChange: (ids: string[]) => void;
  disabled: boolean;
}) {
  return (
    <SortableAgentList
      items={props.clients.map((client) => ({
        id: client.id,
        label: client.label,
        icon: <ClientIcon client={client} size={16} />,
      }))}
      shownItemIds={props.shownClientIds}
      onShownItemIdsChange={props.onShownClientIdsChange}
      onOrderChange={props.onOrderChange}
      disabled={props.disabled}
      inlineAdd
      label="Available agents"
      removeLabelSuffix=" from Connect"
      emptyMessage="No agents added. Generic client is still available."
    />
  );
}
