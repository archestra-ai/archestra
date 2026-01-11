"use client";

import { ShieldOff } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
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
    <div className="bg-red-500/10 border-b border-red-500/20 px-4 py-2 flex items-center justify-between gap-4">
      <div className="flex items-center gap-2 text-sm">
        <ShieldOff className="h-4 w-4 text-red-600" />
        <span className="text-red-700 dark:text-red-400">
          <span className="font-medium">
            Agentic security disabled for demo purposes:&nbsp;
          </span>
          agents can perform dangerous things without supervision.
        </span>
      </div>
      <div className="flex items-center gap-3">
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
          className="h-7 text-xs border-red-500/30 hover:bg-red-500/10"
          onClick={handleEnableRestrictive}
          disabled={updateOrgMutation.isPending}
        >
          Enable Security
        </Button>
      </div>
    </div>
  );
}
