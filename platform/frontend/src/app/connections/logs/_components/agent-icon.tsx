"use client";

import { ClientIcon } from "@/app/connection/client-icon";
import { CONNECT_CLIENTS, type ConnectClient } from "@/app/connection/clients";

const CLIENTS_BY_ID = new Map(CONNECT_CLIENTS.map((c) => [c.id, c]));

/**
 * The Connect page app an agent is: by its id, or else by the name it
 * registered or sent ("Droid", "Kiro IDE"), so agents set up by hand still get
 * their logo. The generic "Generic client" entry never matches a name.
 */
export function connectClientFor(agent: {
  clientId: string | null;
  name: string;
}): ConnectClient | undefined {
  const byId = agent.clientId ? CLIENTS_BY_ID.get(agent.clientId) : undefined;
  if (byId) return byId;
  const name = agent.name.toLowerCase();
  return CONNECT_CLIENTS.find(
    (c) => c.id !== "generic" && name.startsWith(c.label.toLowerCase()),
  );
}

/** The agent's display name: its Connect page label when it has one. */
export function agentLabel(agent: {
  clientId: string | null;
  name: string;
}): string {
  return connectClientFor(agent)?.label ?? agent.name;
}

/** The agent's logo, or its initial on a plain tile when it has none. */
export function AgentIcon({
  agent,
  size = 22,
}: {
  agent: { clientId: string | null; name: string };
  size?: number;
}) {
  const client = connectClientFor(agent);
  if (client) return <ClientIcon client={client} size={size} />;
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-md border bg-muted text-[10px] font-semibold uppercase text-muted-foreground"
      style={{ width: size, height: size }}
    >
      {agent.name.trim().charAt(0) || "?"}
    </span>
  );
}
