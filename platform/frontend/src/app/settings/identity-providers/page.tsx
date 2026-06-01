"use client";

import dynamic from "next/dynamic";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { EnterpriseLicenseRequired } from "@/components/enterprise-license-required";
import config from "@/lib/config/config";

const IdentityProvidersSettingsContent = dynamic(async () => {
  if (!config.enterpriseFeatures.core) {
    return () => <EnterpriseLicenseRequired featureName="Identity Providers" />;
  }

  // biome-ignore lint/style/noRestrictedImports: conditional EE component with identity providers
  const module = await import("./_parts/identity-providers-page.ee");
  return module.IdentityProvidersSettingsContent;
});

export default function IdentityProvidersSettingsPage() {
  return (
    <ErrorBoundary>
      <IdentityProvidersSettingsContent />
    </ErrorBoundary>
  );
}
