"use client";

import dynamic from "next/dynamic";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { DisabledEnterpriseSection } from "@/components/disabled-enterprise-section";
import { SmallTeamTierBanner } from "@/components/small-team-tier-banner";
import { useEnterpriseFeature } from "@/lib/config/config.query";

const IdentityProvidersSettingsContent = dynamic(() =>
  // biome-ignore lint/style/noRestrictedImports: dual-licensed at request time
  import("./_parts/identity-providers-page.ee").then((m) => ({
    default: m.IdentityProvidersSettingsContent,
  })),
);

export default function IdentityProvidersSettingsPage() {
  const enterpriseCoreActive = useEnterpriseFeature("core");
  return (
    <ErrorBoundary>
      <SmallTeamTierBanner featureName="SSO" />
      <DisabledEnterpriseSection disabled={!enterpriseCoreActive}>
        <IdentityProvidersSettingsContent />
      </DisabledEnterpriseSection>
    </ErrorBoundary>
  );
}
