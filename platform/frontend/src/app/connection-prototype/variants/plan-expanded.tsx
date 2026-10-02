"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  CommandBlock,
  InstallPlan,
  installCommand,
  ProtoClientGrid,
  ProtoPage,
  ProtoSection,
} from "../_parts/proto-ui";
import type { PrototypeVariantProps } from "../variants";

// Avenue D: the whole plan spelled out up front, with toggles.
export default function PlanExpandedVariant(_props: PrototypeVariantProps) {
  const [clientId, setClientId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  return (
    <ProtoPage
      title="Connect your agent"
      subtitle="Here's exactly what gets installed. Turn off anything you don't want."
    >
      <ProtoSection step={1} title="Pick your agent">
        <ProtoClientGrid selected={clientId} onSelect={setClientId} />
      </ProtoSection>
      <ProtoSection step={2} title="Review the install" muted={!clientId}>
        <InstallPlan layout="expanded" toggles />
        <div>
          <Button disabled={!clientId} onClick={() => setReady(true)}>
            Looks good, give me the command
          </Button>
        </div>
      </ProtoSection>
      {ready && clientId ? (
        <ProtoSection step={3} title="Run this">
          <CommandBlock code={installCommand("script", clientId)} />
        </ProtoSection>
      ) : null}
    </ProtoPage>
  );
}
