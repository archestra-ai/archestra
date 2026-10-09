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
const OPENAPPA_URL = "https://www.openappa.com/";

export function OpenAppaLicenceRequired() {
  return (
    <PageLayout title="Guardrails">
      <Empty className="py-16">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <OpenAppaIcon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>
            The OpenAPPA integration is an enterprise feature
          </EmptyTitle>
          <EmptyDescription>
            <a href={OPENAPPA_URL} target="_blank" rel="noreferrer">
              OpenAPPA
            </a>{" "}
            is an open-source policy engine that checks every tool call before
            it runs, so an agent that read an untrusted page cannot leak your
            data. Running it on your agents here takes an enterprise license.
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
