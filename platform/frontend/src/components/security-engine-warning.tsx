"use client";

import Link from "next/link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useFeatures } from "@/lib/features.query";

export function SecurityEngineWarning() {
  const { data: features, isLoading } = useFeatures();
  const isPermissive = features?.globalToolPolicy === "permissive";

  // Loading state - don't show anything yet
  if (isLoading || features === undefined) {
    return null;
  }

  // If security engine is not disabled, don't show warning
  if (!isPermissive) {
    return null;
  }

  return (
    <div className="px-2 pb-1">
      <Alert variant="destructive" className="text-xs">
        <AlertTitle className="text-xs font-semibold">
          Security Engine Disabled
        </AlertTitle>
        <AlertDescription className="text-xs mt-1">
          <p>Agents can perform dangerous actions without supervision.</p>
          <p className="mt-1">
            <Link href="/tools" className="inline-flex items-center underline">
              Go to Tools Settings
            </Link>
          </p>
        </AlertDescription>
      </Alert>
    </div>
  );
}
