"use client";

import { ShieldAlert } from "lucide-react";
import Link from "next/link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useOrganization } from "@/lib/organization.query";

export function PermissivePolicyWarning() {
  const { data: organization, isLoading } = useOrganization();

  if (isLoading || !organization) {
    return null;
  }

  if (organization.globalToolPolicy !== "permissive") {
    return null;
  }

  return (
    <div className="px-2 pb-2">
      <Alert variant="default" className="text-xs border-yellow-500/50 bg-yellow-500/10">
        <ShieldAlert className="h-4 w-4 text-yellow-600" />
        <AlertTitle className="text-xs font-semibold">
          Permissive Policy Enabled
        </AlertTitle>
        <AlertDescription className="text-xs mt-1">
          <p>All tool calls are allowed and results are trusted.</p>
          <p className="mt-1">
            <Link
              href="/settings/auto-policy"
              className="underline hover:no-underline"
            >
              Consider restricting in production
            </Link>
          </p>
        </AlertDescription>
      </Alert>
    </div>
  );
}
