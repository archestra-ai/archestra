import { Suspense } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import SessionDetailPage from "./page.client";

export default function Page({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  return (
    <ErrorBoundary>
      <Suspense fallback={<div>Loading...</div>}>
        <SessionDetailPage paramsPromise={params} />
      </Suspense>
    </ErrorBoundary>
  );
}
