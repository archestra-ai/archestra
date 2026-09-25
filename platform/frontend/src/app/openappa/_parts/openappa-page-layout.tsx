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

export function OpenAppaPageLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const appName = useAppName();

  return (
    <PageLayout
      title="OpenAPPA"
      description={`${appName}'s guardrail against data leaks. Every tool call is checked before it runs.`}
      tabs={[
        { label: "Overview", href: "/openappa" },
        { label: "Batteries", href: "/openappa/batteries" },
        { label: "Policy", href: "/openappa/policy" },
      ]}
      actionButton={
        pathname === "/openappa/policy" ? (
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
