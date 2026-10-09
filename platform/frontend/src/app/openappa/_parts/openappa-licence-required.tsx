// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
"use client";

import { Mail } from "lucide-react";
import { OpenAppaIcon } from "@/components/openappa-icon";
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

export function OpenAppaLicenceRequired() {
  return (
    <PageLayout title="Guardrails">
      <Empty className="py-16">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <OpenAppaIcon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>OpenAPPA is an enterprise feature</EmptyTitle>
          <EmptyDescription>
            OpenAPPA checks every tool call against your policy before it runs,
            so an agent that read an untrusted page cannot leak your data. A
            prompt injection cannot change its decisions.
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
