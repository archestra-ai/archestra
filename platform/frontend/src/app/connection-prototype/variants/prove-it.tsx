"use client";

import { RotateCcw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  CommandBlock,
  installCommand,
  ListeningCard,
  ProtoPage,
} from "../_parts/proto-ui";
import type { PrototypeVariantProps } from "../variants";

// Avenue F: the moment after install. The page waits for a real tool call
// (faked here after a few seconds) and hands over starter prompts.
export default function ProveItVariant({ scenario }: PrototypeVariantProps) {
  const [run, setRun] = useState(0);
  const clientId = "claude-code";

  return (
    <ProtoPage
      title="Last step: say hi to your tools"
      subtitle="Open Claude Code and ask it something. This page turns green when it uses a tool."
    >
      <CommandBlock code={installCommand("native", clientId)} />
      <ListeningCard key={run} clientId={clientId} scenario={scenario} />
      <div>
        <Button variant="ghost" size="sm" onClick={() => setRun(run + 1)}>
          <RotateCcw />
          <span>Replay</span>
        </Button>
      </div>
    </ProtoPage>
  );
}
