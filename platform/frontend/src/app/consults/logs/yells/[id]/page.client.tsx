"use client";

import { YellDetail } from "@/app/openappa/_parts/yell-detail";
import { PageLayout } from "@/components/page-layout";

/** One yell, under the Guardrails log it is listed in. */
export function YellDetailPage({ id }: { id: string }) {
  return (
    <PageLayout
      denseContent
      title="Yell"
      description="An agent's report of a block it could not make sense of or get past."
    >
      <YellDetail id={id} />
    </PageLayout>
  );
}
