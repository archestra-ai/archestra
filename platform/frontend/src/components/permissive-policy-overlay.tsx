"use client";

import { ShieldOff } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useFeatures } from "@/lib/features.query";
import { useUpdateOrganization } from "@/lib/organization.query";

interface PermissivePolicyOverlayProps {
  children: ReactNode;
}

export function PermissivePolicyOverlay({
  children,
}: PermissivePolicyOverlayProps) {
  const { data: features, isLoading } = useFeatures();
  const updateOrgMutation = useUpdateOrganization(
    "Agentic security enabled",
    "Failed to enable agentic security",
  );

  const isPermissive =
    !isLoading && features?.globalToolPolicy === "permissive";

  const handleEnableRestrictive = () => {
    updateOrgMutation.mutate({ globalToolPolicy: "restrictive" });
  };

  return (
    <div className="relative">
      {children}
      {isPermissive && (
        <>
          <div
            data-label="Permissive policy overlay"
            className="absolute inset-0 bg-background/60 dark:bg-background/60 rounded-lg z-10"
          />
          <div className="absolute inset-x-0 top-0 bottom-0 z-20 pointer-events-none">
            <div className="sticky top-1/3 flex justify-center pointer-events-auto">
              <div className="text-center p-6 max-w-md bg-background border rounded-lg shadow-lg">
                <ShieldOff className="w-10 h-10 mx-auto mb-3 text-orange-500" />
                <h3 className="font-semibold text-lg mb-2">
                  Agentic Security Disabled
                </h3>
                <p className="text-sm text-muted-foreground mb-4">
                  All agent tool calls are allowed and all results are trusted.
                  Individual policies are bypassed. To set individual policies,
                  enable agentic security here or in&nbsp;
                  <Link href="/settings/security" className="underline">
                    Security Settings
                  </Link>
                </p>
                <Button
                  variant="default"
                  size="sm"
                  onClick={handleEnableRestrictive}
                  disabled={updateOrgMutation.isPending}
                >
                  Enable Security
                </Button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
