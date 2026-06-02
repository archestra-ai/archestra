"use client";

import { useHasPermissions } from "@/lib/auth/auth.query";
import { EnvironmentsSection } from "../_parts/environments-section";

export default function EnvironmentsPageClient() {
  const { data: canEdit } = useHasPermissions({
    environment: ["create", "update", "delete"],
  });
  const { data: canReadNetworkPolicies } = useHasPermissions({
    networkPolicy: ["read"],
  });

  return (
    <div className="space-y-4">
      <EnvironmentsSection
        canEdit={canEdit ?? false}
        canReadNetworkPolicies={canReadNetworkPolicies ?? false}
      />
    </div>
  );
}
