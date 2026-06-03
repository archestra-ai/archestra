"use client";

import { useHasPermissions } from "@/lib/auth/auth.query";
import { NetworkPoliciesSection } from "../_parts/network-policies-section";

export default function NetworkPoliciesPageClient() {
  const { data: canEdit } = useHasPermissions({
    networkPolicy: ["create", "update", "delete"],
  });

  return (
    <div className="space-y-4">
      <NetworkPoliciesSection canEdit={canEdit ?? false} />
    </div>
  );
}
