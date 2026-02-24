"use client";

import { DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD } from "@shared";
import { CopyButton } from "@/components/copy-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useDefaultCredentialsEnabled } from "@/lib/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";

export function DefaultCredentialsWarning({
  alwaysShow = false,
  showCopyButtons = true,
}: {
  alwaysShow?: boolean;
  showCopyButtons?: boolean;
}) {
  const { data: session } = authClient.useSession();
  const userEmail = session?.user?.email;
  const { data: defaultCredentialsEnabled, isLoading } =
    useDefaultCredentialsEnabled();

  // Loading state - don't show anything yet
  if (isLoading || defaultCredentialsEnabled === undefined) {
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

  return (
    <Alert variant="destructive" className="text-xs">
      <AlertTitle className="text-xs font-semibold">
        Default Admin Credentials Enabled
      </AlertTitle>
      <AlertDescription className="text-xs mt-1">
        <div className="space-y-1">
          {showCopyButtons ? (
            <>
              <div className="flex items-center gap-1">
                <code className="break-all">- {DEFAULT_ADMIN_EMAIL}</code>
                <CopyButton
                  text={DEFAULT_ADMIN_EMAIL}
                  className="h-4 w-4 hover:bg-transparent"
                  size={10}
                  behavior="text"
                />
              </div>
              <div className="flex items-center gap-1">
                <code className="break-all">- {DEFAULT_ADMIN_PASSWORD}</code>
                <CopyButton
                  text={DEFAULT_ADMIN_PASSWORD}
                  className="h-4 w-4 hover:bg-transparent"
                  size={10}
                  behavior="text"
                />
              </div>
            </>
          ) : (
            <>
              <code className="break-all block">- {DEFAULT_ADMIN_EMAIL}</code>
              <code className="break-all block">
                - {DEFAULT_ADMIN_PASSWORD}
              </code>
            </>
          )}
        </div>
        <p className="mt-1">
          <a
            href="https://archestra.ai/docs/platform-deployment#authentication--security"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center underline"
          >
            Set ENV
          </a>
          {alwaysShow ? (
            " to change"
          ) : (
            <>
              {" "}
              or{" "}
              <a
                href="/settings/account"
                className="inline-flex items-center underline"
              >
                Change
              </a>
            </>
          )}
        </p>
      </AlertDescription>
    </Alert>
  );
}
