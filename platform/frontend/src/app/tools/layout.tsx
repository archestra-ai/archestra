"use client";

import { usePathname } from "next/navigation";
import { PageLayout } from "@/components/page-layout";

export default function ToolsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const segments = pathname.split("/").filter(Boolean);
  const isDetailPage = segments[0] === "tools" && segments.length >= 3;

  if (isDetailPage) {
    return <>{children}</>;
  }

  return (
    <PageLayout
      title="Tools"
      description="Tools displayed here are either detected from requests between agents and LLMs or sourced from installed MCP servers."
    >
      {children}
    </PageLayout>
  );
}
