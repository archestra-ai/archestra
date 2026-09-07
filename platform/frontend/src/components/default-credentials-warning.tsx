"use client";

import {
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_PASSWORD,
  DocsPage,
} from "@archestra/shared";
import { AlertTriangle } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  useDefaultCredentialsEnabled,
  useSession,
} from "@/lib/auth/auth.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";

export function DefaultCredentialsWarning({
  alwaysShow = false,
  slim = false,
}: {
  alwaysShow?: boolean;
  slim?: boolean;
}) {
  const { data: session } = useSession();
  const userEmail = session?.user?.email;
  const { data: defaultCredentialsEnabled, isLoading } =
    useDefaultCredentialsEnabled();
  // Null under full white-labeling, which hides links to the vendor's docs.
  // Every branch below has to read as a finished sentence without them: the
  // link used to carry the verb ("Set ENV"), so hiding it left the warning
  // trailing off into "to change" and "or Change".
  const deploymentDocsUrl = getFrontendDocsUrl(
    DocsPage.PlatformDeployment,
    "authentication--security",
  );

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

  if (slim) {
    const fixUrl = getFrontendDocsUrl(
      DocsPage.PlatformDeployment,
      "authentication--security:~:text=ARCHESTRA_AUTH_ADMIN_EMAIL",
    );

    return (
      <div className="rounded-lg border bg-card px-3 py-1.5 text-xs text-destructive">
        <p className="flex items-center gap-1.5 whitespace-nowrap">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {fixUrl ? (
            <span>
              Default credentials
              {" - "}
              <ExternalDocsLink
                href={fixUrl}
                className="underline font-medium"
                showIcon={false}
              >
                Fix
              </ExternalDocsLink>
            </span>
          ) : (
            // Without the link the separator has nothing to introduce, so the
            // label stands alone rather than trailing a dangling dash.
            <span>Default credentials in use</span>
          )}
        </p>
      </div>
    );
  }

  return (
    <Alert variant="destructive" className="text-xs">
      <AlertTitle className="text-xs font-semibold">
        Default Admin Credentials Enabled
      </AlertTitle>
      <AlertDescription className="text-xs mt-1">
        <div className="space-y-1">
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
        </div>
        <p className="mt-1">
          {deploymentDocsUrl ? (
            <>
              <ExternalDocsLink
                href={deploymentDocsUrl}
                className="underline"
                showIcon={false}
              >
                Set ENV
              </ExternalDocsLink>
              {alwaysShow ? (
                <span>{" to change"}</span>
              ) : (
                <>
                  <span>{" or "}</span>
                  <a
                    href="/account?highlight=change-password"
                    className="underline"
                  >
                    Change
                  </a>
                </>
              )}
            </>
          ) : alwaysShow ? (
            // Nobody is signed in yet, so there is no account page to send
            // them to — say what has to happen instead of linking to it.
            <span>
              Set the admin credential environment variables to change
            </span>
          ) : (
            // Signed in, so the account page is the whole instruction.
            <a href="/account?highlight=change-password" className="underline">
              Change password
            </a>
          )}
        </p>
      </AlertDescription>
    </Alert>
  );
}
