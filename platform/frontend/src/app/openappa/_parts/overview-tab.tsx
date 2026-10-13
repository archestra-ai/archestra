"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { RulesCard } from "./coverage-charts";
import { EntitiesTable } from "./entities-table";
import { OpenAppaChatStrip } from "./openappa-chat-strip";
import { OverviewSetupCards } from "./overview-setup-cards";
import { RemediesCard } from "./remedies-panels";
import { LabelCard } from "./trust-audience-card";
import { useOpenAppaSetupState } from "./use-openappa-setup-state";

/** The visible policy targets whose tool calls can enter the OpenAPPA path. */
export function OverviewTab() {
  const { isFresh } = useOpenAppaSetupState();

  return (
    <div className="space-y-7">
      <OverviewSetupCards />
      {isFresh === false && (
        <>
          <OpenAppaChatStrip />
          <section
            aria-labelledby="overview-how-it-decides"
            className="space-y-3"
          >
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="space-y-1">
                <h2
                  id="overview-how-it-decides"
                  className="text-base font-semibold"
                >
                  How your policy decides
                </h2>
                <p className="text-sm text-muted-foreground">
                  Every agent session carries a label. Reading data changes it,
                  and the label decides which calls get blocked.
                </p>
              </div>
              <Button size="sm" variant="ghost" asChild>
                <Link href="/openappa/policy">View policy</Link>
              </Button>
            </div>
            <div className="grid gap-3 lg:grid-cols-3">
              <LabelCard />
              <RulesCard />
              <RemediesCard />
            </div>
          </section>
          <section aria-labelledby="overview-mcp-servers" className="space-y-3">
            <div className="space-y-1">
              <h2 id="overview-mcp-servers" className="text-base font-semibold">
                MCP servers
              </h2>
              <p className="text-sm text-muted-foreground">
                Review and configure the rules for each MCP server.
              </p>
            </div>
            <EntitiesTable />
          </section>
        </>
      )}
    </div>
  );
}
