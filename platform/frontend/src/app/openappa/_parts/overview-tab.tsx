"use client";

import { CoverageCharts } from "./coverage-charts";
import { EntitiesTable } from "./entities-table";
import { OverviewSetupCards } from "./overview-setup-cards";
import { useOpenAppaSetupState } from "./use-openappa-setup-state";

/** The visible policy targets whose tool calls can enter the OpenAPPA path. */
export function OverviewTab() {
  const { isFresh } = useOpenAppaSetupState();

  return (
    <div className="space-y-6">
      <OverviewSetupCards />
      {isFresh === false && (
        <>
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
          <section
            aria-labelledby="overview-servers-and-gateways"
            className="space-y-3"
          >
            <h2
              id="overview-servers-and-gateways"
              className="text-base font-semibold"
            >
              Servers and gateways
            </h2>
            <EntitiesTable />
          </section>
        </>
      )}
    </div>
  );
}
