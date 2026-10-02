"use client";

import { ChevronDown, Undo2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  CommandBlock,
  getClient,
  InstallPlan,
  installCommand,
  ProtoClientGrid,
  ProtoPage,
} from "../_parts/proto-ui";
import type { PrototypeVariantProps } from "../variants";

// Avenue D, minimal: one command, one line of "what's included", details on
// demand and read-only because the org decides.
export default function PlanCollapsedVariant(_props: PrototypeVariantProps) {
  const [clientId, setClientId] = useState<string | null>("claude-code");
  const [showPlan, setShowPlan] = useState(false);

  return (
    <ProtoPage title="Connect your agent">
      <ProtoClientGrid selected={clientId} onSelect={setClientId} />
      {clientId ? (
        <div className="flex flex-col gap-3">
          <CommandBlock code={installCommand("hybrid", clientId)} />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <span>
              Installs your tools, skills, model routing and guardrails in{" "}
              {getClient(clientId).label}.
            </span>
            <Button
              variant="link"
              className="h-auto p-0"
              onClick={() => setShowPlan(!showPlan)}
            >
              <span>What's included</span>
              <ChevronDown className="size-3" />
            </Button>
          </div>
          {showPlan ? <InstallPlan layout="collapsed" toggles={false} /> : null}
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Undo2 className="size-3" />
            <span>
              Changed your mind? Disconnect from this page any time. It cuts
              access everywhere instantly.
            </span>
          </div>
        </div>
      ) : null}
    </ProtoPage>
  );
}
