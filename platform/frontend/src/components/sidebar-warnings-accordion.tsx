"use client";

import { DEFAULT_ADMIN_EMAIL } from "@shared";
import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { DefaultCredentialsWarning } from "@/components/default-credentials-warning";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useDefaultCredentialsEnabled } from "@/lib/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useFeatures } from "@/lib/config.query";

export function SidebarWarningsAccordion() {
  const { data: session } = authClient.useSession();
  const userEmail = session?.user?.email;
  const { data: defaultCredentialsEnabled, isLoading: isLoadingCreds } =
    useDefaultCredentialsEnabled();
  const { data: features, isLoading: isLoadingFeatures } = useFeatures();

  const isPermissive = features?.globalToolPolicy === "permissive";

  // Determine which warnings should be shown (only for authenticated users)
  const showSecurityEngineWarning =
    !!session && !isLoadingFeatures && features !== undefined && isPermissive;
  const showDefaultCredsWarning =
    !isLoadingCreds &&
    defaultCredentialsEnabled !== undefined &&
    defaultCredentialsEnabled &&
    userEmail === DEFAULT_ADMIN_EMAIL;

  // Count active warnings
  const warningCount =
    (showSecurityEngineWarning ? 1 : 0) + (showDefaultCredsWarning ? 1 : 0);

  // Don't render anything if no warnings
  if (warningCount === 0) {
    return null;
  }

  return (
    <div className="px-2 pb-1">
      <Accordion type="single" collapsible defaultValue="warnings">
        <AccordionItem value="warnings" className="border-b-0">
          <AccordionTrigger className="py-2 text-xs font-medium text-destructive hover:no-underline">
            <span className="flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5" />
              {warningCount} security{" "}
              {warningCount === 1 ? "warning" : "warnings"}
            </span>
          </AccordionTrigger>
          <AccordionContent className="pb-0 pt-0 space-y-2">
            {showSecurityEngineWarning && (
              <Alert variant="destructive" className="text-xs">
                <AlertTitle className="text-xs font-semibold">
                  Security Engine Disabled
                </AlertTitle>
                <AlertDescription className="text-xs mt-1">
                  <p>
                    Agents can perform dangerous actions without supervision.
                  </p>
                  <p className="mt-1">
                    <Link
                      href="/tool-policies"
                      className="inline-flex items-center underline"
                    >
                      Go to Tools Settings
                    </Link>
                  </p>
                </AlertDescription>
              </Alert>
            )}
            {showDefaultCredsWarning && (
              <DefaultCredentialsWarning alwaysShow showCopyButtons={false} />
            )}
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
