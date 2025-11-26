"use client";

import { Suspense } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { LoadingSpinner } from "@/components/loading";
import { useSsoProviders } from "@/lib/sso-provider.query";

function SsoProvidersSettingsContent() {
  const { data: ssoProviders, isLoading: isLoadingSsoProviders } =
    useSsoProviders();

  if (isLoadingSsoProviders) return <LoadingSpinner />;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-8 w-full">
      <p>SSO Providers</p>
      <pre>{JSON.stringify(ssoProviders, null, 2)}</pre>
    </div>
  );
}

export default function SsoProvidersSettingsPage() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingSpinner />}>
        <SsoProvidersSettingsContent />
      </Suspense>
    </ErrorBoundary>
  );
}
