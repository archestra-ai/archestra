"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { IdentityProviderIcon } from "@/components/identity-provider-icons.ee";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/clients/auth/auth-client";
import config from "@/lib/config";
import { usePublicIdentityProviders } from "@/lib/identity-provider.query.ee";
import { getValidatedCallbackURLWithDefault } from "@/lib/utils/redirect-validation";

interface IdentityProviderSelectorProps {
  /**
   * Whether to show the "Or continue with SSO" divider above the SSO buttons.
   * Set to false when basic auth is disabled and there's no form above.
   * Defaults to true.
   */
  showDivider?: boolean;
}

export function IdentityProviderSelector({
  showDivider = true,
}: IdentityProviderSelectorProps) {
  const searchParams = useSearchParams();
  const { data: identityProviders = [], isLoading } =
    usePublicIdentityProviders();

  // Get the redirectTo URL from search params, defaulting to "/"
  // Validates that the path is safe (relative path, no protocol) to prevent open redirect attacks
  const callbackURL = useMemo(() => {
    const redirectTo = searchParams.get("redirectTo");
    return getValidatedCallbackURLWithDefault(redirectTo);
  }, [searchParams]);

  const handleSsoSignIn = useCallback(
    async (providerId: string) => {
      try {
        await authClient.signIn.sso({
          providerId,
          callbackURL,
          /**
           * Use /auth/sign-in as the error callback base URL
           */
          errorCallbackURL: `${window.location.origin}/auth/sign-in`,
        });
      } catch {
        toast.error("Failed to initiate SSO sign-in");
      }
    },
    [callbackURL],
  );

  // Don't show SSO options if the enterprise license is not activated
  if (
    !config.enterpriseLicenseActivated ||
    isLoading ||
    identityProviders.length === 0
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
        {identityProviders.map((provider) => (
          <Button
            key={provider.id}
            variant="outline"
            className="w-full"
            onClick={() => handleSsoSignIn(provider.providerId)}
          >
            <IdentityProviderIcon
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
