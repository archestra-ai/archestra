"use client";

import { ShieldAlert } from "lucide-react";
import Link from "next/link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useFeatures } from "@/lib/features.query";

export function PermissivePolicyWarning() {
  const { data: features, isLoading } = useFeatures();

  if (isLoading || !features) {
    return null;
  }

  if (features.globalToolPolicy !== "permissive") {
    return null;
  }

  return (
    <div className="px-2 pb-2">
      <Alert variant="destructive" className="text-xs">
        <AlertTitle className="text-xs font-semibold">
          Agentic Security Disabled
        </AlertTitle>
        <AlertDescription className="text-xs mt-1 text-orange-600">
          <p>
            For demo purposes, the security engine is disabled. Agents could
            perform dangerous things without supervision, unless explicitly
            blocked.
          </p>
          <p className="mt-1 inline-flex items-center">
            <Link
              href="/settings/security"
              className="inline-flex items-center underline"
            >
              <ShieldAlert className="mr-1 flex-shrink-0" size={12} />
              Enable security in Settings
            </Link>
          </p>
        </AlertDescription>
      </Alert>
    </div>
  );
}
