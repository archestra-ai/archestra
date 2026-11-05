"use client";

import { DocsPage } from "@archestra/shared";
import { KeyRound } from "lucide-react";
import { ExternalDocsLink } from "@/components/external-docs-link";
import {
  InlineNotice,
  InlineNoticeBody,
  InlineNoticeText,
} from "@/components/ui/inline-notice";
import { usePublicIdentityProviders } from "@/lib/auth/identity-provider-read.query";
import { usePublicEnterpriseCoreActive } from "@/lib/config/config.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";

/**
 * Tells whoever reaches the sign-in page of a deployment without single
 * sign-on that it exists and where to set it up. Gone as soon as one identity
 * provider is configured: the provider buttons on the card say it then.
 */
export function SsoSetupNote() {
  const enterpriseCoreActive = usePublicEnterpriseCoreActive();
  const { data: identityProviders, isSuccess } = usePublicIdentityProviders();
  // Null under full white-labeling, which hides links to the vendor's docs.
  const ssoDocsUrl = getFrontendDocsUrl(DocsPage.PlatformEnterpriseManagedAuth);

  // Without the Enterprise core the provider query never runs, and there is
  // nothing it could find: no provider can be signed in with.
  const hasNoIdentityProviders =
    enterpriseCoreActive === false ||
    (enterpriseCoreActive === true &&
      isSuccess &&
      identityProviders.length === 0);

  if (!hasNoIdentityProviders) {
    return null;
  }

  return (
    <InlineNotice variant="info">
      <KeyRound />
      <InlineNoticeBody>
        <span className="font-medium">Single sign-on</span>
        <InlineNoticeText>
          Admins can connect Okta, Microsoft Entra ID, Google, or any OIDC or
          SAML provider in Settings → Identity Providers.
        </InlineNoticeText>
      </InlineNoticeBody>
      {ssoDocsUrl && (
        <ExternalDocsLink
          href={ssoDocsUrl}
          className="ml-auto shrink-0 font-medium"
        >
          Set up SSO
        </ExternalDocsLink>
      )}
    </InlineNotice>
  );
}
