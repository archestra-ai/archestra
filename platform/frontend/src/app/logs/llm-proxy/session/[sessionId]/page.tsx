import { Suspense } from "react";
import SessionDetailPage from "./page.client";

export default function Page({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <SessionDetailPage paramsPromise={params} />
    </Suspense>
  );
}
