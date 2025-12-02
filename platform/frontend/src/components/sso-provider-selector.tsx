"use client";

import { useCallback } from "react";
import { toast } from "sonner";
import { SsoProviderIcon } from "@/components/sso-provider-icons";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/clients/auth/auth-client";
import config from "@/lib/config";
import { usePublicSsoProviders } from "@/lib/sso-provider.query";

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
  const { data: ssoProviders = [], isLoading } = usePublicSsoProviders();

  const handleSsoSignIn = useCallback(async (providerId: string) => {
    try {
      const result = await authClient.signIn.sso({
        providerId,
        callbackURL: `${window.location.origin}/`,
        errorCallbackURL: `${window.location.origin}/sign-in`,
      });
      console.info("SSO sign-in initiated:", result);
    } catch (error) {
      console.error("SSO sign-in error:", error);
      toast.error("Failed to initiate SSO sign-in");
    }
  }, []);

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
