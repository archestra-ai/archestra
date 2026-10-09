// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
"use client";

import { Mail } from "lucide-react";
import { OpenAppaSolidIcon } from "@/components/openappa-icon";
import { PageLayout } from "@/components/page-layout";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

const SALES_EMAIL = "sales@archestra.ai";
const OPENAPPA_URL = "https://www.openappa.com/";

export function OpenAppaLicenceRequired() {
  return (
    <PageLayout title="Guardrails">
      <Empty className="py-16">
        <EmptyHeader>
          <EmptyMedia>
            <OpenAppaSolidIcon className="h-20 w-auto text-foreground" />
          </EmptyMedia>
          <EmptyTitle>Guardrails are part of Platform + AI Security</EmptyTitle>
          <EmptyDescription>
            <a href={OPENAPPA_URL} target="_blank" rel="noreferrer">
              OpenAPPA
            </a>
            , frontier technology developed by Archestra Inc, prevents data
            exfiltration by AI agents. Benchmarked at 0% attack success rate
            across 1,320 evaluations on Bench-Corp and AgentThreatBench (OWASP
            Top 10 for Agentic Applications) with 89% task completion. Backed by
            NeurIPS-accepted research.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild>
            <a href={`mailto:${SALES_EMAIL}`}>
              <Mail aria-hidden="true" />
              Contact {SALES_EMAIL}
            </a>
          </Button>
        </EmptyContent>
      </Empty>
    </PageLayout>
  );
}
