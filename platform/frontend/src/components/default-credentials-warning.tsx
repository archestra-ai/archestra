"use client";

import { DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD } from "@shared";
import { Link } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { authClient } from "@/lib/clients/auth/auth-client";

export function DefaultCredentialsWarning() {
  const { data: session } = authClient.useSession();
  const userEmail = session?.user?.email;

  if (!userEmail || userEmail !== DEFAULT_ADMIN_EMAIL) {
    return null;
  }

  return (
    <div className="px-2 pb-2">
      <Alert variant="destructive" className="text-xs">
        <AlertTitle className="text-xs font-semibold">
          Default Admin Credentials Enabled
        </AlertTitle>
        <AlertDescription className="text-xs mt-1">
          <p className="break-words">
            Archestra's default admin credentials are enabled:
            <br />
            <code className="inline-block break-all mx-0.5">
              - {DEFAULT_ADMIN_EMAIL}
            </code>
            <br />
            <code className="inline-block break-all mx-0.5">
              - {DEFAULT_ADMIN_PASSWORD}
            </code>
          </p>
          <p className="mt-1">
            <a
              href="https://www.archestra.ai/docs/platform-deployment#environment-variables"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center underline"
            >
              <Link className="mr-1 flex-shrink-0" size={12} />
              Change if not running locally!
            </a>
          </p>
        </AlertDescription>
      </Alert>
    </div>
  );
}
