"use client";

import { ShieldOff } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { WarningBar } from "@/components/ui/warning-bar";
import { useFeatures } from "@/lib/features.query";
import { useUpdateOrganization } from "@/lib/organization.query";

export function PermissivePolicyBar() {
  const { data: features, isLoading } = useFeatures();
  const updateOrgMutation = useUpdateOrganization(
    "Agentic security enabled",
    "Failed to update agentic security",
  );

  const isPermissive =
    !isLoading && features?.globalToolPolicy === "permissive";

  if (!isPermissive) {
    return null;
  }

  const handleEnableRestrictive = () => {
    updateOrgMutation.mutate({ globalToolPolicy: "restrictive" });
  };

  return (
    <WarningBar
      icon={<ShieldOff className="h-4 w-4" />}
      actions={
        <>
          <Link
            href="/settings/security"
            className="text-xs text-red-700 dark:text-red-400 hover:underline"
          >
            Go to Security Settings
          </Link>
          <div className="h-4 w-px bg-red-500/30" />
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs border-red-500/30 hover:bg-red-500/10 hover:text-red-700"
            onClick={handleEnableRestrictive}
            disabled={updateOrgMutation.isPending}
          >
            Enable Security
          </Button>
        </>
      }
    >
      Agentic security disabled for demo purposes: agents can perform dangerous
      things without supervision.
    </WarningBar>
  );
}
