"use client";

import { usePathname } from "next/navigation";
import {
  type ComponentProps,
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

/**
 * The header — title, description and a top-right action slot for the time
 * range — of a list page whose segment also holds detail routes.
 *
 * A detail route under the same segment is handed through untouched: detail
 * pages state the record they are about in their own `PageLayout` header.
 */
export function LogsSectionLayout({
  listPath,
  title,
  description,
  tabs,
  children,
}: {
  /** The list route this segment's header belongs to. */
  listPath: string;
  title: string;
  description: string;
  /** Header tabs for views of the list route. */
  tabs?: ComponentProps<typeof PageLayout>["tabs"];
  children: ReactNode;
}) {
  const pathname = usePathname();
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
            title={title}
            description={description}
            actionButton={claimed ? null : actionButton}
            tabs={tabs}
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
