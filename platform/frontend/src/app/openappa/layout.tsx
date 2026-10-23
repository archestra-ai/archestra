"use client";

import { notFound } from "next/navigation";
import { PageLayout } from "@/components/page-layout";
import { QueryLoadError } from "@/components/query-load-error";
import { useConfig } from "@/lib/config/config.query";
import { OpenAppaLicenceRequired } from "./_parts/openappa-licence-required";
import { OpenAppaPageLayout } from "./_parts/openappa-page-layout";

export default function OpenAppaLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // The shell already holds the config (seeded at boot, restored on refresh),
  // so choosing between the product and the licence page costs no request.
  const {
    data: config,
    isPending,
    isLoadingError,
    error,
    refetch,
  } = useConfig();
  if (isPending) return null;
  if (isLoadingError) {
    return (
      <PageLayout title="Guardrails">
        <QueryLoadError
          title="Couldn't load Guardrails"
          error={error}
          onRetry={() => refetch()}
        />
      </PageLayout>
    );
  }
  if (!config) notFound();
  // OpenAPPA is only ever off for want of a licence.
  if (!config.features.openappaEnabled)
    return <OpenAppaLicenceRequired tier={config.smallTeamTier} />;

  return <OpenAppaPageLayout>{children}</OpenAppaPageLayout>;
}
