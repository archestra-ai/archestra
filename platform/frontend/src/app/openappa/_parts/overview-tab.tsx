"use client";

import { Info, MessageCircle, ShieldOff } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { openAppaChatHref } from "@/lib/openappa-routes";
import { CoverageCharts } from "./coverage-charts";
import { EntitiesTable } from "./entities-table";
import {
  OpenAppaWelcomeDialog,
  useOpenAppaWelcome,
} from "./openappa-welcome-dialog";
import { OverviewSetupCards } from "./overview-setup-cards";
import { useOpenAppaSetupState } from "./use-openappa-setup-state";

/** The visible policy targets whose tool calls can enter the OpenAPPA path. */
export function OverviewTab() {
  const { isFresh } = useOpenAppaSetupState();
  const welcome = useOpenAppaWelcome(isFresh);

  return (
    <div className="space-y-6">
      <OverviewSetupCards />
      {isFresh ? (
        <NotSetUpYet onShowWelcome={welcome.show} />
      ) : isFresh === false ? (
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
      ) : null}
      <OpenAppaWelcomeDialog
        open={welcome.open}
        onOpenChange={welcome.onOpenChange}
      />
    </div>
  );
}

/**
 * Stands in for policy coverage and the servers and gateways while enforcement is off
 * and no policy is saved: every tool would fall to the catch-all, so the
 * numbers say nothing yet.
 */
function NotSetUpYet({ onShowWelcome }: { onShowWelcome: () => void }) {
  return (
    <Empty className="border md:p-10">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ShieldOff />
        </EmptyMedia>
        <EmptyTitle className="text-base">
          Coverage appears once the guardrail is on
        </EmptyTitle>
        <EmptyDescription>
          Tool calls aren&apos;t checked yet. Set up the guardrail with chat,
          and this page will show which tools it protects.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="flex-row flex-wrap justify-center gap-2">
        <Button asChild>
          <Link href={openAppaChatHref({ promptKey: "setUpPolicy" })}>
            <MessageCircle />
            <span>Set up with chat</span>
          </Link>
        </Button>
        <Button variant="outline" onClick={onShowWelcome}>
          <Info />
          <span>How it works</span>
        </Button>
      </EmptyContent>
    </Empty>
  );
}
