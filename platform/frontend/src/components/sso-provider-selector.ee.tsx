"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { SsoProviderIcon } from "@/components/sso-provider-icons.ee";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/clients/auth/auth-client";
import config from "@/lib/config";
import { usePublicSsoProviders } from "@/lib/sso-provider.query.ee";

interface SsoProviderSelectorProps {
  /**
   * Whether to show the "Or continue with SSO" divider above the SSO buttons.
   * Set to false when basic auth is disabled and there's no form above.
   * Defaults to true.
   */
  showDivider?: boolean;
}

export function SsoProviderSelector({
  showDivider = true,
}: SsoProviderSelectorProps) {
  const searchParams = useSearchParams();
  const { data: ssoProviders = [], isLoading } = usePublicSsoProviders();

  // Get the redirectTo URL from search params, defaulting to "/"
  // Validates that the path is safe (relative path, no protocol) to prevent open redirect attacks
  const callbackURL = useMemo(() => {
    const redirectTo = searchParams.get("redirectTo");
    if (!redirectTo) {
      return `${window.location.origin}/`;
    }

    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(redirectTo);
    } catch {
      // Malformed URI encoding, fall back to home
      return `${window.location.origin}/`;
    }

    // Validate: must be relative path starting with single /, no protocol to prevent open redirects
    // Reject protocol-relative URLs (//evil.com) and URLs with protocols (https://evil.com)
    const isRelativePath =
      decodedPath.startsWith("/") &&
      !decodedPath.startsWith("//") &&
      !decodedPath.includes("://");

    return `${window.location.origin}${isRelativePath ? decodedPath : "/"}`;
  }, [searchParams]);

  const handleSsoSignIn = useCallback(
    async (providerId: string) => {
      try {
        const result = await authClient.signIn.sso({
          providerId,
          callbackURL,
          /**
           * Use /auth/sign-in as the error callback base URL
           */
          errorCallbackURL: `${window.location.origin}/auth/sign-in`,
        });
        console.info("SSO sign-in initiated:", result);
      } catch (error) {
        console.error("SSO sign-in error:", error);
        toast.error("Failed to initiate SSO sign-in");
      }
    },
    [callbackURL],
  );

  // Don't show SSO options if the enterprise license is not activated
  if (
    !config.enterpriseLicenseActivated ||
    isLoading ||
    ssoProviders.length === 0
  ) {
    return null;
  }

  return (
    <div className="space-y-4">
      {showDivider && (
        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-background px-2 text-muted-foreground">
              Or continue with SSO
            </span>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {ssoProviders.map((provider) => (
          <Button
            key={provider.id}
            variant="outline"
            className="w-full"
            onClick={() => handleSsoSignIn(provider.providerId)}
          >
            <SsoProviderIcon
              providerId={provider.providerId}
              className="mr-2"
            />
            Sign in with {provider.providerId}
          </Button>
        ))}
      </div>
    </div>
  );
}
