"use client";

import { ShieldOff } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { useGuardrailsDeployment } from "@/lib/guardrails-deployment.query";
import { EntitiesTable } from "./entities-table";

/** The visible policy targets whose tool calls can enter the OpenAPPA path. */
export function OverviewTab() {
  const deployment = useGuardrailsDeployment();
  return (
    <div className="space-y-6">
      {deployment.data?.enabled === false && (
        <InlineNotice variant="warning">
          <ShieldOff />
          <span className="font-medium">OpenAPPA is off.</span>
          <InlineNoticeText>
            Tool calls are not checked. The setup walks you through a first rule
            and turns it on.
          </InlineNoticeText>
          <Button size="sm" className="ml-auto h-7" asChild>
            <Link href="/openappa/setup">Set up OpenAPPA</Link>
          </Button>
        </InlineNotice>
      )}
      <section aria-labelledby="overview-policy-targets" className="space-y-3">
        <div className="space-y-1">
          <h2 id="overview-policy-targets" className="text-base font-semibold">
            Policy targets
          </h2>
          <p className="text-sm text-muted-foreground">
            Agents, MCP gateways, and MCP servers you can access. Open a target
            to see which of its tools have an active rule and which may use the
            catch-all. Auto mode counts include tools you can currently
            discover.
          </p>
        </div>
        <EntitiesTable />
      </section>
    </div>
  );
}
