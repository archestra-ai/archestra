"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { PageLayout } from "@/components/page-layout";
import { BatteriesUploadAction } from "./batteries-panel";

export function OpenAppaPageLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const conversationPath =
    pathname.startsWith("/openappa/") &&
    pathname !== "/openappa/batteries" &&
    pathname !== "/openappa/policy";

  return (
    <PageLayout
      title="OpenAPPA"
      description="Manage the policy that governs tool calls and their results."
      tabs={[
        {
          label: "Overview",
          href: "/openappa",
          selected: pathname === "/openappa",
        },
        { label: "Chat", href: "/openappa/chat", selected: conversationPath },
        { label: "Batteries", href: "/openappa/batteries" },
        { label: "Policy", href: "/openappa/policy" },
      ]}
      actionButton={<BatteriesUploadAction />}
    >
      {children}
    </PageLayout>
  );
}
