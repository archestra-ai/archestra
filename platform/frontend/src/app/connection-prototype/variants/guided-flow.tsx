"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  CommandBlock,
  EmptyGatewayNotice,
  ExampleAsks,
  InstallPlan,
  installCommand,
  ListeningCard,
  ProtoClientGrid,
  ProtoPage,
  ProtoSection,
  ServerLogos,
  ValueCounts,
} from "../_parts/proto-ui";
import type { PrototypeVariantProps } from "../variants";

// The core six-step flow from the ideation doc, end to end on one page.
export default function GuidedFlowVariant({ scenario }: PrototypeVariantProps) {
  const [clientId, setClientId] = useState<string | null>(null);
  const [installed, setInstalled] = useState(false);

  return (
    <ProtoPage
      title="Give your agent access to your company's tools"
      subtitle="One install. You can see everything it does, and undo it in one click."
    >
      <ProtoSection step={1} title="What you get">
        {scenario.servers.length === 0 ? (
          <EmptyGatewayNotice />
        ) : (
          <div className="flex flex-col gap-4 rounded-lg border bg-card p-4">
            <ValueCounts scenario={scenario} />
            <ServerLogos scenario={scenario} limit={6} />
            <ExampleAsks scenario={scenario} />
          </div>
        )}
      </ProtoSection>

      <ProtoSection
        step={2}
        title="Pick your agent"
        description="Works with any agent that supports remote MCP. These are shortcuts."
      >
        <ProtoClientGrid
          selected={clientId}
          onSelect={(id) => {
            setClientId(id);
            setInstalled(false);
          }}
        />
      </ProtoSection>

      <ProtoSection
        step={3}
        title="What this install does"
        description="Nothing here is hidden. Each piece says how to undo it."
        muted={!clientId}
      >
        <InstallPlan layout="collapsed" toggles />
      </ProtoSection>

      <ProtoSection step={4} title="Run it" muted={!clientId}>
        {clientId ? (
          <>
            <CommandBlock code={installCommand("hybrid", clientId)} />
            <div>
              <Button onClick={() => setInstalled(true)}>I ran it</Button>
            </div>
          </>
        ) : null}
      </ProtoSection>

      <ProtoSection step={5} title="Prove it works" muted={!installed}>
        {installed && clientId ? (
          <ListeningCard clientId={clientId} scenario={scenario} />
        ) : null}
      </ProtoSection>
    </ProtoPage>
  );
}
