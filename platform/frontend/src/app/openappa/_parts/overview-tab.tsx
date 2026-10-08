"use client";

import { BlockedCallsChart } from "./blocked-calls-chart";
import { CoverageCharts } from "./coverage-charts";
import { EntitiesTable } from "./entities-table";
import { OpenAppaChatStrip } from "./openappa-chat-strip";
import { OverviewSetupCards } from "./overview-setup-cards";
import { RemediesPanels } from "./remedies-panels";
import { TrustAudienceCard } from "./trust-audience-card";
import { useOpenAppaSetupState } from "./use-openappa-setup-state";

/** The visible policy targets whose tool calls can enter the OpenAPPA path. */
export function OverviewTab() {
  const { isFresh } = useOpenAppaSetupState();

  return (
    <div className="space-y-6">
      <OverviewSetupCards />
      {isFresh === false && (
        <>
          <OpenAppaChatStrip />
          <div className="grid gap-4 xl:grid-cols-5">
            <TrustAudienceCard className="xl:col-span-2" />
            <RemediesPanels />
          </div>
          <BlockedCallsChart />
          <section
            aria-labelledby="overview-policy-coverage"
            className="space-y-3"
          >
            <div className="space-y-1">
              <h2
                id="overview-policy-coverage"
                className="text-base font-semibold"
              >
                Policy coverage
              </h2>
              <p className="text-sm text-muted-foreground">
                How many of your tools a rule covers, and the batteries that
                could cover more.
              </p>
            </div>
            <CoverageCharts />
          </section>
          <section aria-labelledby="overview-mcp-servers" className="space-y-3">
            <div className="space-y-1">
              <h2 id="overview-mcp-servers" className="text-base font-semibold">
                MCP servers
              </h2>
              <p className="text-sm text-muted-foreground">
                Review and configure the rules for each MCP server
              </p>
            </div>
            <EntitiesTable />
          </section>
        </>
      )}
    </div>
  );
}
