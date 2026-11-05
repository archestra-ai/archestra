"use client";

import {
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_PASSWORD,
  DocsPage,
} from "@archestra/shared";
import { Info } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useDefaultCredentialsEnabled } from "@/lib/auth/auth.query";
import { usePublicIdentityProviders } from "@/lib/auth/identity-provider-read.query";
import { usePublicEnterpriseCoreActive } from "@/lib/config/config.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";

/**
 * The one note under the sign-in card. It says what an operator of a fresh
 * deployment needs to know: the default admin credentials while they still
 * work, and that single sign-on exists until an identity provider is
 * configured. Same box either way; only the wording changes.
 */
export function SignInNotice() {
  const { data: defaultCredentialsEnabled, isPending: isPendingCredentials } =
    useDefaultCredentialsEnabled();
  const enterpriseCoreActive = usePublicEnterpriseCoreActive();
  const {
    data: identityProviders,
    isSuccess: hasLoadedIdentityProviders,
    isPending: isPendingIdentityProviders,
  } = usePublicIdentityProviders();

  // Wait for everything the wording depends on, so the box arrives once in
  // its final form instead of changing its title as the queries answer.
  const isPending =
    isPendingCredentials ||
    enterpriseCoreActive === undefined ||
    (enterpriseCoreActive && isPendingIdentityProviders);
  if (isPending) {
    return null;
  }

  const showCredentials = defaultCredentialsEnabled === true;
  // Without the Enterprise core the provider query never runs, and there is
  // nothing it could find: no provider can be signed in with.
  const showSso =
    !enterpriseCoreActive ||
    (hasLoadedIdentityProviders && identityProviders.length === 0);

  if (!showCredentials && !showSso) {
    return null;
  }

  return (
    // A note, not an alert: nothing is wrong, and screen readers should not
    // interrupt sign-in to announce it.
    <Alert variant="info" role="note">
      <Info />
      <AlertTitle>
        {showCredentials ? "Default Credentials" : "Single Sign-On"}
      </AlertTitle>
      <AlertDescription className="gap-2">
        {showCredentials && <DefaultCredentials />}
        <HelpLinks changeCredentials={showCredentials} setUpSso={showSso} />
      </AlertDescription>
    </Alert>
  );
}

// ===

function DefaultCredentials() {
  return (
    <p>
      <span>By default, the email is </span>
      <Credential value={DEFAULT_ADMIN_EMAIL} />
      <span> and the password is </span>
      <Credential value={DEFAULT_ADMIN_PASSWORD} />
      <span>.</span>
    </p>
  );
}

function Credential({ value }: { value: string }) {
  return (
    <span className="inline-flex items-center gap-0.5 whitespace-nowrap">
      <code className="rounded bg-blue-100 px-1 font-mono text-xs dark:bg-blue-900/60">
        {value}
      </code>
      <CopyButton
        text={value}
        className="h-4 w-4 hover:bg-transparent disabled:opacity-100"
        size={10}
        // The icon turns into a check for a moment. A "Copied!" label would
        // push the rest of the sentence along while it shows.
        copiedIconClassName="text-green-600 dark:text-green-400"
      />
    </span>
  );
}

/**
 * Each link names its own destination. Full white-labeling hides links to the
 * vendor's docs, so every branch has a sentence that stands without them.
 */
function HelpLinks({
  changeCredentials,
  setUpSso,
}: {
  changeCredentials: boolean;
  setUpSso: boolean;
}) {
  const credentialsDocsUrl = getFrontendDocsUrl(
    DocsPage.PlatformDeployment,
    "authentication--security",
  );
  const ssoDocsUrl = getFrontendDocsUrl(DocsPage.PlatformEnterpriseManagedAuth);

  if (!credentialsDocsUrl || !ssoDocsUrl) {
    return (
      <p>
        {changeCredentials && (
          <span>
            Set the admin credential environment variables to change them.{" "}
          </span>
        )}
        {setUpSso && (
          <span>Admins can set up SSO in Settings → Identity Providers.</span>
        )}
      </p>
    );
  }

  if (changeCredentials && setUpSso) {
    return (
      <p>
        <span>Need to </span>
        <DocsLink href={credentialsDocsUrl}>change them</DocsLink>
        <span> or </span>
        <DocsLink href={ssoDocsUrl}>set up SSO</DocsLink>
        <span>?</span>
      </p>
    );
  }

  return (
    <p>
      <span>
        {changeCredentials ? "Need to change them? " : "Need to set up SSO? "}
      </span>
      <DocsLink href={changeCredentials ? credentialsDocsUrl : ssoDocsUrl}>
        Check the documentation
      </DocsLink>
      <span>.</span>
    </p>
  );
}

function DocsLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <ExternalDocsLink
      href={href}
      showIcon={false}
      className="text-inherit underline underline-offset-2"
    >
      {children}
    </ExternalDocsLink>
  );
}
