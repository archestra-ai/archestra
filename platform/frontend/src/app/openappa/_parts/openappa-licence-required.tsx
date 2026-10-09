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

// The tier comes from the same server fetch that chose this page: the
// client's config cache can lag behind and contradict that choice.
export function OpenAppaLicenceRequired({
  tier,
}: {
  tier: { threshold: number; userCount: number };
}) {
  return (
    <PageLayout title="Guardrails">
      <Empty className="py-16">
        <EmptyHeader>
          <EmptyMedia>
            <OpenAppaSolidIcon className="h-20 w-auto text-foreground" />
          </EmptyMedia>
          <EmptyTitle>Stop your agents from leaking data</EmptyTitle>
          <EmptyDescription>
            <a href={OPENAPPA_URL} target="_blank" rel="noreferrer">
              OpenAPPA
            </a>{" "}
            blocked every attack across 1,320 evaluations while agents still
            finished 89% of their tasks. Backed by NeurIPS-accepted research.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <p className="text-sm text-muted-foreground">
            Free for teams under {tier.threshold} users. This instance has{" "}
            {tier.userCount}.
          </p>
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
