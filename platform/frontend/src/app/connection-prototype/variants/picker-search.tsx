"use client";

import { Search } from "lucide-react";
import { useState } from "react";
import { CONNECT_CLIENTS } from "@/app/connection/clients";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ClientLine,
  CommandBlock,
  GuardrailBadge,
  MOCK_GATEWAY_URL,
  ProtoPage,
} from "../_parts/proto-ui";
import type { PrototypeVariantProps } from "../variants";

// Avenue C: one searchable list, capability badges per agent, and a
// "not listed?" escape hatch that reads as first-class.
export default function PickerSearchVariant(_props: PrototypeVariantProps) {
  const [query, setQuery] = useState("");
  const matches = CONNECT_CLIENTS.filter(
    (client) =>
      client.id !== "generic" &&
      client.label.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <ProtoPage
      title="Connect any agent"
      subtitle="Works with any agent that supports remote MCP (HTTP + OAuth)."
    >
      <div className="relative">
        <Search className="absolute top-2.5 left-3 size-4 text-muted-foreground" />
        <Input
          className="pl-9"
          placeholder="Search for your agent (try “Hermes”)"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="divide-y rounded-lg border bg-card">
        {matches.map((client) => (
          <div key={client.id} className="p-3">
            <ClientLine clientId={client.id}>
              <GuardrailBadge clientId={client.id} />
              <Button size="sm" variant="outline">
                Connect
              </Button>
            </ClientLine>
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-2 rounded-lg border border-dashed p-4">
        <div className="font-medium">
          <span>
            {matches.length === 0
              ? `“${query}” isn't listed, and that's fine`
              : "Not listed?"}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          If your agent can add a remote MCP server, paste this URL and sign in
          when it asks.
        </p>
        <CommandBlock code={MOCK_GATEWAY_URL} />
      </div>
    </ProtoPage>
  );
}
