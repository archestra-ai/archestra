"use client";

import { DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD } from "@shared";
import { Link } from "lucide-react";
import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { authClient } from "@/lib/clients/auth/auth-client";
import config from "@/lib/config";

export function DefaultCredentialsWarning({
  alwaysShow = false,
}: {
  alwaysShow?: boolean;
}) {
  const { data: session } = authClient.useSession();
  const userEmail = session?.user?.email;
  const [defaultCredentialsEnabled, setDefaultCredentialsEnabled] = useState<
    boolean | null
  >(null);

  useEffect(() => {
    // Fetch the default credentials status from the backend API
    fetch(`${config.api.baseUrl}/api/auth/default-credentials-status`)
      .then((res) => res.json())
      .then((data) => setDefaultCredentialsEnabled(data.enabled))
      .catch(() => setDefaultCredentialsEnabled(false));
  }, []);

  // Loading state - don't show anything yet
  if (defaultCredentialsEnabled === null) {
    return null;
  }

  // If default credentials are not enabled, don't show warning
  if (!defaultCredentialsEnabled) {
    return null;
  }

  // For authenticated users, only show if they're using the default admin email
  if (!alwaysShow && (!userEmail || userEmail !== DEFAULT_ADMIN_EMAIL)) {
    return null;
  }

  const alertContent = (
    <Alert variant="destructive" className="text-xs">
      <AlertTitle className="text-xs font-semibold">
        Default Admin Credentials Enabled
      </AlertTitle>
      <AlertDescription className="text-xs mt-1">
        <p className="break-words">
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
  );

  // For sign-in page, don't wrap with padding
  if (alwaysShow) {
    return alertContent;
  }

  // For sidebar, keep the padding
  return <div className="px-2 pb-2">{alertContent}</div>;
}
