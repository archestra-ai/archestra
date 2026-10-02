"use client";

import { useState } from "react";
import {
  CommandBlock,
  EmptyGatewayNotice,
  ExampleAsks,
  installCommand,
  ProtoClientGrid,
  ProtoPage,
  ServerLogos,
  ValueCounts,
} from "../_parts/proto-ui";
import type { PrototypeVariantProps } from "../variants";

// Avenue A, placed beside the picker: value stays visible while you act.
export default function ValueBesideVariant({
  scenario,
}: PrototypeVariantProps) {
  const [clientId, setClientId] = useState<string | null>("claude-code");

  return (
    <ProtoPage title="Connect your agent" width="wide">
      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="flex flex-col gap-4">
          <ProtoClientGrid selected={clientId} onSelect={setClientId} />
          {clientId ? (
            <CommandBlock code={installCommand("hybrid", clientId)} />
          ) : null}
        </div>
        <aside className="flex flex-col gap-4 rounded-xl border bg-muted/30 p-4 lg:sticky lg:top-16 lg:self-start">
          <div className="text-sm font-semibold">You'll get</div>
          {scenario.servers.length === 0 ? (
            <EmptyGatewayNotice />
          ) : (
            <>
              <ValueCounts scenario={scenario} />
              <ServerLogos scenario={scenario} limit={4} />
              <ExampleAsks scenario={scenario} title="Try asking" />
            </>
          )}
        </aside>
      </div>
    </ProtoPage>
  );
}
