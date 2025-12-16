"use client";

import { Suspense } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { EnterpriseLicenseRequired } from "@/components/enterprise-license-required";
import { LoadingSpinner } from "@/components/loading";
import config from "@/lib/config";

const { SsoProvidersSettingsContent } = config.enterpriseLicenseActivated
  ? // biome-ignore lint/style/noRestrictedImports: conditional ee component with SSO
    await import("./_parts/sso-page.ee")
  : {
      SsoProvidersSettingsContent: () => (
        <EnterpriseLicenseRequired featureName="SSO" />
      ),
    };

export default function SsoProvidersSettingsPage() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingSpinner />}>
        <SsoProvidersSettingsContent />
      </Suspense>
    </ErrorBoundary>
  );
}
