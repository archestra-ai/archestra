"use client";

import { ArrowLeft, MessageCircle } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { PageLayout } from "@/components/page-layout";
import { Button } from "@/components/ui/button";
import { BatteriesUploadAction } from "./batteries-panel";

export function OpenAppaPageLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isChat = pathname === "/openappa/configure";

  return (
    <PageLayout
      fillContent={isChat}
      title="OpenAPPA"
      description="Manage the policy that governs tool calls and their results."
      backLink={
        isChat ? (
          <Link
            href="/openappa"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            OpenAPPA / Configure
          </Link>
        ) : undefined
      }
      tabs={
        isChat
          ? []
          : [
              { label: "Overview", href: "/openappa" },
              { label: "Batteries", href: "/openappa/batteries" },
              { label: "Policy", href: "/openappa/policy" },
            ]
      }
      actionButton={
        pathname === "/openappa" ? (
          <Button asChild>
            <Link href="/openappa/configure">
              <MessageCircle />
              <span>Configure with chat</span>
            </Link>
          </Button>
        ) : isChat ? (
          <Button variant="outline" asChild>
            <Link href="/openappa">
              <ArrowLeft />
              <span>Overview</span>
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
