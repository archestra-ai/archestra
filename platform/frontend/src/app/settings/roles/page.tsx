"use client";

import { Suspense } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { EnterpriseLicenseRequired } from "@/components/enterprise-license-required";
import { PredefinedRolesList } from "@/components/roles/predefined-roles-list";
import { LoadingSpinner } from "@/components/loading";
import config from "@/lib/config";

const { CustomRolesList } = config.enterpriseLicenseActivated
  ? // biome-ignore lint/style/noRestrictedImports: conditional ee component with roles
    await import("@/components/roles/custom-roles.ee")
  : {
    CustomRolesList: () => <EnterpriseLicenseRequired featureName="Custom Roles" />,
    };

function RolesSettingsContent() {
  return <><PredefinedRolesList /><CustomRolesList /></>;
}

export default function RolesSettingsPage() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingSpinner />}>
        <RolesSettingsContent />
      </Suspense>
    </ErrorBoundary>
  );
}
