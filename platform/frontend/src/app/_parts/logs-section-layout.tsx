"use client";

import { usePathname } from "next/navigation";
import { PageLayout } from "@/components/page-layout";
import { useLogsLayoutConfig } from "@/lib/audit-log/use-logs-layout-config";

/**
 * The shared "Logs" header — title, description and the LLM Proxy / MCP
 * Gateway / Audit tabs — for one of the three log list pages.
 *
 * A detail route under the same segment is handed through untouched. The
 * detail pages state the record they are about in their own `PageLayout`
 * header: the session's own name, the tool that was called. Under this layout
 * they inherited the section header instead, so the page said "Logs" while
 * "Back to Sessions" and the record's own title were stranded in the body,
 * below the tab bar, as the first two rows of content. That is also why the
 * detail pages get no tab bar: the tabs answer "which log am I reading?",
 * which the reader of one record has already answered.
 */
export function LogsSectionLayout({
  listPath,
  children,
}: {
  /** The list route this segment's header belongs to, e.g. `/llm/logs`. */
  listPath: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const config = useLogsLayoutConfig();

  if (pathname !== listPath) return <>{children}</>;

  return <PageLayout {...config}>{children}</PageLayout>;
}
