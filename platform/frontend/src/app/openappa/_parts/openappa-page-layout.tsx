"use client";

import { MessageCircle } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { PageLayout } from "@/components/page-layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAppName } from "@/lib/hooks/use-app-name";
import { openAppaChatHref } from "@/lib/openappa-routes";
import { BatteriesUploadAction } from "./batteries-panel";
import { useOpenAppaSetupState } from "./use-openappa-setup-state";

export function OpenAppaPageLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const appName = useAppName();
  const { isFresh } = useOpenAppaSetupState();
  // Until a policy is saved, the Overview shows only that first step.
  const firstStepOnly = isFresh === true && pathname === "/openappa";

  return (
    <PageLayout
      // Maturity, not runtime state, so it belongs to the name rather than to
      // the `status` pill beside it. Laid out inline with a real space rather
      // than a flex gap: a CSS gap leaves no separator in the accessible name,
      // which a screen reader then reads as one word.
      title={
        <span>
          Guardrails{" "}
          <Badge variant="secondary" className="align-middle">
            Alpha
          </Badge>
        </span>
      }
      documentTitle="Guardrails"
      description={`${appName} runs unique deterministic guardrails that stop AI from leaking sensitive corporate data, built on OpenAPPA.`}
      tabs={
        firstStepOnly
          ? []
          : [
              { label: "Overview", href: "/openappa" },
              { label: "Batteries", href: "/openappa/batteries" },
              { label: "Policy", href: "/openappa/policy" },
            ]
      }
      actionButton={
        firstStepOnly ? null : pathname === "/openappa/policy" ? (
          <Button asChild>
            <Link href={openAppaChatHref({ promptKey: "explainPolicy" })}>
              <MessageCircle />
              <span>Configure with chat</span>
            </Link>
          </Button>
        ) : (
          <BatteriesUploadAction />
        )
      }
    >
      {children}
    </PageLayout>
  );
}
