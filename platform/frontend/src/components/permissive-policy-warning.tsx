"use client";

import { ShieldAlert } from "lucide-react";
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
          Permissive Policy Enabled
        </AlertTitle>
        <AlertDescription className="text-xs mt-1 text-orange-600">
          <p>All tool calls are allowed and results are trusted.</p>
          <p className="mt-1 inline-flex items-center">
            <a
              href="https://archestra.ai/docs/platform-deployment#environment-variables"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center underline"
            >
              <ShieldAlert className="mr-1 flex-shrink-0" size={12} />
              Change if not running locally!
            </a>
          </p>
        </AlertDescription>
      </Alert>
    </div>
  );
}
