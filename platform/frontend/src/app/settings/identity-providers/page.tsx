"use client";

import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { EnterpriseLicenseRequired } from "@/components/enterprise-license-required";
import config from "@/lib/config";

const { IdentityProvidersSettingsContent } = config.enterpriseLicenseActivated
  ? // biome-ignore lint/style/noRestrictedImports: conditional ee component with identity providers
    await import("./_parts/identity-providers-page.ee")
  : {
      IdentityProvidersSettingsContent: () => (
        <EnterpriseLicenseRequired featureName="Identity Providers" />
      ),
    };

export default function IdentityProvidersSettingsPage() {
  return (
    <ErrorBoundary>
      <IdentityProvidersSettingsContent />
    </ErrorBoundary>
  );
}
