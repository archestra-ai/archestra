"use client";

import { MessageCircle } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { PageLayout } from "@/components/page-layout";
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
      title="OpenAPPA"
      description={`${appName}'s guardrail against data leaks. Every tool call is checked before it runs.`}
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
