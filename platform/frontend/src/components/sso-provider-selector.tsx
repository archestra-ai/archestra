"use client";

import { Building2, Github, Globe, Shield } from "lucide-react";
import { useCallback } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useSsoProviders } from "@/lib/sso-provider.query";

export function SsoProviderSelector() {
  const { data: ssoProviders = [], isLoading } = useSsoProviders();

  // Get appropriate icon for provider
  const getProviderIcon = useCallback((providerId: string) => {
    const lowerProviderId = providerId.toLowerCase();
    if (lowerProviderId.includes("google")) {
      return Globe;
    }
    if (lowerProviderId.includes("okta")) {
      return Shield;
    }
    if (lowerProviderId.includes("github")) {
      return Github;
    }
    return Building2;
  }, []);

  const handleSsoSignIn = useCallback(async (providerId: string) => {
    try {
      const result = await authClient.signIn.sso({
        providerId,
        callbackURL: `${window.location.origin}/`,
        errorCallbackURL: `${window.location.origin}/sign-in`,
      });
      console.log("SSO sign-in initiated:", result);
    } catch (error) {
      console.error("SSO sign-in error:", error);
      toast.error("Failed to initiate SSO sign-in");
    }
  }, []);

  if (isLoading || ssoProviders.length === 0) {
    return null;
  }

  return (
    <div className="space-y-4">
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

      <div className="space-y-2">
        {ssoProviders.map((provider) => {
          const ProviderIcon = getProviderIcon(provider.providerId);
          return (
            <Button
              key={provider.id}
              variant="outline"
              className="w-full"
              onClick={() => handleSsoSignIn(provider.providerId)}
            >
              <ProviderIcon className="mr-2 h-4 w-4" />
              Sign in with {provider.providerId}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
