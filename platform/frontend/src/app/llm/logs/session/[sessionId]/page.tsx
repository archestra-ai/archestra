import { Suspense } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { LoadingState } from "@/components/loading";
import SessionDetailPage from "./page.client";

export default function Page({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  return (
    <ErrorBoundary>
      <Suspense
        fallback={
          <LoadingState label="Loading session logs…" variant="viewport" />
        }
      >
        <SessionDetailPage paramsPromise={params} />
      </Suspense>
    </ErrorBoundary>
  );
}
