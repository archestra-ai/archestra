"use client";

import { Route } from "lucide-react";
import { useParams } from "next/navigation";
import { EmptyState } from "@/components/empty-state";
import { PageBackLink } from "@/components/page-back-link";
import { PageLayout } from "@/components/page-layout";
import { QueryLoadError } from "@/components/query-load-error";
import { AutoRouterIdContext, useAutoRouter } from "@/lib/auto-routing.query";
import { RouterActions } from "../_parts/router-actions";
import { RouterStatus, routerStatus } from "../_parts/router-status";

/** One auto router: its models, budget, plan and what it routed. */
export default function AutoRouterLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { routerId } = useParams<{ routerId: string }>();
  return (
    <AutoRouterIdContext.Provider value={routerId}>
      <AutoRouterPage>{children}</AutoRouterPage>
    </AutoRouterIdContext.Provider>
  );
}

function AutoRouterPage({ children }: { children: React.ReactNode }) {
  const query = useAutoRouter();
  const router = query.data;
  const backLink = (
    <PageBackLink href="/llm/auto-routing">Back to Auto Routing</PageBackLink>
  );

  if (query.isLoadingError || router === null) {
    return (
      <PageLayout minWidth="phone" title="Auto router" backLink={backLink}>
        {router === null ? (
          <EmptyState
            icon={Route}
            title="Auto router not found"
            description="It may have been deleted."
          />
        ) : (
          <QueryLoadError
            title="Couldn't load this auto router"
            error={query.error}
            onRetry={() => query.refetch()}
          />
        )}
      </PageLayout>
    );
  }

  return (
    <PageLayout
      minWidth="phone"
      title={<span className="font-mono">{router?.name ?? ""}</span>}
      documentTitle={router?.name ?? "Auto router"}
      backLink={backLink}
      status={router ? <RouterStatus label={routerStatus(router)} /> : null}
      actionButton={<RouterActions />}
      description={
        <span>
          Requests for the model <code>{router?.name ?? "auto"}</code> go to
          this router&apos;s fast, normal or smart model, within its daily
          budget.
        </span>
      }
    >
      {router ? children : null}
    </PageLayout>
  );
}
