"use client";

import dynamic from "next/dynamic";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { DisabledEnterpriseSection } from "@/components/disabled-enterprise-section";
import { SmallTeamTierBanner } from "@/components/small-team-tier-banner";
import { useEnterpriseFeature } from "@/lib/config/config.query";

export default function PermissionsSettingsPage() {
  const enterpriseCoreActive = useEnterpriseFeature("core");
  return (
    <ErrorBoundary>
      <SmallTeamTierBanner featureName="resource permissions" />
      <DisabledEnterpriseSection disabled={!enterpriseCoreActive}>
        <OrganizationPermissions />
      </DisabledEnterpriseSection>
    </ErrorBoundary>
  );
}

const OrganizationPermissions = dynamic(() =>
  // biome-ignore lint/style/noRestrictedImports: dual-licensed at request time
  import("@/components/permissions/organization-permissions.ee").then((m) => ({
    default: m.OrganizationPermissions,
  })),
);
