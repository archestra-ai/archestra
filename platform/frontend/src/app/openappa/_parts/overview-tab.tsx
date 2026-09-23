"use client";

import { EntitiesTable } from "./entities-table";

/** The visible policy targets whose tool calls can enter the OpenAPPA path. */
export function OverviewTab() {
  return (
    <section aria-labelledby="overview-policy-targets" className="space-y-3">
      <div className="space-y-1">
        <h2 id="overview-policy-targets" className="text-base font-semibold">
          Policy targets
        </h2>
        <p className="text-sm text-muted-foreground">
          Agents, MCP gateways, and MCP servers you can access. Open a target to
          see which of its tools have an active rule and which may use the
          catch-all. Auto mode counts include tools you can currently discover.
        </p>
      </div>
      <EntitiesTable />
    </section>
  );
}
