"use client";

import { usePathname } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  CompactFilterExtrasProvider,
  useCompactFilters,
} from "@/components/filter-bar";
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
  description,
  children,
}: {
  /** The list route this segment's header belongs to, e.g. `/llm/logs`. */
  listPath: string;
  /** Replaces the shared Logs description while this tab is shown. */
  description?: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const config = useLogsLayoutConfig();
  const [actionButton, setActionButton] = useState<ReactNode>(null);
  const contextValue = useMemo(() => ({ setActionButton }), []);
  const compact = useCompactFilters();

  if (pathname !== listPath) return <>{children}</>;

  return (
    <LogsActionContext.Provider value={contextValue}>
      {/* On compact screens the time range joins the page's filter popover,
          next to the filters it narrows alongside. */}
      <CompactFilterExtrasProvider extras={compact ? actionButton : null}>
        {({ claimed }) => (
          <PageLayout
            {...config}
            description={description ?? config.description}
            actionButton={claimed ? null : actionButton}
          >
            {children}
          </PageLayout>
        )}
      </CompactFilterExtrasProvider>
    </LogsActionContext.Provider>
  );
}

/**
 * Puts `action` in the Logs header's top-right corner while the calling page
 * is shown — where every log page keeps its time range. On compact screens it
 * moves into the page's filter popover instead, when the page has one.
 */
export function useLogsHeaderAction(action: ReactNode) {
  const { setActionButton } = useContext(LogsActionContext);
  useEffect(() => {
    setActionButton(action);
  }, [action, setActionButton]);
  useEffect(() => () => setActionButton(null), [setActionButton]);
}

const LogsActionContext = createContext<{
  setActionButton: (action: ReactNode) => void;
}>({ setActionButton: () => {} });
