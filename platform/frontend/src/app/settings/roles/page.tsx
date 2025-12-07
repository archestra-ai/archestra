"use client";

import { Suspense, use } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { EnterpriseLicenseRequired } from "@/components/enterprise-license-required";
import { LoadingSpinner } from "@/components/loading";
import config from "@/lib/config";

export default function RolesSettingsPage() {
  const { RolesList } = use(
    config.enterpriseLicenseActivated
      ? // biome-ignore lint/style/noRestrictedImports: conditional ee component with roles
        import("@/components/roles/roles-list.ee")
      : Promise.resolve({
          RolesList: () => (
            <EnterpriseLicenseRequired featureName="Custom Roles" />
          ),
        }),
  );

  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingSpinner />}>
        <RolesList />
      </Suspense>
    </ErrorBoundary>
  );
}
